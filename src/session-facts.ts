/**
 * The deterministic session-facts sheet.
 *
 * A handful of facts about a session decide most audit questions — how many
 * tools ran, which subagents were spawned, which pull requests were opened and
 * merged, what the human actually typed, what the agent said last, which files
 * changed, when the session started and ended, and how many tokens it burned.
 * Every one of them is already carried by the normalized
 * spans, but no trace tool returns any of them: `viewTrace` degrades to a
 * 20-entry name histogram above its byte ceiling, `countTraces` counts traces
 * rather than spans, `viewSpans` needs span ids the reader does not have, and
 * `searchTrace` stops at 500 hits. A model asked for a tool-call total therefore
 * adds up a capped histogram and decides by eye which names count.
 *
 * This module computes those facts mechanically instead. No model call, no
 * budget, no byte ceiling: it reads the spans directly, so a session far above
 * the tool ceiling still yields exact numbers.
 *
 * Two rules make the sheet auditable:
 *
 *   1. Every field carries the span ids it was computed from, so a reader can
 *      open those spans and check the number.
 *   2. A field the spans cannot support is `null` with a stated `unavailable`
 *      reason. It is never guessed, and never silently zero. A value the sheet
 *      filtered — a `user.prompt` turn that is not a human turn of this session
 *      — is reported beside the count with the reason, never silently dropped.
 *
 * The sheet is NOT a span and cannot be cited. It is prepared context, and
 * `trace://` citations still resolve against the raw spans — which is why every
 * fact names its span ids rather than asking the reader to trust the sheet.
 */

import type { TraceAnalystDefinition } from '@tangle-network/agent-eval/analyst'
import { OPENINFERENCE_SPAN_KIND, TOOL_NAME } from '@tangle-network/agent-eval/trace-attributes'
import { ACTOR_ATTR } from './adapters/conversation.js'
import {
  INHERITED_SOURCE_ATTR,
  INHERITED_SPAN_ATTR,
  isSynthesizedSpan as isSynthesizedByProvenance,
} from './adapters/provenance.js'
import { indexSessionIdsByTrace } from './attributes.js'
import type { OtlpSpan } from './otlp.js'
import { readPullRequests, type PullRequestFacts } from './pull-request-facts.js'

/**
 * The cumulative harness token total for a whole session, when the adapter
 * records one. Codex's `token_count` events carry
 * `info.total_token_usage.total_tokens`; the adapter uses that object only as a
 * de-duplication signature today, so no span carries the value and
 * {@link SessionFacts.tokenTotal} states that rather than summing the per-turn
 * deltas, which is a different (and smaller) number.
 */
export const SESSION_TOKEN_TOTAL_ATTR = 'traces.session.total_tokens'

/**
 * The first marker an adapter used for a span it created to describe a
 * lifecycle rather than an invocation the agent made. The current marker is
 * `traces.span.synthesized` (see `adapters/provenance.ts`); this one is still
 * recognized so a trace exported before the rename keeps counting correctly.
 */
export const SPAN_SYNTHESIZED_ATTR = 'traces.codex.span_synthesized'

/** Records the session reader could not parse, stamped on the session span. */
const CORRUPTION_COUNT_ATTR = 'traces.session.corruption_count'

/** Present on a per-record integrity receipt span, which is not a session record. */
const CORRUPTION_RECEIPT_VERSION_ATTR = 'traces.session.corruption.receipt_version'

/** Max characters of message or prompt text kept per fact entry. */
export const FACT_TEXT_CAP = 2000

/** Entries kept per list field before the sheet reports the rest as omitted. */
export const FACT_LIST_CAP = 200

/**
 * One measured fact. `value` is `null` exactly when `unavailable` explains why
 * the spans cannot support it; `spanIds` names the spans the value came from,
 * in the order they appear in the trace.
 */
export interface SessionFact<T> {
  readonly value: T | null
  readonly spanIds: readonly string[]
  /** Why `value` is null. Null when the fact was measured. */
  readonly unavailable: string | null
  /** A measured value that is known to be incomplete says so here. */
  readonly partial?: string
}

/** One `spawn_agent` call, with the task name the adapter recorded for it. */
export interface SubagentSpawnFact {
  /** `traces.codex.spawn_agent_path`, verbatim. Null when the span carries none. */
  readonly taskName: string | null
  /** Why `taskName` is null. Null when it was recorded. */
  readonly taskNameUnavailable: string | null
  readonly startedAt: string
  /** The spawn span's status: `OK`, `ERROR`, or `UNSET` while still open. */
  readonly status: string
  /** The spawn call span, plus the subagent lifecycle span when one joined it. */
  readonly spanIds: readonly string[]
}

/** One `user.prompt` turn, with the actor the adapter classified it as. */
export interface SessionTurnFact {
  readonly actor: string
  readonly at: string
  readonly text: string
  readonly spanId: string
}

/** How many `user.prompt` turns each actor produced. */
export interface TurnActorCount {
  readonly actor: string
  readonly turns: number
  readonly spanIds: readonly string[]
}

/**
 * `user.prompt` turns {@link SessionFacts.humanTurns} did not count, grouped by
 * the reason they were not counted. Nothing is dropped silently: every excluded
 * span is named here, so a reader who disagrees with a reason can open the span
 * and count it back in.
 */
export interface ExcludedTurnFact {
  readonly reason: string
  readonly turns: number
  readonly spanIds: readonly string[]
}

/** The last thing one agent said, for the main session or for one subagent. */
export interface FinalMessageFact {
  /**
   * The subagent's task path, or null for the session's own agent. One session
   * interleaves its own `message.assistant` spans with the `message.agent.*`
   * traffic of every subagent under the same root, so "the final message" is
   * only well defined per task.
   */
  readonly task: string | null
  readonly at: string
  readonly text: string
  readonly spanId: string
}

