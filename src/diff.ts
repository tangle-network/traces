/**
 * `traces diff <a> <b>`: the first tool call where two runs of one task split.
 *
 * A run's steps are its tool calls, in containment order. Each step is the
 * tool's name, its status and a fingerprint of its argument: the command a
 * shell call ran, the path a file tool read or wrote, the files a patch
 * touched, or else the call's whole input. The fingerprint is taken after the
 * run's own places are written as placeholders: its working directories (the
 * recorded session cwd and every call's workdir) as `<cwd>`, the worktree that
 * holds them as `<worktree>`, temp directories as `<tmp>` and hex ids as
 * `<hex>`. Two runs of one play in two worktrees therefore agree wherever they
 * did the same thing. Model calls are not steps: two runs never word a reply
 * the same way, and a reply is not where a run's behavior splits.
 *
 * Pairing and the first divergence are agent-eval's `diffSteps`.
 */

import { createHash } from 'node:crypto'
import { type DiagnosisSpan, epochMillis } from '@tangle-network/agent-eval/diagnosis'
import { type DiffStep, diffSteps, diffStepsFromSpans, type StepDiff } from '@tangle-network/agent-eval/pipelines'
import { OPENINFERENCE_SPAN_KIND, TOOL_NAME } from '@tangle-network/agent-eval/trace-attributes'
import { canonicalJson } from './adapters/tool-io.js'
import { ATTR, SESSION_CWD_ATTR } from './attributes.js'
import type { OtlpSpan } from './otlp.js'
import { readRefSpans } from './refs.js'
import { isSynthesizedSpan } from './session-facts.js'
import { commandTextFromInput } from './shell-commands.js'

/** One tool call, as the diff compares it. */
export interface RunStep extends DiffStep {
  /**
   * The argument the fingerprint was taken from, normalized and on one line,
   * clipped to {@link TEXT_LIMIT} characters; null when the trace recorded no
   * input for the call.
   */
  readonly text: string | null
}

export interface RunDiffSide {
  /** The ref as given. */
  readonly ref: string
  readonly traceId: string
  /** Spans the ref holds. */
  readonly spans: number
  /** The working directories written as `<cwd>`: the recorded session cwd and every call's workdir. */
  readonly cwds: readonly string[]
  /** The run's tool calls in order: the steps the diff pairs. */
  readonly steps: readonly RunStep[]
}

export interface RunDiffReport {
  readonly kind: 'traces.run_diff'
  readonly a: RunDiffSide
  readonly b: RunDiffSide
  /** Step indexes are 0-based positions in `a.steps` and `b.steps`. */
  readonly diff: StepDiff
  /**
   * Set when "the runs agree" would overclaim: neither run made a tool call,
   * or no call on either side records an OK or ERROR status, so agreement on
   * outcome cannot be called.
   */
  readonly caveat?: string
}

/** Characters of a step's argument kept in {@link RunStep.text}, as `facts --match` clips text. */
const TEXT_LIMIT = 300

