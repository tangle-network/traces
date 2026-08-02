/**
 * The GENERAL run-tree source: reconstruct a run's shape from OTLP spans alone.
 *
 * `supervisor-run-context.ts` is the specific source — agent-runtime's durable
 * spawn journal, which carries the exact authored budget, settled spend, and
 * settlement status that telemetry does not. This file is the one that works
 * for emitters nobody has written yet: anything that emits spans carrying
 * `trace_id` / `span_id` / `parent_span_id` gets a tree, because the parent
 * pointer IS the tree. A supervisor, a pi session, a Claude subagent fan-out,
 * and a custom fanout all reach the same view through the same three fields.
 *
 * ## Nothing here is a second exporter or a second attribute vocabulary
 *
 * Spans are read with this repo's existing `exportTraceEvidenceFile`, which
 * already detects OpenInference / intelligence-span / sandbox-event files,
 * normalizes them onto `OtlpSpan`, redacts, and validates. Every attribute is
 * read through `@tangle-network/agent-eval/trace-attributes` alias lists
 * (`LLM_INPUT_TOKEN_ATTR_KEYS`, `LLM_COST_ATTR_KEYS`, `SPAN_KIND_ATTR_KEYS`, …),
 * which already cover both live vocabularies — OpenInference's
 * `llm.token_count.*` and GenAI semconv's `gen_ai.usage.*`. No key is invented
 * here, so a span this repo can already read is a span this view can already
 * place.
 *
 * ## What a span tree can and cannot say
 *
 * It can say the shape, the wall time, the tokens, and — when the emitter
 * priced them — the dollars. It CANNOT say the authored budget: neither
 * vocabulary carries a spawn's ceiling, so budget is reported as absent, never
 * as 0. That gap is exactly why the journal source exists and why, when both
 * are present, the journal's numbers win.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  firstNumberAttr,
  LLM_COST_ATTR_KEYS,
  LLM_INPUT_TOKEN_ATTR_KEYS,
  LLM_OUTPUT_TOKEN_ATTR_KEYS,
  SPAN_KIND_ATTR_KEYS,
} from '@tangle-network/agent-eval/trace-attributes'
import { exportTraceEvidenceFile } from './file-export.js'
import type { OtlpSpan } from './otlp.js'
import { connectors, forEachTreeNode, int, ms, tokens, usd } from './run-view-format.js'
import type { SpendRoll } from './supervisor-run-context.js'
import { addSpend, mergeRolls, ZERO_ROLL } from './supervisor-run-context.js'

/**
 * Agent-identity keys, in the order a reader should trust them. These are the
 * keys this repo's own emitter writes (`agent.name`, `inference.agent_name`)
 * plus GenAI semconv's (`gen_ai.agent.name`) — the same pairing every other
 * alias list in `trace-attributes` uses. agent-eval publishes no agent-name
 * alias list to import, so the list is stated once, here.
 */
const AGENT_NAME_ATTR_KEYS = ['agent.name', 'inference.agent_name', 'gen_ai.agent.name'] as const
const SERVICE_NAME_ATTR_KEYS = ['service.name', 'tangle.runtime'] as const

/**
 * GenAI's operation names for an agent boundary. `invoke_agent` is one agent
 * turn; `invoke_workflow` is a driver that fans out. agent-runtime's
 * `buildLoopSpanNodes` emits both.
 */
const AGENT_OPERATIONS = new Set(['invoke_agent', 'invoke_workflow'])
const OPERATION_ATTR_KEY = 'gen_ai.operation.name'