/** One path a tool call changed, and how. */
export interface ChangedFileFact {
  readonly path: string
  /**
   * `add`, `update`, `delete`, or `move`, in the order first observed. A kind a
   * harness reports under another name is kept verbatim rather than mapped.
   */
  readonly operations: readonly string[]
  readonly spanIds: readonly string[]
}

/** Everything the spans of one session state, computed without a model. */
export interface SessionFacts {
  readonly schemaVersion: 1
  readonly kind: 'traces.session_facts'
  readonly traceId: string
  readonly sessionId: string | null
  readonly harness: string | null
  /** Spans in this trace, including the synthesized ones. */
  readonly spanCount: number
  /**
   * Spans the adapter built from the session's own records. The session root
   * and the integrity receipts are not among them, so zero means nothing in the
   * file was read and every count below would be an unsupported zero.
   */
  readonly recordSpans: number
  /** Records the adapter could not read, from the session's integrity receipt. */
  readonly unreadRecords: SessionFact<number>
  /** TOOL spans the agent actually invoked: synthesized lifecycle spans excluded. */
  readonly toolCalls: SessionFact<number>
  /** Every synthesized span excluded from `toolCalls`, so the exclusion is checkable. */
  readonly synthesizedToolSpans: SessionFact<number>
  /** Tool-call counts by tool name, over the same spans `toolCalls` counted. */
  readonly toolCallsByName: SessionFact<Readonly<Record<string, number>>>
  readonly subagents: SessionFact<readonly SubagentSpawnFact[]>
  /** Pull requests this session created and merged, each with its evidence. */
  readonly pullRequests: SessionFact<PullRequestFacts>
  /** `user.prompt` turns a person typed into THIS session, in order. */
  readonly humanTurns: SessionFact<readonly SessionTurnFact[]>
  /** Every `user.prompt` turn `humanTurns` left out, with the reason. */
  readonly excludedTurns: SessionFact<readonly ExcludedTurnFact[]>
  /** Every `user.prompt` turn by actor, so the human filter is checkable. */
  readonly turnsByActor: SessionFact<readonly TurnActorCount[]>
  /** The last message of the session's own agent, and of each subagent task. */
  readonly finalMessages: SessionFact<readonly FinalMessageFact[]>
  readonly changedFiles: SessionFact<readonly ChangedFileFact[]>
  /** Earliest span start in the trace. Not the session file's first record when
   *  the adapter selected a task boundary inside the file. */
  readonly firstRecordAt: SessionFact<string>
  /** Latest span end in the trace. */
  readonly lastRecordAt: SessionFact<string>
  /** The harness's own cumulative token total, when a span carries it. */
  readonly tokenTotal: SessionFact<number>
}

export interface SessionFactsReport {
  readonly schemaVersion: 1
  readonly kind: 'traces.session_facts_report'
  readonly generatedAt: string
  readonly harness: string | null
  readonly spanCount: number
  readonly sessions: readonly SessionFacts[]
}

function attr(span: OtlpSpan, key: string): unknown {
  return span.attributes[key]
}