/** Input keys that hold the directory a call ran in. Not part of the argument: it is where, not what. */
const WORKDIR_KEYS = ['workdir', 'cwd'] as const
/** Input keys that name the one file a file tool reads or writes (Claude Code, OpenCode). */
const FILE_KEYS = ['file_path', 'filePath', 'notebook_path'] as const
/** Span attributes that hold the session's working directory as the harness recorded it. */
const RECORDED_CWD_KEYS = [SESSION_CWD_ATTR, ATTR.ENVIRONMENT_CWD] as const
/** The header lines of an `apply_patch` envelope, raw or JSON-encoded: the rule facts reads changed files with. */
const PATCH_HEADER = /\*\*\* (Add|Update|Delete|Move to) File: ([^\n"\\]+)/g
/** Directories that hold one worktree each, so the segment after one names a worktree root. */
const WORKTREE_PARENT = /^(.*?\/(?:_wt|\.worktrees|worktrees)\/[^/]+)\/./
/** A temp directory: the temp root plus the one segment a run's mktemp or harness created under it. */
const TEMP_DIR = /(?<![\w.~-])(?:\/private)?(?:\/tmp|\/var\/tmp|\/var\/folders\/[^/\s]+\/[^/\s]+\/T)\/[^/\s'"`;|&<>(){}]+/g
/** A UUID, or a run of 7 or more hex digits in one case; {@link hexId} keeps runs that are not ids. */
const HEX_RUN = /(?<![0-9A-Za-z])(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}|[0-9a-f]{7,}|[0-9A-F]{7,})(?![0-9A-Za-z])/g

/** A run of hex digits is an id when it is a UUID or mixes digits and letters: a date (`20261017`) or a word (`deadbeef`) is not. */
function hexId(run: string): string {
  return run.includes('-') || (/[0-9]/.test(run) && /[a-f]/i.test(run)) ? '<hex>' : run
}

function stringOf(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  if (!text.trimStart().startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The files an `apply_patch` envelope touches, one header per file; null when the text is not a patch. */
function patchedFiles(text: string): string | null {
  if (!text.includes('*** Begin Patch')) return null
  const headers = [...text.matchAll(PATCH_HEADER)].map((match) => `${match[1]} File: ${match[2]!.trim()}`)
  return headers.length > 0 ? headers.join('; ') : null
}

interface CallArgument {
  readonly argument: string | null
  readonly workdir: string | null
}

/** What a tool call was asked to do, before normalization, and the directory it ran in. */
function callArgument(span: OtlpSpan): CallArgument {
  const raw = span.attributes['input.value']
  if (raw === undefined || raw === null || raw === '') return { argument: null, workdir: null }
  const text = typeof raw === 'string' ? raw : canonicalJson(raw)
  const input = jsonObject(text)
  const workdir = input ? stringOf(input, WORKDIR_KEYS) : null
  const command = commandTextFromInput(text)
  if (command !== undefined) return { argument: command, workdir }
  if (!input) return { argument: patchedFiles(text) ?? text, workdir: null }
  const file = stringOf(input, FILE_KEYS)
  if (file) return { argument: file, workdir }
  const patch = Object.values(input).find((value): value is string => typeof value === 'string' && value.includes('*** Begin Patch'))
  const patched = patch === undefined ? null : patchedFiles(patch)
  if (patched) return { argument: patched, workdir }
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !(WORKDIR_KEYS as readonly string[]).includes(key)))
  return { argument: canonicalJson(rest), workdir }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The run's places as placeholders. Each working directory is `<cwd>`, the
 * worktree that holds it `<worktree>`, each also in the dash-encoded form
 * Claude Code names its project and scratch directories with. The longest
 * place is tried first, and a place matches only as a whole path.
 */
function normalizer(cwds: readonly string[]): (text: string) => string {
  const places = new Map<string, string>()
  const add = (path: string, placeholder: string) => {
    if (path.length < 2 || places.has(path)) return
    places.set(path, placeholder)
    places.set(path.replace(/[^A-Za-z0-9]/g, '-'), placeholder)
  }
  for (const cwd of cwds) add(cwd, '<cwd>')
  for (const cwd of cwds) {
    const worktree = WORKTREE_PARENT.exec(cwd)?.[1]
    if (worktree) add(worktree, '<worktree>')
  }
  const ordered = [...places.keys()].sort((x, y) => y.length - x.length)
  const place = ordered.length === 0
    ? null
    : new RegExp(`(?<![\\w.~-])(?:${ordered.map(escapeRegExp).join('|')})(?![\\w.@%+=,~-])`, 'g')
  return (text) => {
    const placed = place ? text.replace(place, (match) => places.get(match)!) : text
    return placed.replace(TEMP_DIR, '<tmp>').replace(HEX_RUN, hexId)
  }
}

/** A tool call the agent made: facts' definition, so diff and facts count the same calls. */
function isToolCall(span: OtlpSpan): boolean {
  return span.attributes[OPENINFERENCE_SPAN_KIND] === 'TOOL' && !isSynthesizedSpan(span)
}

function toolName(span: OtlpSpan): string {
  const name = span.attributes[TOOL_NAME]
  return typeof name === 'string' && name.length > 0 ? name : span.name.replace(/^tool\./, '')
}

/** One line, clipped: what a person reads of an argument. */
function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

/** Every span in containment order, as agent-eval orders a run: depth first, siblings by start time. */
function containmentOrder(spans: readonly OtlpSpan[]): OtlpSpan[] {
  const byId = new Map<string, OtlpSpan>()
  for (const span of spans) if (!byId.has(span.span_id)) byId.set(span.span_id, span)
  const shapes = [...byId.values()].map((span): DiagnosisSpan => ({
    traceId: span.trace_id,
    spanId: span.span_id,
    parentSpanId: span.parent_span_id,
    name: span.name,
    kind: String(span.attributes[OPENINFERENCE_SPAN_KIND] ?? 'UNKNOWN') as DiagnosisSpan['kind'],
    startMs: epochMillis(span.start_time),
    endMs: epochMillis(span.end_time),
    status: span.status.code,
    statusMessage: null,
    toolName: null,
    model: null,
    inputDigest: null,
    attributes: {},
  }))
  return diffStepsFromSpans(shapes).map((step) => byId.get(step.id)!)
}

/**
 * Read one side. A side is any ref that holds one run: a session id or unique
 * prefix or suffix, a session file, an OTLP file or directory, any file
 * `traces convert` reads, `file#<trace id>` for one run of several, or
 * `file#branch=<id>` for one arm of a run.
 */
async function readRunSide(ref: string): Promise<RunDiffSide> {
  const spans = await readRefSpans(ref)
  const traces = [...new Set(spans.map((span) => span.trace_id))]
  if (traces.length !== 1) {
    throw new Error(traces.length === 0
      ? `${ref} holds no spans`
      : `${ref} holds ${traces.length} runs; pick one with ${ref}#<trace id>: ${traces.slice(0, 10).join(', ')}`)
  }
  const calls = containmentOrder(spans).filter(isToolCall).map((span) => ({ span, ...callArgument(span) }))
  const cwds = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.startsWith('/')) cwds.add(value.replace(/\/+$/, ''))
  }
  for (const span of spans) for (const key of RECORDED_CWD_KEYS) add(span.attributes[key])
  // A served or exported trace may carry only the cwd traces resolved (`tangle.cwd`).
  if (cwds.size === 0) for (const span of spans) add(span.attributes[ATTR.CWD])
  for (const call of calls) add(call.workdir)
  const normalize = normalizer([...cwds])
  const steps = calls.map(({ span, argument }): RunStep => {
    const normalized = argument === null ? null : normalize(argument)
    return {
      id: span.span_id,
      name: toolName(span),
      kind: 'TOOL',
      fields: {
        status: span.status.code,
        args: normalized === null ? null : createHash('sha256').update(normalized).digest('hex').slice(0, 16),
      },
      text: normalized === null ? null : oneLine(normalized, TEXT_LIMIT),
    }
  })
  return { ref, traceId: traces[0]!, spans: spans.length, cwds: [...cwds].sort(), steps }
}

function agreementCaveat(a: readonly RunStep[], b: readonly RunStep[]): string | undefined {
  if (a.length === 0 && b.length === 0) return 'neither run made a tool call'
  const decided = (steps: readonly RunStep[]) => steps.some((step) => step.fields.status === 'OK' || step.fields.status === 'ERROR')
  if (!decided(a) && !decided(b)) return 'no tool call on either side records an OK or ERROR status (all UNSET)'
  return undefined
}

/**
 * Two runs' tool calls, paired, with the first divergence marked. Span ids pair
 * steps only within one trace (`diff a a`, two arms of one run): across two
 * runs a span id is the harness's own counter, and equal ids name different calls.
 */
export async function diffRuns(a: string, b: string): Promise<RunDiffReport> {
  const [left, right] = await Promise.all([readRunSide(a), readRunSide(b)])
  const keyed = (side: RunDiffSide): RunStep[] =>
    left.traceId === right.traceId ? [...side.steps] : side.steps.map((step) => ({ ...step, id: `${side.traceId}\u0000${step.id}` }))
  const diff = diffSteps(keyed(left), keyed(right))
  const caveat = diff.firstDivergence ? undefined : agreementCaveat(left.steps, right.steps)
  return { kind: 'traces.run_diff', a: left, b: right, diff, ...(caveat ? { caveat } : {}) }
}

/** Characters of an argument shown per line of text output. */
const SHOWN = 120

/** The argument as shown beside the other run's: clipped, and windowed to where the two first differ. */
function shown(text: string | null, other: string | null): string {
  if (text === null) return '(input not recorded)'
  if (other === null || other === text || text.length <= SHOWN) return oneLine(text, SHOWN)
  let at = 0
  while (at < text.length && text[at] === other[at]) at += 1
  if (at < SHOWN - 20) return oneLine(text, SHOWN)
  const start = at - 40
  return `…${oneLine(text.slice(start), SHOWN)}`
}

function stepLine(side: 'A' | 'B', step: RunStep | undefined, other: RunStep | undefined, count: number): string {
  if (!step) return `  ${side}  (no more tool calls: it made ${count})`
  const status = step.fields.status === 'OK' ? '' : ` [${String(step.fields.status)}]`
  return `  ${side}  ${step.name}${status}  ${shown(step.text, other?.text ?? null)}`
}

/** Why the first divergence is one, in words. */
function why(first: NonNullable<StepDiff['firstDivergence']>): string {
  switch (first.kind) {
    case 'changed': return first.differences.map((d) => (d.field === 'args' ? 'argument' : d.field)).join(', ')
    case 'replaced': return 'tool'
    case 'only-in-a': return 'a call only A makes'
    case 'only-in-b': return 'a call only B makes'
    case 'reordered': return 'order: each call is made elsewhere in the other run'
  }
}

function sideLine(label: 'A' | 'B', side: RunDiffSide): string {
  const cwd = side.cwds.length === 0 ? '' : ` · cwd ${side.cwds[0]}${side.cwds.length > 1 ? ` (+${side.cwds.length - 1})` : ''}`
  return `${label}  ${side.ref}  ${side.steps.length} tool call${side.steps.length === 1 ? '' : 's'}${cwd}`
}

export function renderRunDiff(report: RunDiffReport): string {
  const { a, b, diff } = report
  const lines = [sideLine('A', a), sideLine('B', b)]
  const first = diff.firstDivergence
  if (!first) {
    lines.push(report.caveat
      ? `no difference in the steps, but no agreement on outcome either: ${report.caveat}`
      : `no difference: all ${a.steps.length} tool calls agree on tool, status and argument`)
    return `${lines.join('\n')}\n`
  }
  const stepA = first.a === null ? undefined : a.steps[first.a]
  const stepB = first.b === null ? undefined : b.steps[first.b]
  const agreed = first.index === 0 ? 'no step before it' : first.index === 1 ? 'step 1 agrees' : `steps 1-${first.index} agree`
  lines.push(
    `first difference at step ${first.index + 1} (${why(first)}); ${agreed}:`,
    stepLine('A', stepA, stepB, a.steps.length),
    stepLine('B', stepB, stepA, b.steps.length),
  )
  if (stepA && stepB && stepA.text === stepB.text && stepA.fields.args !== stepB.fields.args) {
    lines.push(`  (the arguments differ after their first ${TEXT_LIMIT} characters)`)
  }
  const changed = diff.pairs.filter((pair) => pair.differences.length > 0).length
  lines.push(`overall: ${diff.pairs.length} paired (${changed} differ), ${diff.onlyInA.length} only in A, ${diff.onlyInB.length} only in B`)
  return `${lines.join('\n')}\n`
}