function firstStringAttr(
  attributes: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

export type SpanNodeStatus = 'running' | 'done' | 'failed'

export interface SpanRunNode {
  readonly traceId: string
  readonly spanId: string
  /** The enclosing NODE's span id — not necessarily the raw parent span. */
  readonly parentNodeId: string | null
  readonly label: string
  readonly depth: number
  /**
   * `driver` when this node has nested agent nodes below it, `leaf` otherwise.
   * Spans carry no spawn relationship, so delegation is read from the tree
   * itself — the only fact the telemetry actually states.
   */
  readonly role: 'driver' | 'leaf'
  readonly status: SpanNodeStatus
  /** `service.name` — which harness or runtime emitted this subtree. */
  readonly runtime: string | null
  /** This node's OWN inference: the LLM spans it emitted directly. */
  readonly driver: SpendRoll
  /** What its nested agent nodes consumed, whole subtrees included. */
  readonly children: SpendRoll
  /** Tool spans attributed to this node directly. */
  readonly toolCalls: number
  readonly startMs: number
  readonly endMs: number
  readonly wallMs: number
  /** Span status messages on this node or its non-node descendants. */
  readonly errors: readonly string[]
}

export interface SpanRunSnapshot {
  readonly source: string
  readonly present: boolean
  /** Depth-first, parents before children, one subtree per trace. */
  readonly nodes: readonly SpanRunNode[]
  readonly maxDepth: number
  readonly traceIds: readonly string[]
  readonly spanCount: number
  readonly startMs: number | null
  readonly endMs: number | null
  /** LLM spans that recorded no token count at all — a gap, not a zero. */
  readonly llmSpansWithoutTokens: number
  /** LLM spans that recorded no cost at all — a gap, not $0. */
  readonly llmSpansWithoutCost: number
  /** Spans whose `parent_span_id` names a span not in the file. */
  readonly orphanSpans: number
  /** Why the file could not be read, when it could not. */
  readonly readError: string | null
}

export const EMPTY_SPAN_RUN_SNAPSHOT: Omit<SpanRunSnapshot, 'source'> = {
  present: false,
  nodes: [],
  maxDepth: 0,
  traceIds: [],
  spanCount: 0,
  startMs: null,
  endMs: null,
  llmSpansWithoutTokens: 0,
  llmSpansWithoutCost: 0,
  orphanSpans: 0,
  readError: null,
}

function spanKind(span: OtlpSpan): string | null {
  return firstStringAttr(span.attributes, SPAN_KIND_ATTR_KEYS)
}

/**
 * Is this span an agent boundary — the start of a new node?
 *
 * Five signals, every one of them a key some real emitter already writes:
 * the trace root; a span with nothing enclosing it; an OpenInference `AGENT`
 * span; a GenAI `invoke_agent` / `invoke_workflow` operation; or a span whose
 * agent name differs from the agent name of the node enclosing it. The last
 * rule is what places a Claude subagent, which this repo folds in under the
 * spawning tool span WITHOUT a span of kind AGENT — only a changed `agent.name`
 * marks the handover.
 *
 * The second rule is load-bearing rather than defensive: a span whose declared
 * parent is absent from the batch has no node to roll into, and a span that
 * rolls into no node has its tokens and dollars silently dropped. Re-rooting it
 * as its own node keeps that spend visible and counted.
 */
function isNodeBoundary(
  span: OtlpSpan,
  enclosingNodeId: string | null,
  enclosingAgent: string | null,
): boolean {
  if (span.parent_span_id === null || enclosingNodeId === null) return true
  if (spanKind(span) === 'AGENT') return true
  if (AGENT_OPERATIONS.has(String(span.attributes[OPERATION_ATTR_KEY] ?? ''))) return true
  const agent = firstStringAttr(span.attributes, AGENT_NAME_ATTR_KEYS)
  return agent !== null && enclosingAgent !== null && agent !== enclosingAgent
}

/**
 * One span's spend, in agent-runtime's own `Spend` shape so it rolls through
 * the SAME `addSpend` the journal path uses. `usdKnown:false` when the emitter
 * recorded no cost attribute at all — which is a missing measurement, not a
 * free call, and is the single most important thing this file gets right.
 */
function spanSpend(span: OtlpSpan): Parameters<typeof addSpend>[1] {
  const cost = firstNumberAttr(span.attributes, LLM_COST_ATTR_KEYS)
  return {
    iterations: 0,
    tokens: {
      input: firstNumberAttr(span.attributes, LLM_INPUT_TOKEN_ATTR_KEYS) ?? 0,
      output: firstNumberAttr(span.attributes, LLM_OUTPUT_TOKEN_ATTR_KEYS) ?? 0,
    },
    usd: cost ?? 0,
    ...(cost === null ? { usdKnown: false as const } : {}),
    ms: 0,
  }
}

function epoch(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

interface Building {
  readonly span: OtlpSpan
  readonly parentNodeId: string | null
  readonly depth: number
  readonly agent: string | null
  driver: SpendRoll
  toolCalls: number
  startMs: number
  endMs: number
  readonly errors: string[]
  readonly childNodeIds: string[]
}

/**
 * Fold a flat span batch into the node tree. Pure, so the same spans always
 * render the same text — which is what lets the live tail print only on change.
 */
export function buildSpanRunTree(spans: readonly OtlpSpan[], source: string): SpanRunSnapshot {
  if (spans.length === 0) return { ...EMPTY_SPAN_RUN_SNAPSHOT, source }

  const byId = new Map<string, OtlpSpan>()
  for (const span of spans) byId.set(spanKey(span), span)

  const childrenOf = new Map<string | null, OtlpSpan[]>()
  let orphanSpans = 0
  for (const span of spans) {
    const parentKey =
      span.parent_span_id === null
        ? null
        : byId.has(`${span.trace_id}\x00${span.parent_span_id}`)
          ? `${span.trace_id}\x00${span.parent_span_id}`
          : null
    // A span whose parent is absent is still real work; re-root it rather than
    // drop it, and say how many were re-rooted.
    if (span.parent_span_id !== null && parentKey === null) orphanSpans += 1
    const bucket = childrenOf.get(parentKey)
    if (bucket) bucket.push(span)
    else childrenOf.set(parentKey, [span])
  }
  for (const bucket of childrenOf.values()) {
    bucket.sort((a, b) => epoch(a.start_time) - epoch(b.start_time) || a.span_id.localeCompare(b.span_id))
  }

  const building = new Map<string, Building>()
  const order: string[] = []
  let llmSpansWithoutTokens = 0
  let llmSpansWithoutCost = 0

  /**
   * Walk the raw span tree, carrying the node each span belongs to. A boundary
   * span opens a node; every other span rolls into the node enclosing it.
   */
  const walk = (
    span: OtlpSpan,
    enclosingNodeId: string | null,
    enclosingAgent: string | null,
    depth: number,
  ): void => {
    const key = spanKey(span)
    const agent = firstStringAttr(span.attributes, AGENT_NAME_ATTR_KEYS) ?? enclosingAgent
    let nodeId = enclosingNodeId
    let nodeAgent = enclosingAgent
    let childDepth = depth

    if (isNodeBoundary(span, enclosingNodeId, enclosingAgent)) {
      const node: Building = {
        span,
        parentNodeId: enclosingNodeId,
        depth,
        agent,
        driver: ZERO_ROLL,
        toolCalls: 0,
        startMs: epoch(span.start_time),
        endMs: epoch(span.end_time),
        errors: [],
        childNodeIds: [],
      }
      building.set(key, node)
      order.push(key)
      if (enclosingNodeId !== null) building.get(enclosingNodeId)?.childNodeIds.push(key)
      nodeId = key
      nodeAgent = agent
      childDepth = depth + 1
    }

    const host = nodeId === null ? undefined : building.get(nodeId)
    if (host !== undefined) {
      const kind = spanKind(span)
      if (kind === 'LLM') {
        host.driver = addSpend(host.driver, spanSpend(span))
        if (firstNumberAttr(span.attributes, LLM_INPUT_TOKEN_ATTR_KEYS) === null &&
          firstNumberAttr(span.attributes, LLM_OUTPUT_TOKEN_ATTR_KEYS) === null) {
          llmSpansWithoutTokens += 1
        }
        if (firstNumberAttr(span.attributes, LLM_COST_ATTR_KEYS) === null) llmSpansWithoutCost += 1
      } else if (kind === 'TOOL') host.toolCalls += 1
      host.startMs = Math.min(host.startMs, epoch(span.start_time))
      host.endMs = Math.max(host.endMs, epoch(span.end_time))
      if (span.status.code === 'ERROR') {
        host.errors.push(`${span.name}: ${span.status.message ?? 'ERROR'}`)
      }
    }

    for (const child of childrenOf.get(key) ?? []) walk(child, nodeId, nodeAgent, childDepth)
  }

  for (const root of childrenOf.get(null) ?? []) walk(root, null, null, 0)

  // Child totals roll UP whole subtrees, so a driver's own turns and the work
  // it delegated are never summed into one figure the reader cannot split.
  const subtotal = new Map<string, SpendRoll>()
  const subtotalOf = (key: string): SpendRoll => {
    const cached = subtotal.get(key)
    if (cached !== undefined) return cached
    const node = building.get(key)
    if (node === undefined) return ZERO_ROLL
    subtotal.set(key, ZERO_ROLL) // cycle guard: a self-parented span cannot recurse forever
    let total = node.driver
    for (const child of node.childNodeIds) total = mergeRolls(total, subtotalOf(child))
    subtotal.set(key, total)
    return total
  }

  const nodes: SpanRunNode[] = order.map((key) => {
    const node = building.get(key)!
    let children = ZERO_ROLL
    for (const child of node.childNodeIds) children = mergeRolls(children, subtotalOf(child))
    return {
      traceId: node.span.trace_id,
      spanId: node.span.span_id,
      parentNodeId: node.parentNodeId === null ? null : building.get(node.parentNodeId)!.span.span_id,
      label: node.agent ?? node.span.name,
      depth: node.depth,
      role: node.childNodeIds.length > 0 ? 'driver' : 'leaf',
      status:
        node.errors.length > 0 || node.span.status.code === 'ERROR'
          ? 'failed'
          : node.span.status.code === 'UNSET'
            ? 'running'
            : 'done',
      runtime: firstStringAttr(node.span.attributes, SERVICE_NAME_ATTR_KEYS),
      driver: node.driver,
      children,
      toolCalls: node.toolCalls,
      startMs: node.startMs,
      endMs: node.endMs,
      wallMs: Math.max(0, node.endMs - node.startMs),
      errors: node.errors,
    }
  })

  return {
    source,
    present: true,
    nodes,
    maxDepth: nodes.reduce((max, n) => Math.max(max, n.depth), 0),
    traceIds: [...new Set(spans.map((s) => s.trace_id))],
    spanCount: spans.length,
    startMs: nodes.reduce<number | null>((min, n) => (min === null ? n.startMs : Math.min(min, n.startMs)), null),
    endMs: nodes.reduce<number | null>((max, n) => (max === null ? n.endMs : Math.max(max, n.endMs)), null),
    llmSpansWithoutTokens,
    llmSpansWithoutCost,
    orphanSpans,
    readError: null,
  }
}

function spanKey(span: OtlpSpan): string {
  return `${span.trace_id}\x00${span.span_id}`
}

/**
 * Read one span file into a snapshot. Never throws: a tail that catches the
 * writer mid-line, or an empty file the emitter has not filled yet, is a state
 * to display, not a crash.
 */
export async function readSpanRunSnapshot(path: string): Promise<SpanRunSnapshot> {
  try {
    const exported = await exportTraceEvidenceFile(path)
    return buildSpanRunTree(exported.spans, path)
  } catch (error) {
    return {
      ...EMPTY_SPAN_RUN_SNAPSHOT,
      source: path,
      readError: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * The two run-level halves of a span tree, each counted exactly once: the
 * inference emitted by nodes that DELEGATED, and the inference emitted by the
 * leaves they delegated to. Every LLM span lands in exactly one half, so the
 * two add up to the run and neither hides inside the other.
 */
export function spanRunTotals(snapshot: SpanRunSnapshot): { driver: SpendRoll; leaves: SpendRoll } {
  let driver = ZERO_ROLL
  let leaves = ZERO_ROLL
  for (const node of snapshot.nodes) {
    if (node.role === 'driver') driver = mergeRolls(driver, node.driver)
    else leaves = mergeRolls(leaves, node.driver)
  }
  return { driver, leaves }
}

/** The rendered view for one span snapshot. Pure. */
export function renderSpanRunSnapshot(snapshot: SpanRunSnapshot): string {
  const lines: string[] = []
  lines.push(`spans ${snapshot.source}`)
  if (snapshot.readError !== null) {
    lines.push(`  unreadable: ${snapshot.readError}`)
    return lines.join('\n')
  }
  if (!snapshot.present || snapshot.nodes.length === 0) {
    lines.push('  no spans yet — the emitter has written nothing this view can place')
    return lines.join('\n')
  }
  const totals = spanRunTotals(snapshot)
  lines.push(
    `  ${snapshot.nodes.length} node(s) · depth ${snapshot.maxDepth} · ` +
      `${int(snapshot.spanCount)} span(s) · ${snapshot.traceIds.length} trace(s) · ` +
      `elapsed ${ms(snapshot.endMs === null || snapshot.startMs === null ? null : snapshot.endMs - snapshot.startMs)}`,
  )
  const delegating = snapshot.nodes.some((node) => node.role === 'driver')
  lines.push(`  driver inference  ${tokens(totals.driver)} · ${usd(totals.driver)}`)
  lines.push(`  leaf inference    ${tokens(totals.leaves)} · ${usd(totals.leaves)}`)
  if (!delegating) {
    lines.push('  (no delegation in these spans: every turn belongs to one agent, so the driver half is empty)')
  }
  lines.push('')

  forEachTreeNode(
    snapshot.nodes,
    (n) => n.parentNodeId,
    (n) => n.spanId,
    (node, lastAtDepth) => {
      const { head: prefix, detail } = connectors(node.depth, lastAtDepth)
      const mark = node.status === 'failed' ? '✗' : node.status === 'running' ? '▶' : '✓'
      lines.push(
        [
          `${prefix}${mark} ${node.label}`,
          `[${node.status}]`,
          node.role,
          node.runtime ?? 'no-runtime',
          'budget not in spans',
          `wall ${ms(node.wallMs)}`,
        ].join('  '),
      )
      lines.push(
        `${detail}driver    ${node.driver.records} turn(s) · ${tokens(node.driver)} · ${usd(node.driver)} · ${node.toolCalls} tool call(s)`,
      )
      if (node.role === 'driver') {
        lines.push(
          `${detail}children  ${node.children.records} turn(s) · ${tokens(node.children)} · ${usd(node.children)}`,
        )
      }
      for (const error of node.errors.slice(0, 3)) lines.push(`${detail}error ${error}`)
    },
  )

  const problems: string[] = []
  if (snapshot.llmSpansWithoutCost > 0) {
    problems.push(
      `${snapshot.llmSpansWithoutCost} of the LLM span(s) carry no cost attribute — that spend is UNKNOWN, not $0 ` +
        `(this emitter writes tokens without a price)`,
    )
  }
  if (snapshot.llmSpansWithoutTokens > 0) {
    problems.push(`${snapshot.llmSpansWithoutTokens} LLM span(s) carry no token count`)
  }
  if (snapshot.orphanSpans > 0) {
    problems.push(
      `${snapshot.orphanSpans} span(s) name a parent_span_id absent from this file — re-rooted, not dropped`,
    )
  }
  problems.push(
    'spans carry no authored budget in either the OpenInference or the GenAI vocabulary; ' +
      'point this at a run directory with a spawn journal to see ceilings and settlement',
  )
  lines.push('')
  for (const problem of problems) lines.push(`  ! ${problem}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Finding span files.
// ---------------------------------------------------------------------------

/**
 * Filenames a directory scan will pick up as a span batch. This is DISCOVERY
 * only: a file the caller names explicitly is read whatever it is called.
 */
const SPAN_FILE_PATTERN =
  /\.(?:otlp|spans|traces|openinference)\.(?:jsonl|ndjson)$|^traces?\.jsonl$|^spans\.jsonl$/i

/**
 * Span files at or immediately under `dir`. One level only, matching how the
 * journal source resolves a run directory: a run is the unit a caller names.
 */
export async function findSpanSourceFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const child = join(dir, entry.name)
    if (entry.isFile()) {
      if (SPAN_FILE_PATTERN.test(entry.name)) found.push(child)
      continue
    }
    if (!entry.isDirectory()) continue
    const nested = await readdir(child, { withFileTypes: true }).catch(() => [])
    for (const inner of nested) {
      if (inner.isFile() && SPAN_FILE_PATTERN.test(inner.name)) found.push(join(child, inner.name))
    }
  }
  return found.sort()
}