function stringAttr(span: OtlpSpan, key: string): string | null {
  const value = span.attributes[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function capText(raw: string): string {
  const text = raw.trim()
  if (text.length <= FACT_TEXT_CAP) return text
  return `${text.slice(0, FACT_TEXT_CAP)}… [+${text.length - FACT_TEXT_CAP} chars]`
}

/** Trace order: the adapter's `step` when it recorded one, else start time. */
function orderOf(span: OtlpSpan): [number, number] {
  const step = span.attributes.step
  const start = Date.parse(span.start_time)
  return [typeof step === 'number' ? step : Number.MAX_SAFE_INTEGER, Number.isFinite(start) ? start : 0]
}

function byTraceOrder(left: OtlpSpan, right: OtlpSpan): number {
  const [leftStep, leftStart] = orderOf(left)
  const [rightStep, rightStart] = orderOf(right)
  if (leftStart !== rightStart) return leftStart - rightStart
  return leftStep - rightStep
}

/**
 * A span an adapter created to describe a subagent's lifecycle rather than to
 * record a call the agent made. Codex's `ensureSubagentSpan` emits one such
 * span per subagent thread with `kind: TOOL` and `tool.name: Agent`, so any
 * span-kind count is high by exactly the number of subagents unless it is
 * excluded. Two signatures identify it: the explicit tag an adapter may set,
 * and the subagent thread/path attribute pair only that span carries.
 */
export function isSynthesizedSpan(span: OtlpSpan): boolean {
  if (isSynthesizedByProvenance(span.attributes)) return true
  if (attr(span, SPAN_SYNTHESIZED_ATTR) === true) return true
  return (
    stringAttr(span, 'traces.codex.subagent_thread_id') !== null &&
    stringAttr(span, 'traces.codex.subagent_path') !== null
  )
}

function isToolSpan(span: OtlpSpan): boolean {
  return attr(span, OPENINFERENCE_SPAN_KIND) === 'TOOL'
}

function toolName(span: OtlpSpan): string {
  return stringAttr(span, TOOL_NAME) ?? span.name.replace(/^tool\./, '')
}

function inputValue(span: OtlpSpan): string | null {
  const value = span.attributes['input.value']
  return typeof value === 'string' ? value : null
}

function inputTruncated(span: OtlpSpan): boolean {
  return span.attributes['traces.input.truncated'] === true
}

// The fallback source: `apply_patch` envelopes name every path they touch in a
// header line, and the adapter keeps the patch verbatim in `input.value`, so
// the headers survive unless the value exceeded the adapter's own 16 KiB I/O
// cap. A header is the text the caller wrote, not a path the harness resolved,
// so it is read only for edits no `file.change` span already states.
//
// The patch reaches the span either as raw text or as a JSON-encoded tool
// argument, where the line breaks are the two characters `\` and `n`. The
// header therefore ends at a real newline, at the backslash of an escape, or at
// the closing quote — which is also why a path containing `"` or `\` is not
// recovered, and is reported as a missing path rather than a wrong one.
const PATCH_HEADER = /\*\*\* (Add|Update|Delete|Move to) File: ([^\n"\\]+)/g
const PATCH_OPERATION: Readonly<Record<string, string>> = {
  Add: 'add',
  Update: 'update',
  Delete: 'delete',
  'Move to': 'move',
}

/**
 * A span the harness wrote for one path its own patch machinery changed.
 *
 * Codex's adapter emits one `file.change` span per changed path from the
 * `FileChange` item the harness records after it applies a patch, carrying the
 * path the edit actually reached and the kind of change. That is a better
 * source than the patch text below: the harness resolved the path, so a patch a
 * script generated is named correctly even when its header still held the
 * script's own variable.
 */
const FILE_CHANGE_SPAN = 'file.change'
const FILE_CHANGE_KIND_ATTR = 'traces.codex.file_change_kind'

/**
 * A path that still holds an unexpanded variable: `${path}` from a template
 * literal, or `$FILE` from a shell. A script that builds a patch writes its own
 * text into the header, so the header can name a variable rather than a file.
 * It names no file, so it is dropped and counted rather than emitted as a path
 * the session never touched.
 */
const UNRESOLVED_PATH = /(?:^|\/)\$/

/** Tools whose arguments name one edited file directly rather than in a patch. */
const FILE_PATH_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'edit', 'write'])
const FILE_PATH_KEY = /"(?:file_path|filePath|path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/g

function decodeJsonString(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(`"${raw}"`)
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

interface ChangedPath {
  operations: string[]
  spanIds: string[]
}

function recordChangedPath(
  into: Map<string, ChangedPath>,
  path: string,
  operation: string,
  spanId: string,
): void {
  const entry = into.get(path) ?? { operations: [], spanIds: [] }
  if (!entry.operations.includes(operation)) entry.operations.push(operation)
  if (!entry.spanIds.includes(spanId)) entry.spanIds.push(spanId)
  into.set(path, entry)
}

/** The paths one `file.change` span states, with `move_path` as its own path. */
function harnessChangedPaths(span: OtlpSpan): { path: string; operation: string }[] {
  const input = inputValue(span)
  if (input === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const record = parsed as Record<string, unknown>
  const path = typeof record.path === 'string' ? record.path.trim() : ''
  if (path.length === 0) return []
  const kind = stringAttr(span, FILE_CHANGE_KIND_ATTR) ?? (typeof record.kind === 'string' ? record.kind : '')
  const movePath = typeof record.move_path === 'string' ? record.move_path.trim() : ''
  return [
    { path, operation: kind.length > 0 ? kind : 'update' },
    ...(movePath.length > 0 ? [{ path: movePath, operation: 'move' }] : []),
  ]
}

/**
 * Record a path recovered from a tool's own arguments, deferring to the
 * harness's record of the same edit.
 *
 * A header that names a file the harness already recorded joins that entry
 * rather than opening a second one, so an edit both sources saw is one changed
 * file carrying both spans as evidence — including when the header wrote the
 * path relative to the directory the harness resolved it against. When several
 * recorded paths end that way, the harness has the edit and which of them this
 * header names cannot be decided, so no entry claims the span.
 *
 * Returns false when the path was dropped for holding an unexpanded variable.
 */
function recordRecoveredPath(
  into: Map<string, ChangedPath>,
  resolved: readonly string[],
  path: string,
  operation: string,
  spanId: string,
): boolean {
  if (UNRESOLVED_PATH.test(path)) return false
  const known = resolved.filter((candidate) => candidate === path || candidate.endsWith(`/${path}`))
  if (known.length > 1) return true
  recordChangedPath(into, known[0] ?? path, operation, spanId)
  return true
}

function changedFilesOf(toolSpans: readonly OtlpSpan[], spans: readonly OtlpSpan[]): {
  files: ChangedFileFact[]
  truncatedInputs: number
  unresolvedPaths: number
} {
  const paths = new Map<string, ChangedPath>()
  // The harness's own record first, so the recovery below can defer to it. A
  // record the harness marked failed or declined changed no file.
  for (const span of spans) {
    if (span.name !== FILE_CHANGE_SPAN || span.status.code === 'ERROR') continue
    for (const change of harnessChangedPaths(span)) {
      recordChangedPath(paths, change.path, change.operation, span.span_id)
    }
  }
  const resolved = [...paths.keys()]
  let truncatedInputs = 0
  let unresolvedPaths = 0
  for (const span of toolSpans) {
    const input = inputValue(span)
    if (input === null) continue
    let matched = false
    for (const match of input.matchAll(PATCH_HEADER)) {
      const operation = PATCH_OPERATION[match[1]!]
      const path = match[2]?.trim()
      if (!operation || !path) continue
      matched = true
      if (!recordRecoveredPath(paths, resolved, path, operation, span.span_id)) unresolvedPaths += 1
    }
    if (!matched && FILE_PATH_TOOLS.has(toolName(span))) {
      for (const match of input.matchAll(FILE_PATH_KEY)) {
        const path = decodeJsonString(match[1] ?? '')
        if (!path) continue
        matched = true
        if (!recordRecoveredPath(paths, resolved, path, 'update', span.span_id)) unresolvedPaths += 1
      }
    }
    if (matched && inputTruncated(span)) truncatedInputs += 1
  }
  const files = [...paths]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, entry]) => ({ path, operations: entry.operations, spanIds: entry.spanIds }))
  return { files, truncatedInputs, unresolvedPaths }
}

function subagentsOf(spans: readonly OtlpSpan[]): SubagentSpawnFact[] {
  // A lifecycle span records the subagent's own path; joining it to the spawn
  // call by that path gives the reader both spans to check the task name with.
  const lifecycleByPath = new Map<string, string[]>()
  for (const span of spans) {
    const path = stringAttr(span, 'traces.codex.subagent_path')
    if (path === null || !isSynthesizedSpan(span)) continue
    lifecycleByPath.set(path, [...(lifecycleByPath.get(path) ?? []), span.span_id])
  }
  const spawns: SubagentSpawnFact[] = []
  for (const span of spans) {
    const isSpawn =
      attr(span, 'traces.codex.agent_operation') === 'spawn_agent' ||
      stringAttr(span, 'traces.codex.spawn_agent_path') !== null
    if (!isSpawn || isSynthesizedSpan(span)) continue
    const taskName = stringAttr(span, 'traces.codex.spawn_agent_path')
    spawns.push({
      taskName,
      taskNameUnavailable: taskName === null
        ? 'the spawn span carries no traces.codex.spawn_agent_path; the harness returned no task name for this call'
        : null,
      startedAt: span.start_time,
      status: span.status.code,
      spanIds: [span.span_id, ...(taskName ? lifecycleByPath.get(taskName) ?? [] : [])],
    })
  }
  return spawns
}

function finalMessagesOf(spans: readonly OtlpSpan[]): FinalMessageFact[] {
  const last = new Map<string | null, OtlpSpan>()
  for (const span of spans) {
    let task: string | null | undefined
    if (span.name === 'message.assistant') task = null
    else if (span.name.startsWith('message.agent.')) {
      task = stringAttr(span, 'traces.codex.agent_message_author') ?? 'unattributed subagent'
    }
    if (task === undefined) continue
    const previous = last.get(task)
    if (!previous || byTraceOrder(previous, span) <= 0) last.set(task, span)
  }
  return [...last]
    .sort(([left], [right]) => (left === null ? -1 : right === null ? 1 : left.localeCompare(right)))
    .map(([task, span]) => ({
      task,
      at: span.end_time,
      text: capText(typeof span.attributes.content === 'string' ? span.attributes.content : ''),
      spanId: span.span_id,
    }))
}

function capList<T>(items: readonly T[]): { kept: readonly T[]; partial?: string } {
  if (items.length <= FACT_LIST_CAP) return { kept: items }
  return {
    kept: items.slice(0, FACT_LIST_CAP),
    partial: `${items.length - FACT_LIST_CAP} of ${items.length} entries omitted; the count above the list is complete`,
  }
}

function listFact<T>(items: readonly T[], spanIds: readonly string[]): SessionFact<readonly T[]> {
  const { kept, partial } = capList(items)
  return { value: kept, spanIds: [...new Set(spanIds)], unavailable: null, ...(partial ? { partial } : {}) }
}

/** The changed-files fact, stating every way the list is known to be short. */
function changedFilesFact(
  files: readonly ChangedFileFact[],
  truncatedInputs: number,
  unresolvedPaths: number,
): SessionFact<readonly ChangedFileFact[]> {
  const fact = listFact(files, files.flatMap((entry) => entry.spanIds))
  const gaps = [
    ...(fact.partial ? [fact.partial] : []),
    ...(truncatedInputs > 0
      ? [
          `${truncatedInputs} contributing tool span(s) had truncated input; ` +
            'paths named after the cut are not in this list',
        ]
      : []),
    ...(unresolvedPaths > 0
      ? [
          `${unresolvedPaths} recovered path(s) still held an unexpanded variable and were dropped; ` +
            'each names a file only if the harness also recorded that change',
        ]
      : []),
  ]
  return { ...fact, ...(gaps.length > 0 ? { partial: gaps.join('; ') } : {}) }
}

/**
 * Why a `user.prompt` turn is not a human turn of this session.
 *
 * The actors come from the adapters, which classify each turn from the
 * harness's own signals; the reasons here say, in the sheet's own voice, what
 * each classification means for the count. They match the audit rule a person
 * would apply by hand: a user message is one the human typed, and instruction
 * files, environment-context blocks, system reminders, tool results, subagent
 * notifications, turn-aborted markers and skill or slash-command expansions are
 * the harness feeding the model.
 */
const TURN_EXCLUSION_REASONS: Readonly<Record<string, string>> = {
  injected:
    'harness-injected content rather than typed text: an instruction file, an environment-context block, ' +
    'a system reminder, a subagent notification, a turn-aborted marker, or a skill or slash-command expansion',
  agent: 'a parent agent sent this prompt to this session; no person typed it',
  'subagent-spawn': 'the brief that spawned this run, written by the agent that spawned it',
  'tool-result': 'a tool result the harness surfaced as a user turn',
  unclassified: 'the span carries no actor, so whether a person typed it cannot be read from the spans',
}

const INHERITED_TURN_REASON =
  'context this session carries but did not receive: history copied from the parent when the session forked, ' +
  'or the turns a compaction retained. The person typed it into the parent thread, not into this session'

const DUPLICATE_TURN_REASON =
  'a second record of the turn before it: the same text at the same instant, with no model call, tool call ' +
  'or assistant message between them'

/** Spans that mean the agent acted: a person cannot have typed twice across one. */
function isAgentActivity(span: OtlpSpan): boolean {
  if (span.name === 'user.prompt') return false
  const kind = attr(span, OPENINFERENCE_SPAN_KIND)
  return kind === 'TOOL' || kind === 'LLM' || span.name === 'message.assistant' || span.name.startsWith('message.agent.')
}

function turnText(span: OtlpSpan): string {
  return capText(typeof span.attributes.content === 'string' ? span.attributes.content : '')
}

function normalizedTurnText(span: OtlpSpan): string {
  return turnText(span).replace(/\s+/g, ' ').trim()
}

/**
 * The human turns of one session, and every `user.prompt` span left out of them.
 *
 * Three filters, in order: a turn the session inherited rather than received, a
 * turn whose actor is not a person, and a second record of the turn before it.
 * `spans` is the whole trace in order, because the duplicate test asks what
 * happened between two turns.
 */
function humanTurnsOf(spans: readonly OtlpSpan[]): {
  turns: SessionTurnFact[]
  excluded: ExcludedTurnFact[]
} {
  const excluded = new Map<string, string[]>()
  const drop = (reason: string, spanId: string): void => {
    excluded.set(reason, [...(excluded.get(reason) ?? []), spanId])
  }
  const kept: OtlpSpan[] = []
  let sinceKept: OtlpSpan[] = []
  for (const span of spans) {
    if (span.name !== 'user.prompt') {
      sinceKept.push(span)
      continue
    }
    if (span.attributes[INHERITED_SPAN_ATTR] === true) {
      const source = stringAttr(span, INHERITED_SOURCE_ATTR)
      drop(source === null ? INHERITED_TURN_REASON : `${INHERITED_TURN_REASON} (${source})`, span.span_id)
      continue
    }
    const actor = stringAttr(span, ACTOR_ATTR) ?? 'unclassified'
    if (actor !== 'human') {
      drop(TURN_EXCLUSION_REASONS[actor] ?? `the adapter classified this turn as "${actor}", not as a person typing`, span.span_id)
      continue
    }
    const previous = kept[kept.length - 1]
    // Two records of ONE submission describe one instant, so they carry the
    // same start time; a person who sends the same short message twice is
    // seconds apart. Pairing records that are merely close is the adapter's
    // job, where the records themselves say which log each came from — a sheet
    // that guessed from the spans collapsed a measured "continue, continue"
    // typed 1.8 s apart into one turn.
    const duplicate =
      previous !== undefined &&
      previous.start_time === span.start_time &&
      normalizedTurnText(previous) === normalizedTurnText(span) &&
      normalizedTurnText(span).length > 0 &&
      !sinceKept.some(isAgentActivity)
    if (duplicate) {
      drop(DUPLICATE_TURN_REASON, span.span_id)
      continue
    }
    kept.push(span)
    sinceKept = []
  }
  return {
    turns: kept.map((span) => ({ actor: 'human', at: span.start_time, text: turnText(span), spanId: span.span_id })),
    excluded: [...excluded]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, spanIds]) => ({ reason, turns: spanIds.length, spanIds })),
  }
}

/**
 * Compute the facts sheet for every trace in `spans`. One trace is one session.
 * Deterministic and free: the same spans always produce the same sheet, and no
 * model, network call, or budget is involved.
 */
export function computeSessionFacts(spans: readonly OtlpSpan[]): SessionFacts[] {
  const { sessionByTrace } = indexSessionIdsByTrace(spans)
  const byTrace = new Map<string, OtlpSpan[]>()
  for (const span of spans) {
    byTrace.set(span.trace_id, [...(byTrace.get(span.trace_id) ?? []), span])
  }
  return [...byTrace]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([traceId, traceSpans]) => sessionFactsForTrace(traceId, sessionByTrace.get(traceId) ?? null, traceSpans))
}

function sessionFactsForTrace(
  traceId: string,
  sessionId: string | null,
  unordered: readonly OtlpSpan[],
): SessionFacts {
  const spans = [...unordered].sort(byTraceOrder)
  const harness = spans.map((span) => stringAttr(span, 'service.name')).find((name) => name !== null) ?? null

  const toolSpans = spans.filter(isToolSpan)
  const synthesized = toolSpans.filter(isSynthesizedSpan)
  const invoked = toolSpans.filter((span) => !isSynthesizedSpan(span))
  const byName: Record<string, number> = {}
  for (const span of invoked) byName[toolName(span)] = (byName[toolName(span)] ?? 0) + 1

  const subagents = subagentsOf(spans)
  const pullRequests = readPullRequests(spans)
  const promptSpans = spans.filter((span) => span.name === 'user.prompt')
  const { turns: humanTurns, excluded: excludedTurns } = humanTurnsOf(spans)
  const actorCounts = new Map<string, string[]>()
  for (const span of promptSpans) {
    const actor = stringAttr(span, ACTOR_ATTR) ?? 'unclassified'
    actorCounts.set(actor, [...(actorCounts.get(actor) ?? []), span.span_id])
  }
  const finalMessages = finalMessagesOf(spans)
  const { files, truncatedInputs, unresolvedPaths } = changedFilesOf(invoked, spans)

  const starts = spans.filter((span) => Number.isFinite(Date.parse(span.start_time)))
  const ends = spans.filter((span) => Number.isFinite(Date.parse(span.end_time)))
  const firstSpan = starts.reduce<OtlpSpan | null>(
    (best, span) => (best === null || Date.parse(span.start_time) < Date.parse(best.start_time) ? span : best),
    null,
  )
  const lastSpan = ends.reduce<OtlpSpan | null>(
    (best, span) => (best === null || Date.parse(span.end_time) > Date.parse(best.end_time) ? span : best),
    null,
  )

  const tokenSpan = spans.find((span) => typeof span.attributes[SESSION_TOKEN_TOTAL_ATTR] === 'number')
  const receipts = spans.filter((span) => span.attributes[CORRUPTION_RECEIPT_VERSION_ATTR] !== undefined)
  const recordSpans = spans.filter(
    (span) => span.parent_span_id !== null && span.attributes[CORRUPTION_RECEIPT_VERSION_ATTR] === undefined,
  ).length
  const corruptionSpan = spans.find((span) => typeof span.attributes[CORRUPTION_COUNT_ATTR] === 'number')

  return {
    schemaVersion: 1,
    kind: 'traces.session_facts',
    traceId,
    sessionId,
    harness,
    spanCount: spans.length,
    recordSpans,
    unreadRecords: corruptionSpan
      ? {
          value: corruptionSpan.attributes[CORRUPTION_COUNT_ATTR] as number,
          spanIds: [corruptionSpan.span_id, ...receipts.map((span) => span.span_id)],
          unavailable: null,
        }
      : {
          value: null,
          spanIds: [],
          unavailable:
            `no span carries ${CORRUPTION_COUNT_ATTR}; this trace was not read through the session ` +
            'integrity path, so whether any record was skipped is unknown',
        },
    toolCalls: {
      value: invoked.length,
      spanIds: invoked.map((span) => span.span_id),
      unavailable: null,
    },
    synthesizedToolSpans: {
      value: synthesized.length,
      spanIds: synthesized.map((span) => span.span_id),
      unavailable: null,
    },
    toolCallsByName: {
      value: byName,
      spanIds: invoked.map((span) => span.span_id),
      unavailable: null,
    },
    subagents: listFact(subagents, subagents.flatMap((entry) => entry.spanIds)),
    pullRequests: pullRequests.facts
      ? {
          value: pullRequests.facts,
          spanIds: pullRequests.spanIds,
          unavailable: null,
          ...(pullRequests.partial ? { partial: pullRequests.partial } : {}),
        }
      : { value: null, spanIds: [], unavailable: pullRequests.unavailable ?? 'unread' },
    humanTurns: listFact(humanTurns, humanTurns.map((turn) => turn.spanId)),
    excludedTurns: listFact(excludedTurns, excludedTurns.flatMap((entry) => entry.spanIds)),
    turnsByActor: listFact(
      [...actorCounts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([actor, spanIds]) => ({ actor, turns: spanIds.length, spanIds })),
      promptSpans.map((span) => span.span_id),
    ),
    finalMessages: listFact(finalMessages, finalMessages.map((entry) => entry.spanId)),
    changedFiles: changedFilesFact(files, truncatedInputs, unresolvedPaths),
    firstRecordAt: firstSpan
      ? { value: firstSpan.start_time, spanIds: [firstSpan.span_id], unavailable: null }
      : { value: null, spanIds: [], unavailable: 'no span in this trace carries a parseable start time' },
    lastRecordAt: lastSpan
      ? { value: lastSpan.end_time, spanIds: [lastSpan.span_id], unavailable: null }
      : { value: null, spanIds: [], unavailable: 'no span in this trace carries a parseable end time' },
    tokenTotal: tokenSpan
      ? {
          value: tokenSpan.attributes[SESSION_TOKEN_TOTAL_ATTR] as number,
          spanIds: [tokenSpan.span_id],
          unavailable: null,
        }
      : {
          value: null,
          spanIds: [],
          unavailable:
            `no span carries ${SESSION_TOKEN_TOTAL_ATTR}; the per-turn llm.turn deltas in this trace ` +
            'are a different quantity and summing them would not be the harness total',
        },
  }
}

/** The facts sheet for a set of spans, as one report. */
export function buildSessionFactsReport(
  spans: readonly OtlpSpan[],
  options: { harness?: string | null; generatedAt?: string } = {},
): SessionFactsReport {
  return {
    schemaVersion: 1,
    kind: 'traces.session_facts_report',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    harness: options.harness ?? null,
    spanCount: spans.length,
    sessions: computeSessionFacts(spans),
  }
}

function factLine(label: string, fact: SessionFact<unknown>, rendered: string): string {
  if (fact.value === null) return `  ${label}: unavailable — ${fact.unavailable}`
  const partial = fact.partial ? ` (partial: ${fact.partial})` : ''
  return `  ${label}: ${rendered}${partial}`
}

/** The short readable form: the same facts, one screen, no span-id lists. */
export function renderSessionFacts(report: SessionFactsReport): string {
  const lines: string[] = [
    `session facts — ${report.sessions.length} session(s), ${report.spanCount} span(s), deterministic, $0`,
  ]
  for (const facts of report.sessions) {
    lines.push('', `${facts.sessionId ?? facts.traceId} [${facts.harness ?? 'unknown harness'}] ${facts.spanCount} spans`)
    lines.push(
      factLine(
        'tool calls',
        facts.toolCalls,
        `${facts.toolCalls.value} (${facts.synthesizedToolSpans.value ?? 0} synthesized span(s) excluded)`,
      ),
    )
    lines.push(
      factLine(
        'subagents',
        facts.subagents,
        `${facts.subagents.value?.length ?? 0}${
          facts.subagents.value?.length
            ? `: ${facts.subagents.value.map((entry) => entry.taskName ?? '<unnamed>').join(', ')}`
            : ''
        }`,
      ),
    )
    lines.push(
      factLine(
        'pull requests',
        facts.pullRequests,
        `${facts.pullRequests.value?.created.length ?? 0} created${
          facts.pullRequests.value?.created.length
            ? ` (${facts.pullRequests.value.created.map((entry) => entry.identifier ?? 'unidentified').join(', ')})`
            : ''
        }, ${facts.pullRequests.value?.merged.length ?? 0} merged${
          facts.pullRequests.value?.merged.length
            ? ` (${facts.pullRequests.value.merged.map((entry) => entry.identifier ?? 'unidentified').join(', ')})`
            : ''
        }`,
      ),
    )
    lines.push(factLine('human turns', facts.humanTurns, String(facts.humanTurns.value?.length ?? 0)))
    for (const entry of facts.excludedTurns.value ?? []) {
      lines.push(`  turns not counted: ${entry.turns} — ${entry.reason}`)
    }
    lines.push(
      factLine(
        'turns by actor',
        facts.turnsByActor,
        facts.turnsByActor.value?.length
          ? facts.turnsByActor.value.map((entry) => `${entry.actor} ${entry.turns}`).join(', ')
          : 'none',
      ),
    )
    lines.push(factLine('changed files', facts.changedFiles, String(facts.changedFiles.value?.length ?? 0)))
    lines.push(factLine('first record', facts.firstRecordAt, String(facts.firstRecordAt.value)))
    lines.push(factLine('last record', facts.lastRecordAt, String(facts.lastRecordAt.value)))
    lines.push(factLine('token total', facts.tokenTotal, String(facts.tokenTotal.value)))
    if ((facts.unreadRecords.value ?? 0) > 0) {
      lines.push(`  unread records: ${facts.unreadRecords.value} (the facts above are computed from the rest)`)
    }
    for (const message of facts.finalMessages.value ?? []) {
      lines.push(`  final message [${message.task ?? 'session agent'}]: ${message.text.split('\n')[0]?.slice(0, 160) ?? ''}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * The byte ceiling one prepared-context string stays under.
 *
 * `DEFAULT_TRACE_ANALYST_BUDGETS.perCallByteCeiling` is 150,000 — the size one
 * trace-tool result may return. Prepared context is read by the same model in
 * the same turn as those results, so the sheet claims a fifth of that ceiling
 * and leaves the rest for the tool calls the model still has to make.
 */
export const PREPARED_CONTEXT_BYTE_CEILING = 30_000

/**
 * Render the sheet as bounded prepared context.
 *
 * Prepared context is not evidence: it is a head start. The rendering therefore
 * keeps every field's span ids so that each fact can be checked against the raw
 * spans, and says out loud that the sheet itself is not citable.
 *
 * The result is guaranteed to be at most `byteCeiling` bytes. Fields are shed
 * from the largest list downward, and the shed is reported inside the context
 * rather than silently applied.
 */
export function renderSessionFactsContext(
  report: SessionFactsReport,
  options: { byteCeiling?: number } = {},
): string {
  const ceiling = options.byteCeiling ?? PREPARED_CONTEXT_BYTE_CEILING
  const header =
    'SESSION FACTS (deterministic, computed from the spans, no model call). ' +
    'Each fact names the span ids it came from: cite those spans, never this sheet. ' +
    'A null value carries the reason the spans cannot support it — do not replace it with a guess.'
  let sessions = report.sessions.map(compactFacts)
  const encode = (dropped: string[]): string =>
    `${header}\n${JSON.stringify({ sessions, ...(dropped.length ? { omitted_fields: dropped } : {}) })}`

  const dropped: string[] = []
  // Shed in reverse usefulness order: text first, then the long id lists, then
  // whole list fields. The counts, which answer most questions, are last to go.
  const sheds: Array<[string, (facts: CompactFacts) => void]> = [
    ['human_turn_text', (facts) => { for (const turn of facts.human_turns) delete turn.text }],
    ['final_message_text', (facts) => { for (const message of facts.final_messages) delete message.text }],
    ['pull_request_commands', (facts) => {
      for (const entry of [...(facts.pull_requests.created ?? []), ...(facts.pull_requests.merged ?? [])]) {
        delete entry.command
        delete entry.span_ids
      }
    }],
    ['tool_call_span_ids', (facts) => { facts.tool_calls.span_ids = [] }],
    ['tool_calls_by_name', (facts) => { delete facts.tool_calls_by_name }],
    ['excluded_turn_span_ids', (facts) => {
      facts.excluded_turns = facts.excluded_turns?.map((entry) => {
        const { span_ids: _dropped, ...rest } = entry as { span_ids?: readonly string[] }
        return rest
      })
    }],
    ['changed_files', (facts) => { facts.changed_files = { count: facts.changed_files.count } }],
    ['turns_by_actor', (facts) => { delete facts.turns_by_actor }],
    ['pull_request_evidence', (facts) => {
      for (const entry of [...(facts.pull_requests.created ?? []), ...(facts.pull_requests.merged ?? [])]) {
        delete entry.evidence
      }
    }],
    ['excluded_turns', (facts) => { delete facts.excluded_turns }],
    ['subagents', (facts) => { facts.subagents = { count: facts.subagents.count } }],
    ['final_messages', (facts) => { facts.final_messages = [] }],
    ['human_turns', (facts) => { facts.human_turns = [] }],
  ]
  for (const [name, shed] of sheds) {
    if (Buffer.byteLength(encode(dropped)) <= ceiling) break
    for (const facts of sessions) shed(facts)
    dropped.push(name)
  }
  let text = encode(dropped)
  // A trace set too large to describe at all keeps the sessions it can fit.
  while (Buffer.byteLength(text) > ceiling && sessions.length > 1) {
    sessions = sessions.slice(0, Math.max(1, Math.floor(sessions.length / 2)))
    text = encode([...dropped, `sessions_beyond_${sessions.length}`])
  }
  if (Buffer.byteLength(text) <= ceiling) return text
  // Below one session's smallest record the sheet says so and supplies nothing,
  // rather than returning a fragment that reads like a complete sheet. The
  // ceiling is a guarantee, so an unusable one produces no context at all.
  const refusal = `${header}\n${JSON.stringify({ sessions: [], omitted_fields: ['all: the byte ceiling is below one session record'] })}`
  return Buffer.byteLength(refusal) <= ceiling ? refusal : ''
}

interface CompactPullRequest {
  id: string | null
  number: string | null
  head_branch: string | null
  evidence?: string
  command?: string
  span_ids?: readonly string[]
  unavailable?: string
}

/** Either the two lists, or a null reading with the reason. Never both. */
interface CompactPullRequests {
  created?: CompactPullRequest[]
  merged?: CompactPullRequest[]
  value?: null
  unavailable?: string
  partial?: string
}

interface CompactFacts {
  session_id: string | null
  trace_id: string
  spans: number
  tool_calls: { count: number | null; synthesized_excluded: number | null; span_ids: readonly string[] }
  tool_calls_by_name?: Readonly<Record<string, number>> | null
  subagents: { count: number; entries?: readonly unknown[] }
  pull_requests: CompactPullRequests
  human_turns: Array<{ at: string; span_id: string; text?: string }>
  excluded_turns?: readonly unknown[] | null
  turns_by_actor?: readonly unknown[] | null
  final_messages: Array<{ task: string | null; at: string; span_id: string; text?: string }>
  changed_files: { count: number; paths?: readonly unknown[]; partial?: string }
  first_record_at: unknown
  last_record_at: unknown
  token_total: unknown
}

function factJson(fact: SessionFact<unknown>): unknown {
  return fact.value === null
    ? { value: null, unavailable: fact.unavailable }
    : { value: fact.value, span_ids: fact.spanIds }
}

function compactPullRequests(fact: SessionFact<PullRequestFacts>): CompactPullRequests {
  if (fact.value === null) return { value: null, unavailable: fact.unavailable ?? 'unread' }
  const entry = (pr: PullRequestFacts['created'][number]): CompactPullRequest => ({
    id: pr.identifier,
    number: pr.number,
    head_branch: pr.headBranch,
    evidence: pr.evidence,
    command: pr.command,
    span_ids: pr.spanIds,
    ...(pr.unavailable ? { unavailable: pr.unavailable } : {}),
  })
  return {
    created: fact.value.created.map(entry),
    merged: fact.value.merged.map(entry),
    ...(fact.partial ? { partial: fact.partial } : {}),
  }
}

function compactFacts(facts: SessionFacts): CompactFacts {
  return {
    session_id: facts.sessionId,
    trace_id: facts.traceId,
    spans: facts.spanCount,
    tool_calls: {
      count: facts.toolCalls.value,
      synthesized_excluded: facts.synthesizedToolSpans.value,
      span_ids: facts.toolCalls.spanIds,
    },
    tool_calls_by_name: facts.toolCallsByName.value,
    subagents: {
      count: facts.subagents.value?.length ?? 0,
      entries: facts.subagents.value?.map((entry) => ({
        task_name: entry.taskName,
        ...(entry.taskNameUnavailable ? { task_name_unavailable: entry.taskNameUnavailable } : {}),
        started_at: entry.startedAt,
        status: entry.status,
        span_ids: entry.spanIds,
      })),
    },
    pull_requests: compactPullRequests(facts.pullRequests),
    human_turns: (facts.humanTurns.value ?? []).map((turn) => ({
      at: turn.at,
      span_id: turn.spanId,
      text: turn.text,
    })),
    excluded_turns: facts.excludedTurns.value?.map((entry) => ({
      reason: entry.reason,
      turns: entry.turns,
      span_ids: entry.spanIds,
    })),
    turns_by_actor: facts.turnsByActor.value?.map((entry) => ({
      actor: entry.actor,
      turns: entry.turns,
      span_ids: entry.spanIds,
    })),
    final_messages: (facts.finalMessages.value ?? []).map((message) => ({
      task: message.task,
      at: message.at,
      span_id: message.spanId,
      text: message.text,
    })),
    changed_files: {
      count: facts.changedFiles.value?.length ?? 0,
      paths: facts.changedFiles.value?.map((file) => ({
        path: file.path,
        operations: file.operations,
        span_ids: file.spanIds,
      })),
      ...(facts.changedFiles.partial ? { partial: facts.changedFiles.partial } : {}),
    },
    first_record_at: factJson(facts.firstRecordAt),
    last_record_at: factJson(facts.lastRecordAt),
    token_total: factJson(facts.tokenTotal),
  }
}

/**
 * The prepared-context string for one set of spans, or undefined when there is
 * nothing to prepare. Analyst definitions install this through
 * `TraceAnalystDefinition.prepareContext`, which runs before the model does.
 */
export function sessionFactsContext(
  spans: readonly OtlpSpan[],
  options: { byteCeiling?: number; generatedAt?: string } = {},
): string | undefined {
  if (spans.length === 0) return undefined
  const report = buildSessionFactsReport(spans, {
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
  })
  if (report.sessions.length === 0) return undefined
  return renderSessionFactsContext(report, options)
}

/**
 * Version suffix stamped on a definition that receives the sheet.
 *
 * `createTraceAnalyst` records `prepare_context: "version-bound"` in an
 * analyst's exact-run identity, which is a contract: a definition whose
 * prepared context changed is a different analyst. Wrapping therefore bumps the
 * version instead of quietly changing what the same version does.
 */
export const SESSION_FACTS_VERSION_SUFFIX = 'session-facts.1'

/**
 * Supply the sheet to every definition as prepared context, before the model
 * runs. A definition that already prepares context keeps it; the sheet is
 * appended after it, bounded by its own ceiling, so the pair stays inside the
 * documented `perCallByteCeiling` of 150,000 bytes.
 *
 * The sheet is computed once for the whole set: it is deterministic, so every
 * definition receives the identical text.
 */
export function withSessionFactsContext(
  definitions: readonly TraceAnalystDefinition[],
  spans: readonly OtlpSpan[],
  options: { byteCeiling?: number } = {},
): TraceAnalystDefinition[] {
  const sheet = sessionFactsContext(spans, options)
  if (sheet === undefined) return [...definitions]
  return definitions.map((definition) => ({
    ...definition,
    version: `${definition.version}+${SESSION_FACTS_VERSION_SUFFIX}`,
    prepareContext: async (store, context) => {
      const own = await definition.prepareContext?.(store, context)
      return own ? `${own}\n\n${sheet}` : sheet
    },
  }))
}
