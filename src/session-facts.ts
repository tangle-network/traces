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
 * Every fact below is about THE SESSION'S OWN AGENT. Some harnesses fold a
 * spawned agent's transcript into the parent's trace (Claude Code writes one
 * file per subagent under the session directory and the adapter reads them
 * all), so a trace can hold two kinds of record: what this session's agent did,
 * and what a child agent it spawned did. The child's work is the child's: it is
 * excluded from this sheet's counts, named in `subagents` and counted in
 * `subagentToolSpans`, never added to the parent's totals. A trace with no
 * subagent records is unaffected — every one of those counts is zero.
 *
 * The sheet is NOT a span and cannot be cited. It is prepared context, and
 * `trace://` citations still resolve against the raw spans — which is why every
 * fact names its span ids rather than asking the reader to trust the sheet.
 */

import { createHash } from 'node:crypto'
import { canonicalJson } from './adapters/tool-io.js'
import { computeSessionMeasurements, type SessionMeasurements } from './session-measurements.js'
export type { SessionMeasurements, ToolMeasurement, CoveredMeasurement, CompactionMeasurement, ContentFootprint } from './session-measurements.js'

import type { TraceAnalystDefinition } from '@tangle-network/agent-eval/analyst'
import { OPENINFERENCE_SPAN_KIND, TOOL_NAME } from '@tangle-network/agent-eval/trace-attributes'
import { type FirstFailure, ingestSpans, rankFirstFailure } from '@tangle-network/agent-eval/diagnosis'
import { authorOfTypedTurn, isHarnessCommand } from './adapters/actor.js'
import { ACTOR_ATTR } from './adapters/conversation.js'
import {
  INHERITED_SOURCE_ATTR,
  INHERITED_SPAN_ATTR,
  SUBAGENT_SPAWN_ATTR,
  SUBAGENT_SPAWN_TASK_ATTR,
  SUBAGENT_TASK_ATTR,
  isSubagentSpan,
  isSynthesizedSpan as isSynthesizedByProvenance,
} from './adapters/provenance.js'
import { indexSessionIdsByTrace, SESSION_CWD_ATTR } from './attributes.js'
import { sessionCost, sessionTokens, type SessionCost, type SessionTokens, type TokenPricer } from './execution.js'
export type { ModelTokens, SessionCost, SessionTokens, TokenPricer } from './execution.js'
import type { OtlpSpan } from './otlp.js'
import { readPullRequests, type PullRequestFacts } from './pull-request-facts.js'
import {
  AGENT_IDENTITY_KEYS,
  identityFieldsOf,
  mergeAgentIdentity,
  type AgentIdentityFact,
  type AgentIdentityLookup,
} from './session-identity.js'
import { commandLines, commandTextFromInput } from './shell-commands.js'
export type { AgentIdentityFact, AgentIdentityLookup, AgentIdentitySource, AgentIdentitySourceName } from './session-identity.js'

/** Cache invalidation key for deterministic measurements and prepared analyst context. */
export const SESSION_FACTS_MEASUREMENT_VERSION = '6'

/**
 * A half-open time window: a time `t` is inside when `since <= t < until`.
 * Either bound may be absent, which leaves that side open.
 */
export interface SessionFactsWindow {
  /** ISO-8601 lower bound, inclusive. */
  readonly since?: string
  /** ISO-8601 upper bound, exclusive. */
  readonly until?: string
}

export interface SessionFactsOptions {
  /** Defaults to true for compatibility. False withholds conversation, commands, paths and assignment text. */
  readonly includeContent?: boolean
  /**
   * Limit the turn facts to a time window. `humanTurns`, `excludedTurns` and
   * `turnsByActor` keep only `user.prompt` turns that started inside it; every
   * other fact still covers the whole session. A report built with a window
   * also leaves out every session with no record inside it, and names them in
   * {@link SessionFactsReport.selection}.
   */
  readonly window?: SessionFactsWindow
  /**
   * Who acted, from sources outside the spans (a session identity record),
   * consulted after the root span's own `agent.*` attributes. Without it the
   * `agent` fact reads the spans alone.
   */
  readonly agentIdentity?: AgentIdentityLookup
  /**
   * The price table `cost` is computed with: agent-runtime's `priceTokens`,
   * loaded by `routerPrices()`. Without it `cost` is null with that reason.
   */
  readonly price?: TokenPricer
}

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

/** Max characters of the agent message kept in {@link SessionTurnFact.answered}. */
export const ANSWERED_TEXT_CAP = 1500

/** Entries kept per list field before the sheet reports the rest as omitted. */
export const FACT_LIST_CAP = 200

/**
 * Entries kept for {@link SessionFacts.changedFiles}.
 *
 * The cap above bounds the sheet's size against lists whose entries carry up to
 * {@link FACT_TEXT_CAP} characters of message or prompt text. A changed-file
 * entry is a path and two short arrays, two orders of magnitude smaller, and a
 * session that edits hundreds of files is the one whose file list a reader most
 * needs whole — the rendered context prints only the count either way. So this
 * list gets its own ceiling, still finite so a runaway session cannot make the
 * sheet unbounded.
 */
export const CHANGED_FILE_LIST_CAP = 5000

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

/** One subagent-spawning call, with the task name the adapter recorded for it. */
export interface SubagentSpawnFact {
  /** The task name the spawn span carries, verbatim. Null when it carries none. */
  readonly taskName: string | null
  /** Why `taskName` is null. Null when it was recorded. */
  readonly taskNameUnavailable: string | null
  readonly startedAt: string
  /** The spawn span's status: `OK`, `ERROR`, or `UNSET` while still open. */
  readonly status: string
  /** The spawn call span, plus the subagent lifecycle span when one joined it. */
  readonly spanIds: readonly string[]
}

/**
 * A signal on a typed turn, counted since the person's previous
 * human turn (a fleet or relay turn in between does not reset it):
 *   - `interrupt`      the person interrupted the agent
 *   - `rejected-tool`  the person rejected a tool call
 *   - `after-claim`    the agent wrote since then, and its last message claims completion
 */
export type TurnSignal = 'interrupt' | 'rejected-tool' | 'after-claim'

/** Who typed a turn: a person, another agent or session relaying in (`fleet`), or a person pasting agent output (`relay`). */
export type TurnAuthor = 'human' | 'fleet' | 'relay'

/** One `user.prompt` turn, with the actor the adapter classified it as. */
export interface SessionTurnFact {
  readonly actor: string
  /** Who typed it. Always `human` in {@link SessionFacts.humanTurns}. */
  readonly author: TurnAuthor
  readonly at: string
  readonly text: string
  readonly spanId: string
  /**
   * The text of the last message this session's own agent wrote before the
   * turn: what the person was answering. Clipped to {@link ANSWERED_TEXT_CAP}
   * characters with a visible `… [+N chars]` marker. Null when the agent had
   * written no text before the turn.
   */
  readonly answered: string | null
  /** The `message.assistant` span `answered` was read from. */
  readonly answeredSpanId: string | null
  /**
   * The first message this session's own agent wrote after the turn, clipped
   * like `answered`. Null when it wrote none.
   */
  readonly reply: string | null
  /** The `message.assistant` span `reply` was read from. */
  readonly replySpanId: string | null
  /** The person interrupted the agent's work on this turn, before the next typed turn. */
  readonly interrupted: boolean
  /** The signals since the person's previous human turn; none on a `fleet` turn. */
  readonly signals: readonly TurnSignal[]
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
  /** Who wrote these turns: the reader's actor label, or the author the sheet assigned (`fleet`, `relay`). */
  readonly author: string
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
  /**
   * The session that spawned this one, when this is a spawned child read with
   * its parent. A child's numbers are its own; none is added to its parent's.
   */
  readonly parentSessionId: string | null
  /**
   * The working directory the harness recorded for the session, read from
   * `traces.session.cwd` on the adapter's root span. Null with the reason when
   * no span carries it; never decoded from a directory name or inferred from
   * the paths the session touched.
   */
  readonly cwd: SessionFact<string>
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
  /**
   * TOOL spans THIS session's agent invoked. Synthesized lifecycle spans and
   * the tool calls of subagents it spawned are excluded, and each exclusion is
   * counted below so the reader can add them back.
   */
  readonly toolCalls: SessionFact<number>
  /** Every synthesized span excluded from `toolCalls`, so the exclusion is checkable. */
  readonly synthesizedToolSpans: SessionFact<number>
  /** TOOL spans excluded because a subagent, not this agent, made the call. */
  readonly subagentToolSpans: SessionFact<number>
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
  /** Earliest span start among this session's own records. Not the session
   *  file's first record when the adapter selected a task boundary inside the
   *  file, and not a spawned subagent's first record. */
  readonly firstRecordAt: SessionFact<string>
  /** Latest span end among this session's own records. */
  readonly lastRecordAt: SessionFact<string>
  /**
   * The session's own agent's tokens (`execution.ts`): `input` is the whole
   * prompt, cache reads and writes included, on every harness. A subagent
   * folded into the trace is not counted, as `subagentToolSpans` says of tools.
   */
  readonly tokens: SessionTokens
  /** What the Router would charge for `tokens`, labelled `list price (Router rates)`, or null with the reason. */
  readonly cost: SessionCost
  /** `tokens.input + tokens.output`, the one total every harness reports the same way. */
  readonly tokenTotal: SessionFact<number>
  /**
   * The session's first failure by agent-eval's fixed precedence: the innermost
   * ERROR span that ended first, else a failed `agent.outcome`, else `none`.
   * Failures that ended at the same instant are `ambiguous`, never guessed.
   */
  readonly firstFailure: FirstFailure
  readonly measurements: SessionMeasurements
  /**
   * Who acted: the profile, model, harness, skill set and directive variant,
   * each from the first source that has it (the root span, then the session
   * identity record, then the directives log). Null with the reason when no
   * source names any.
   */
  readonly agent: SessionFact<AgentIdentityFact>
}

/** A session the report could not read, so whether it belongs in the window is unknown. */
export interface UnreadSessionFact {
  readonly sessionId: string | null
  readonly traceId: string | null
  /** Where the session was read from, when the reader knows. */
  readonly source: string | null
  readonly reason: string
}

/**
 * How a report chose its sessions and turns. Null on a report built without a
 * window that skipped no unreadable session.
 */
export interface SessionFactsSelection {
  /** The window's inclusive lower bound, or null when open. */
  readonly since: string | null
  /** The window's exclusive upper bound, or null when open. */
  readonly until: string | null
  /** Which sessions the report holds. */
  readonly sessionRule: string
  /** Which turns `humanTurns`, `excludedTurns` and `turnsByActor` hold. */
  readonly turnRule: string
  /** Sessions read in full whose records all fall outside the window, by session id. */
  readonly outsideWindow: readonly string[]
  /** Sessions that could not be read; each is named with the reason, never counted as empty. */
  readonly unreadSessions: readonly UnreadSessionFact[]
}

export interface SessionFactsReport {
  readonly schemaVersion: 1
  readonly kind: 'traces.session_facts_report'
  readonly generatedAt: string
  readonly measurementVersion: typeof SESSION_FACTS_MEASUREMENT_VERSION
  /**
   * SHA-256 over the selected sessions in trace-id order, each contributing the
   * SHA-256 of its canonical spans (content, attributes, links and timing).
   */
  readonly sourceDigest: string
  /** Latest recorded endpoint, not the last time the filesystem was checked. */
  readonly evidenceThrough: string | null
  readonly contentIncluded: boolean
  readonly harness: string | null
  readonly spanCount: number
  readonly selection: SessionFactsSelection | null
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

/**
 * The subagents THIS session's agent spawned, one entry per spawning call.
 *
 * `ownSpans` are the session's own records: a spawn a subagent itself made is
 * that subagent's, not this session's. `spans` is the whole trace, because the
 * lifecycle span a spawn joins to lives in the child's scope.
 */
function subagentsOf(ownSpans: readonly OtlpSpan[], spans: readonly OtlpSpan[]): SubagentSpawnFact[] {
  // A lifecycle span records the subagent's own path; joining it to the spawn
  // call by that path gives the reader both spans to check the task name with.
  const lifecycleByPath = new Map<string, string[]>()
  // An adapter that folds the child's transcript in parents the child's
  // lifecycle span under the spawn call itself, which is an exact join and
  // needs no name: two spawns may legitimately carry the same task name.
  const lifecycleByParent = new Map<string, string[]>()
  for (const span of spans) {
    if (!isSynthesizedSpan(span)) continue
    const path = stringAttr(span, 'traces.codex.subagent_path')
    if (path !== null) {
      lifecycleByPath.set(path, [...(lifecycleByPath.get(path) ?? []), span.span_id])
    }
    const parent = span.parent_span_id
    if (parent !== null && span.attributes[SUBAGENT_TASK_ATTR] !== undefined) {
      lifecycleByParent.set(parent, [...(lifecycleByParent.get(parent) ?? []), span.span_id])
    }
  }
  const spawns: SubagentSpawnFact[] = []
  for (const span of ownSpans) {
    const isSpawn =
      attr(span, 'traces.codex.agent_operation') === 'spawn_agent' ||
      stringAttr(span, 'traces.codex.spawn_agent_path') !== null ||
      attr(span, SUBAGENT_SPAWN_ATTR) === true
    if (!isSpawn || isSynthesizedSpan(span)) continue
    const taskName = stringAttr(span, 'traces.codex.spawn_agent_path') ?? stringAttr(span, SUBAGENT_SPAWN_TASK_ATTR)
    spawns.push({
      taskName,
      taskNameUnavailable: taskName === null
        ? 'the spawn span carries no task name; the harness recorded none for this call'
        : null,
      startedAt: span.start_time,
      status: span.status.code,
      spanIds: [
        span.span_id,
        ...(taskName ? lifecycleByPath.get(taskName) ?? [] : []),
        ...(lifecycleByParent.get(span.span_id) ?? []),
      ],
    })
  }
  return spawns
}

function finalMessagesOf(spans: readonly OtlpSpan[]): FinalMessageFact[] {
  const last = new Map<string | null, OtlpSpan>()
  for (const span of spans) {
    let task: string | null | undefined
    if (span.name === 'message.assistant') {
      // A folded subagent's transcript carries the same span name; the message
      // is that subagent's last word, not the session agent's.
      task = isSubagentSpan(span.attributes)
        ? stringAttr(span, SUBAGENT_TASK_ATTR) ?? 'unattributed subagent'
        : null
    } else if (span.name.startsWith('message.agent.')) {
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

function capList<T>(items: readonly T[], cap = FACT_LIST_CAP): { kept: readonly T[]; partial?: string } {
  if (items.length <= cap) return { kept: items }
  return {
    kept: items.slice(0, cap),
    partial: `${items.length - cap} of ${items.length} entries omitted; the count above the list is complete`,
  }
}

function listFact<T>(items: readonly T[], spanIds: readonly string[], cap = FACT_LIST_CAP): SessionFact<readonly T[]> {
  const { kept, partial } = capList(items, cap)
  return { value: kept, spanIds: [...new Set(spanIds)], unavailable: null, ...(partial ? { partial } : {}) }
}

/** The changed-files fact, stating every way the list is known to be short. */
function changedFilesFact(
  files: readonly ChangedFileFact[],
  truncatedInputs: number,
  unresolvedPaths: number,
): SessionFact<readonly ChangedFileFact[]> {
  const fact = listFact(files, files.flatMap((entry) => entry.spanIds), CHANGED_FILE_LIST_CAP)
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
    'a system reminder, a task or subagent notification, an interrupt or turn-aborted marker, or a skill or ' +
    'slash-command expansion',
  agent: 'a parent agent sent this prompt to this session; no person typed it',
  'subagent-spawn': 'the brief that spawned this run, written by the agent that spawned it',
  'tool-result': 'a tool result the harness surfaced as a user turn',
  fleet:
    'another agent or session sent this turn in: a fleet message, a session-to-session message, an ' +
    'operator handoff, or a lane brief (a first turn over 1,500 characters); no person typed it here',
  relay: "a person pasted another agent's output: a long, markdown-heavy turn after the session's first",
  unclassified: 'the span carries no actor, so whether a person typed it cannot be read from the spans',
}

const INHERITED_TURN_REASON =
  'context this session carries but did not receive: history copied from the parent when the session forked, ' +
  'or the turns a compaction retained. The person typed it into the parent thread, not into this session'

const DUPLICATE_TURN_REASON =
  'a second record of the turn before it: the same text at the same instant, with no model call, tool call ' +
  'or assistant message between them'

const SUBAGENT_TURN_REASON =
  'a turn inside a subagent this session spawned, not a turn of this session: the person addressed the ' +
  'session, and the brief and notifications the subagent received are the parent agent talking to it'

const HARNESS_COMMAND_REASON =
  'a command the person gave the harness (/model, /clear, …), not a message to the agent'

/**
 * An agent message that opens by claiming the work is done. A person's turn
 * right after one is the `after-claim` signal, and the live rule
 * `completion-claim-without-verification` fires on the same predicate.
 *
 * Only the opening sentence is read, with markdown marks removed, and a denial
 * or a question there is no claim. A status report that names a merged PR in
 * its fourth paragraph does not claim the work is done. Matching the word
 * anywhere put the signal on 57% of the Claude Code turns people typed, and on
 * a blind sample of flagged agent messages 44% were claims; reading the
 * opening sentence puts it on 17%, and 73% are claims (`bench/corrections/README.md`).
 */
const CLAIM_WORD =
  /\b(?:done|fixed|complete|completed|finished|implemented|merged|shipped|landed|resolved|verified|all green|tests pass(?:ed)?|ready|works now)\b/i
const CLAIM_DENIED =
  /\b(?:not|no|never|yet|still|cannot|can['’]?t|won['’]?t|isn['’]?t|aren['’]?t|wasn['’]?t|didn['’]?t|doesn['’]?t|hasn['’]?t|haven['’]?t|fail(?:s|ed|ing)?|broken|blocked)\b/i

/** A message's first sentence, without markdown marks or a leading list marker, at most 200 characters. */
function openingSentence(text: string): string {
  const plain = text.trimStart().replace(/[*_`#>]/g, '').replace(/^\s*(?:[-•→]|\d+[.)])\s+/u, '')
  const end = /[.!?:;](?=\s|$)|\n/.exec(plain)
  return (end ? plain.slice(0, end.index + end[0].length) : plain).slice(0, 200).trim()
}

/** True when an agent message's opening sentence claims completion, correctness or verification. */
export function isCompletionClaim(text: string): boolean {
  const opening = openingSentence(text)
  return CLAIM_WORD.test(opening) && !CLAIM_DENIED.test(opening) && !opening.endsWith('?')
}

/** The record a harness writes when the person stops the agent: Claude Code's marker, Codex's context block. */
const INTERRUPT_TEXT = /^(?:\[Request interrupted by user|<turn_aborted>)/iu

/** A tool result saying the person refused the call (Claude Code's refusal text, Codex's rejection). */
const REJECTED_TOOL_TEXT =
  /The user doesn't want to proceed with this tool use|tool use was rejected|rejected by (?:the )?user|user (?:rejected|declined|denied) (?:this|the)/iu

/** Spans that mean the agent acted: a person cannot have typed twice across one. */
function isAgentActivity(span: OtlpSpan): boolean {
  if (span.name === 'user.prompt') return false
  const kind = attr(span, OPENINFERENCE_SPAN_KIND)
  return kind === 'TOOL' || kind === 'LLM' || span.name === 'message.assistant' || span.name.startsWith('message.agent.')
}

function rawContent(span: OtlpSpan): string {
  return typeof span.attributes.content === 'string' ? span.attributes.content : ''
}

function turnText(span: OtlpSpan): string {
  return capText(rawContent(span))
}

function normalizedTurnText(span: OtlpSpan): string {
  return turnText(span).replace(/\s+/g, ' ').trim()
}

/** The `… [+N chars]` marker an adapter appends when it cut a message at capture. */
const CAPTURE_CUT_MARKER = /… \[\+(\d+) chars\]$/

/**
 * Clip an agent message to {@link ANSWERED_TEXT_CAP}. The marker counts every
 * character the reader does not see, including any the adapter already cut
 * when it captured the message.
 */
function clipAnswered(raw: string): string {
  const text = raw.trim()
  const marker = CAPTURE_CUT_MARKER.exec(text)
  const body = marker ? text.slice(0, marker.index) : text
  if (body.length <= ANSWERED_TEXT_CAP) return text
  // A cut between the halves of a surrogate pair leaves a lone high surrogate; drop it and count it hidden.
  const lastKept = body.charCodeAt(ANSWERED_TEXT_CAP - 1)
  const keep = lastKept >= 0xd800 && lastKept <= 0xdbff ? ANSWERED_TEXT_CAP - 1 : ANSWERED_TEXT_CAP
  const hidden = body.length - keep + (marker ? Number(marker[1]) : 0)
  return `${body.slice(0, keep)}… [+${hidden} chars]`
}

/** A message this session's own agent wrote, with text a person could have read. */
function isOwnAgentMessage(span: OtlpSpan): boolean {
  return (
    span.name === 'message.assistant' &&
    span.attributes[INHERITED_SPAN_ATTR] !== true &&
    rawContent(span).trim().length > 0
  )
}

/** A tool call of this session's agent that the person refused. */
function isRejectedTool(span: OtlpSpan): boolean {
  if (!isToolSpan(span) || span.status.code !== 'ERROR' || span.attributes[INHERITED_SPAN_ATTR] === true) return false
  const output = span.attributes['output.value']
  return REJECTED_TOOL_TEXT.test(`${span.status.message ?? ''}\n${typeof output === 'string' ? output.slice(0, 2000) : ''}`)
}

/** One excluded `user.prompt` span, with the time the window test reads. */
interface ExcludedTurn {
  readonly spanId: string
  readonly at: string
}

type MutableTurn = { -readonly [K in keyof SessionTurnFact]: SessionTurnFact[K] }

/** The typed turns of one session, and every `user.prompt` span left out of them. */
interface TypedTurns {
  /** Turns a person typed, or another agent or a pasted relay sent: `human`, `fleet` and `relay`. */
  readonly turns: readonly SessionTurnFact[]
  /** Excluded spans by `reason\0author`. */
  readonly excluded: ReadonlyMap<string, readonly ExcludedTurn[]>
  /** What the next span of the same session needs to be classified as if read in one piece. */
  readonly state: TurnFoldState
}

/**
 * What deciding a turn's author needs from the spans before it, so a session
 * read in pieces (the turn index reads only appended bytes) classifies each
 * turn exactly as one read of the whole session does.
 */
export interface TurnFoldState {
  /** A typed turn came before: the next one is not the session's first. */
  readonly typed: boolean
  /** The last human turn kept, for the second-record test: its start and normalized text. */
  readonly kept: { readonly at: string; readonly text: string } | null
  /** The agent acted after {@link TurnFoldState.kept}. */
  readonly activity: boolean
}

export const TURN_FOLD_START: TurnFoldState = { typed: false, kept: null, activity: false }

/**
 * The typed turns of one session, and every `user.prompt` span left out of them.
 *
 * Filters, in order: a turn of a subagent folded into this trace, a turn the
 * session inherited rather than received, a turn whose actor is not a person,
 * harness text the reader still called human, a harness command, and a second
 * record of the turn before it. A `fleet` or `relay` turn is a typed turn but
 * not a human one: it is listed with its author and excluded from the count.
 * `spans` is the whole trace in order, because the duplicate test, the reply
 * and the signals ask what happened between two turns. A session read in
 * pieces passes the `state` the previous piece returned.
 */
function typedTurnsOf(spans: readonly OtlpSpan[], start: TurnFoldState = TURN_FOLD_START): TypedTurns {
  const excluded = new Map<string, ExcludedTurn[]>()
  const drop = (reason: string, author: string, span: OtlpSpan): void => {
    const key = `${reason}\0${author}`
    excluded.set(key, [...(excluded.get(key) ?? []), { spanId: span.span_id, at: span.start_time }])
  }
  const turns: MutableTurn[] = []
  // The last human turn kept, and whether the agent acted since: a person cannot have typed twice across that.
  let kept = start.kept
  let activity = start.activity
  // The last message this session's agent wrote so far: what a turn answers.
  // Tracked over every span, so a turn just inside a time window still names
  // the message it answered when that message fell just outside it.
  let lastAgentMessage: OtlpSpan | null = null
  let lastTurn: MutableTurn | null = null
  // Turns the agent has not written a message after yet: its next one is their reply.
  let awaitingReply: MutableTurn[] = []
  // Signals since the person's previous human turn, and whether the agent wrote since it.
  let pending = new Set<TurnSignal>()
  let agentWroteSinceHuman = false
  for (const span of spans) {
    // A subagent's records are not this session's: its prompts are not turns
    // here, and its activity does not separate two turns of this session.
    if (isSubagentSpan(span.attributes)) {
      if (span.name === 'user.prompt') drop(SUBAGENT_TURN_REASON, stringAttr(span, ACTOR_ATTR) ?? 'unclassified', span)
      continue
    }
    if (span.name !== 'user.prompt') {
      if (isOwnAgentMessage(span)) {
        lastAgentMessage = span
        agentWroteSinceHuman = true
        for (const turn of awaitingReply) {
          turn.reply = clipAnswered(rawContent(span))
          turn.replySpanId = span.span_id
        }
        awaitingReply = []
      }
      if (isRejectedTool(span)) pending.add('rejected-tool')
      if (isAgentActivity(span)) activity = true
      continue
    }
    const actor = stringAttr(span, ACTOR_ATTR) ?? 'unclassified'
    if (span.attributes[INHERITED_SPAN_ATTR] === true) {
      const source = stringAttr(span, INHERITED_SOURCE_ATTR)
      drop(source === null ? INHERITED_TURN_REASON : `${INHERITED_TURN_REASON} (${source})`, actor, span)
      continue
    }
    const text = rawContent(span)
    if (INTERRUPT_TEXT.test(text.trim())) {
      pending.add('interrupt')
      if (lastTurn) lastTurn.interrupted = true
    }
    if (actor !== 'human') {
      drop(TURN_EXCLUSION_REASONS[actor] ?? `the adapter classified this turn as "${actor}", not as a person typing`, actor, span)
      continue
    }
    const author = authorOfTypedTurn(text, { firstTurn: !start.typed && turns.length === 0 })
    if (author === 'injected') {
      drop(TURN_EXCLUSION_REASONS.injected!, 'injected', span)
      continue
    }
    if (author === 'human' && isHarnessCommand(text)) {
      drop(HARNESS_COMMAND_REASON, 'human', span)
      continue
    }
    // Two records of ONE submission describe one instant, so they carry the
    // same start time; a person who sends the same short message twice is
    // seconds apart. Pairing records that are merely close is the adapter's
    // job, where the records themselves say which log each came from — a sheet
    // that guessed from the spans collapsed a measured "continue, continue"
    // typed 1.8 s apart into one turn.
    const normalized = normalizedTurnText(span)
    const duplicate =
      author === 'human' &&
      kept !== null &&
      kept.at === span.start_time &&
      kept.text === normalized &&
      normalized.length > 0 &&
      !activity
    if (duplicate) {
      drop(DUPLICATE_TURN_REASON, 'human', span)
      continue
    }
    const answered = lastAgentMessage ? rawContent(lastAgentMessage) : null
    if (agentWroteSinceHuman && answered !== null && isCompletionClaim(answered)) pending.add('after-claim')
    const turn: MutableTurn = {
      actor: 'human',
      author,
      at: span.start_time,
      text: turnText(span),
      spanId: span.span_id,
      answered: answered === null ? null : clipAnswered(answered),
      answeredSpanId: lastAgentMessage?.span_id ?? null,
      reply: null,
      replySpanId: null,
      interrupted: false,
      // A fleet message is another agent talking: a signal is a person's.
      signals: author === 'fleet' ? [] : SIGNAL_ORDER.filter((signal) => pending.has(signal)),
    }
    turns.push(turn)
    lastTurn = turn
    awaitingReply.push(turn)
    if (author === 'human') {
      kept = { at: span.start_time, text: normalized }
      activity = false
      pending = new Set()
      agentWroteSinceHuman = false
    } else {
      drop(TURN_EXCLUSION_REASONS[author]!, author, span)
    }
  }
  return { turns, excluded, state: { typed: start.typed || turns.length > 0, kept, activity } }
}

const SIGNAL_ORDER: readonly TurnSignal[] = ['interrupt', 'rejected-tool', 'after-claim']

/** The excluded turns inside the window, grouped by reason and author; a group left empty is dropped. */
function excludedTurnFacts(
  excluded: ReadonlyMap<string, readonly ExcludedTurn[]>,
  keep: (at: string) => boolean,
): ExcludedTurnFact[] {
  return [...excluded]
    .map(([key, entries]) => {
      const [reason, author] = key.split('\0') as [string, string]
      return { reason, author, spanIds: entries.filter((entry) => keep(entry.at)).map((entry) => entry.spanId) }
    })
    .filter((entry) => entry.spanIds.length > 0)
    .sort((left, right) => left.reason.localeCompare(right.reason) || left.author.localeCompare(right.author))
    .map(({ reason, author, spanIds }) => ({ reason, author, turns: spanIds.length, spanIds }))
}

/** Epoch bounds of a window; `null` when the window is absent or open on both sides. */
interface WindowBounds {
  readonly since: string | null
  readonly until: string | null
  readonly sinceMs: number
  readonly untilMs: number
}

function windowBounds(window: SessionFactsWindow | undefined): WindowBounds | null {
  if (!window || (window.since === undefined && window.until === undefined)) return null
  const bound = (value: string | undefined, name: string, open: number): number => {
    if (value === undefined) return open
    const ms = Date.parse(value)
    if (!Number.isFinite(ms)) throw new RangeError(`window ${name} is not a readable time: ${value}`)
    return ms
  }
  const sinceMs = bound(window.since, 'since', Number.NEGATIVE_INFINITY)
  const untilMs = bound(window.until, 'until', Number.POSITIVE_INFINITY)
  if (!(sinceMs < untilMs)) throw new RangeError(`window since (${window.since}) must be before until (${window.until})`)
  return {
    since: window.since === undefined ? null : new Date(sinceMs).toISOString(),
    until: window.until === undefined ? null : new Date(untilMs).toISOString(),
    sinceMs,
    untilMs,
  }
}

function insideWindow(bounds: WindowBounds | null, time: string): boolean {
  if (bounds === null) return true
  const ms = Date.parse(time)
  return Number.isFinite(ms) && ms >= bounds.sinceMs && ms < bounds.untilMs
}

/** A span the adapter built from one of the session's records: not the root, not an integrity receipt. */
function isRecordSpan(span: OtlpSpan): boolean {
  return span.parent_span_id !== null && span.attributes[CORRUPTION_RECEIPT_VERSION_ATTR] === undefined
}

/**
 * Compute the facts sheet for every trace in `spans`. One trace is one session.
 * Deterministic and free: the same spans always produce the same sheet, and no
 * model, network call, or budget is involved.
 */
export function computeSessionFacts(spans: readonly OtlpSpan[], options: SessionFactsOptions = {}): SessionFacts[] {
  const bounds = windowBounds(options.window)
  return groupByTrace(spans)
    .sort((left, right) => compareIds(left.traceId, right.traceId))
    .map((group) => readSession(group.traceId, group.sessionId, group.spans, options, bounds).facts)
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

interface TraceGroup {
  readonly traceId: string
  readonly sessionId: string | null
  readonly spans: OtlpSpan[]
}

function groupByTrace(spans: readonly OtlpSpan[]): TraceGroup[] {
  const { sessionByTrace } = indexSessionIdsByTrace(spans)
  const byTrace = new Map<string, OtlpSpan[]>()
  for (const span of spans) {
    const group = byTrace.get(span.trace_id)
    if (group) group.push(span)
    else byTrace.set(span.trace_id, [span])
  }
  return [...byTrace].map(([traceId, traceSpans]) => ({
    traceId,
    sessionId: sessionByTrace.get(traceId) ?? null,
    spans: traceSpans,
  }))
}

/**
 * One session as the sheet read it: its facts, its spans in trace order, and
 * every typed turn (`human`, `fleet`, `relay`) inside the window, which a
 * `--format jsonl` row and a `--match` search read.
 */
export interface SessionReading {
  readonly facts: SessionFacts
  readonly spans: readonly OtlpSpan[]
  readonly turns: readonly SessionTurnFact[]
}

function readSession(
  traceId: string,
  sessionId: string | null,
  unordered: readonly OtlpSpan[],
  options: SessionFactsOptions,
  bounds: WindowBounds | null,
): SessionReading {
  const spans = [...unordered].sort(byTraceOrder)
  const harness = spans.map((span) => stringAttr(span, 'service.name')).find((name) => name !== null) ?? null

  // The session's own records. A spawned subagent's transcript may be folded
  // into this trace; what it did is reported as the subagent's, never added to
  // the totals below.
  const ownSpans = spans.filter((span) => !isSubagentSpan(span.attributes))
  const toolSpans = spans.filter(isToolSpan)
  const synthesized = toolSpans.filter(isSynthesizedSpan)
  const invoked = ownSpans.filter((span) => isToolSpan(span) && !isSynthesizedSpan(span))
  const subagentTools = toolSpans.filter(
    (span) => isSubagentSpan(span.attributes) && !isSynthesizedSpan(span),
  )
  const byName: Record<string, number> = {}
  for (const span of invoked) byName[toolName(span)] = (byName[toolName(span)] ?? 0) + 1

  const subagents = subagentsOf(ownSpans, spans)
  const pullRequests = readPullRequests(ownSpans)
  // The turn facts honor the window; every other fact covers the whole session.
  const inWindow = (at: string): boolean => insideWindow(bounds, at)
  const promptSpans = spans.filter((span) => span.name === 'user.prompt' && inWindow(span.start_time))
  const turnFacts = typedTurnsOf(spans)
  const typedTurns = turnFacts.turns.filter((turn) => inWindow(turn.at))
  const humanTurns = typedTurns.filter((turn) => turn.author === 'human')
  const excludedTurns = excludedTurnFacts(turnFacts.excluded, inWindow)
  const actorCounts = new Map<string, string[]>()
  for (const span of promptSpans) {
    const actor = stringAttr(span, ACTOR_ATTR) ?? 'unclassified'
    actorCounts.set(actor, [...(actorCounts.get(actor) ?? []), span.span_id])
  }
  const finalMessages = finalMessagesOf(spans)
  const { files, truncatedInputs, unresolvedPaths } = changedFilesOf(invoked, ownSpans)

  const starts = ownSpans.filter((span) => Number.isFinite(Date.parse(span.start_time)))
  const ends = ownSpans.filter((span) => Number.isFinite(Date.parse(span.end_time)))
  const firstSpan = starts.reduce<OtlpSpan | null>(
    (best, span) => (best === null || Date.parse(span.start_time) < Date.parse(best.start_time) ? span : best),
    null,
  )
  const lastSpan = ends.reduce<OtlpSpan | null>(
    (best, span) => (best === null || Date.parse(span.end_time) > Date.parse(best.end_time) ? span : best),
    null,
  )

  const tokens = sessionTokens(ownSpans)
  const receipts = spans.filter((span) => span.attributes[CORRUPTION_RECEIPT_VERSION_ATTR] !== undefined)
  const recordSpans = spans.filter(isRecordSpan).length
  const corruptionSpan = spans.find((span) => typeof span.attributes[CORRUPTION_COUNT_ATTR] === 'number')
  const cwdSpan = spans.find((span) => stringAttr(span, SESSION_CWD_ATTR) !== null)
  const agent = agentFact(spans, sessionId, harness, options.agentIdentity)

  const facts: SessionFacts = {
    schemaVersion: 1,
    kind: 'traces.session_facts',
    traceId,
    sessionId,
    harness,
    parentSessionId: spans
      .filter((span) => span.parent_span_id === null)
      .map((span) => stringAttr(span, 'traces.parent_session_id'))
      .find((id) => id !== null) ?? null,
    cwd: cwdSpan
      ? { value: stringAttr(cwdSpan, SESSION_CWD_ATTR), spanIds: [cwdSpan.span_id], unavailable: null }
      : {
          value: null,
          spanIds: [],
          unavailable:
            `no span carries ${SESSION_CWD_ATTR}: the session source records no working directory, ` +
            'or the adapter that read it does not read one',
        },
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
    measurements: computeSessionMeasurements(ownSpans, invoked, sessionId, harness),
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
    subagentToolSpans: {
      value: subagentTools.length,
      spanIds: subagentTools.map((span) => span.span_id),
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
      : { value: null, spanIds: [], unavailable: "no span of this session's own records carries a parseable start time" },
    lastRecordAt: lastSpan
      ? { value: lastSpan.end_time, spanIds: [lastSpan.span_id], unavailable: null }
      : { value: null, spanIds: [], unavailable: "no span of this session's own records carries a parseable end time" },
    // rankFirstFailure throws on an empty list (distinct from "every span is
    // UNSET", which it reports as status 'unknown'); a trace whose spans are
    // all traces.span.subagent — every record folded into subagents' own
    // reports — legitimately has no records of its own to rank.
    firstFailure:
      ownSpans.length === 0
        ? { status: 'unknown', traceId, unsetCount: 0, reason: "no span of this session's own records" }
        : rankFirstFailure(ingestSpans(ownSpans, { contentIncluded: true }).spans),
    tokens,
    cost: sessionCost(tokens, options.price),
    tokenTotal: tokens.input === null
      ? { value: null, spanIds: [], unavailable: tokens.unavailable }
      : { value: tokens.input + (tokens.output ?? 0), spanIds: tokens.spanIds, unavailable: null },
    agent,
  }
  if (options.includeContent !== false) return { facts, spans, turns: typedTurns }
  const withheld = <T>(): SessionFact<T> => ({
    value: null, spanIds: [], unavailable: 'Content was not requested.',
  })
  const withheldFacts: SessionFacts = {
    ...facts,
    cwd: withheld(),
    humanTurns: withheld(),
    finalMessages: withheld(),
    changedFiles: withheld(),
    pullRequests: withheld(),
    subagents: {
      ...facts.subagents,
      value: facts.subagents.value?.map((entry) => ({
        ...entry, taskName: null, taskNameUnavailable: 'Assignment text was not requested.',
      })) ?? null,
    },
    firstFailure: facts.firstFailure.status === 'found'
      ? { ...facts.firstFailure, message: null, classification: facts.firstFailure.classification ? { ...facts.firstFailure.classification, reason: 'Content was not requested.' } : null }
      : facts.firstFailure,
  }
  return { facts: withheldFacts, spans, turns: [] }
}

/**
 * Who acted in one session: each identity key from the root span, else from
 * the sources `lookup` names, in that order. A supervised run has one identity
 * per node, so only the root span speaks for the session.
 */
function agentFact(
  spans: readonly OtlpSpan[],
  sessionId: string | null,
  harness: string | null,
  lookup: AgentIdentityLookup | undefined,
): SessionFact<AgentIdentityFact> {
  const root = spans.find((span) => span.parent_span_id === null)
  const fromSpans = root ? identityFieldsOf(root.attributes) : {}
  const outside = sessionId !== null && lookup ? lookup({ sessionId, harness }) : undefined
  const value = mergeAgentIdentity([{ source: 'spans', fields: fromSpans }, ...(outside?.sources ?? [])])
  if (value !== null) {
    return { value, spanIds: root && Object.keys(fromSpans).length > 0 ? [root.span_id] : [], unavailable: null }
  }
  return {
    value: null,
    spanIds: [],
    unavailable:
      `no root span carries ${AGENT_IDENTITY_KEYS.map(([, key]) => key).join(', ')}; ` +
      (outside?.reason ?? 'no source outside the spans was read'),
  }
}

export type SessionFactsReportOptions = SessionFactsOptions & {
  harness?: string | null
  generatedAt?: string
  /**
   * Name a session none of whose records could be read in
   * `selection.unreadSessions` and leave it out, as a window always does,
   * rather than report it. For a sweep, where one bad file must not end the run.
   */
  nameUnread?: boolean
  /** Called with each session the report selects, as it is read: its facts, spans and typed turns. */
  onSession?: (reading: SessionReading) => void
}

/** The facts sheet for a set of spans, as one report. */
export function buildSessionFactsReport(
  spans: readonly OtlpSpan[],
  options: SessionFactsReportOptions = {},
): SessionFactsReport {
  const builder = createSessionFactsReportBuilder(options)
  builder.add(spans)
  return builder.build()
}

/**
 * Builds one report from sessions supplied a batch at a time, so a caller
 * reading many sessions holds one session's spans at once rather than all of
 * them. `add` the whole spans of one or more sessions per call; a trace split
 * across two calls is reported as two sessions.
 */
export interface SessionFactsReportBuilder {
  add(spans: readonly OtlpSpan[]): void
  /** Name a session that could not be read at all: it is skipped, never counted as empty. */
  addUnread(session: UnreadSessionFact): void
  build(): SessionFactsReport
}

const WINDOW_SESSION_RULE =
  'a session is selected when at least one of its records starts or ends inside [since, until)'
const WINDOW_TURN_RULE =
  'humanTurns, excludedTurns and turnsByActor keep only user.prompt turns that started inside [since, until); ' +
  "every other fact, and each turn's answered text, covers the whole session"

const SWEEP_SESSION_RULE = 'the sessions the selection named or found; one that could not be read is named here and skipped'
const SWEEP_TURN_RULE = 'every turn of each selected session'

export function createSessionFactsReportBuilder(options: SessionFactsReportOptions = {}): SessionFactsReportBuilder {
  const bounds = windowBounds(options.window)
  const sessions: SessionFacts[] = []
  const digests: Array<{ traceId: string; digest: string }> = []
  const outsideWindow: string[] = []
  const unreadSessions: UnreadSessionFact[] = []
  let spanCount = 0
  let evidenceThrough: string | null = null

  const select = (group: TraceGroup): void => {
    const digest = createHash('sha256')
    for (const span of [...group.spans].sort((a, b) => a.span_id.localeCompare(b.span_id))) {
      digest.update(canonicalJson(span)).update('\n')
      for (const time of [span.start_time, span.end_time]) {
        if (Number.isFinite(Date.parse(time)) && (evidenceThrough === null || Date.parse(time) > Date.parse(evidenceThrough))) evidenceThrough = time
      }
    }
    digests.push({ traceId: group.traceId, digest: digest.digest('hex') })
    spanCount += group.spans.length
    const reading = readSession(group.traceId, group.sessionId, group.spans, options, bounds)
    sessions.push(reading.facts)
    options.onSession?.(reading)
  }

  return {
    add(spans) {
      for (const group of groupByTrace(spans)) {
        if (bounds === null && options.nameUnread !== true) {
          select(group)
          continue
        }
        const records = group.spans.filter(isRecordSpan)
        if (records.length === 0) {
          // Nothing was read, so nothing says what the session did, or whether
          // it belongs in the window; leaving it out silently would count it as empty.
          const unread = group.spans.find((span) => typeof span.attributes[CORRUPTION_COUNT_ATTR] === 'number')
          unreadSessions.push({
            sessionId: group.sessionId,
            traceId: group.traceId,
            source: null,
            reason: `no record could be read (${unread ? `${unread.attributes[CORRUPTION_COUNT_ATTR]} unread record(s)` : 'no record spans'})` +
              (bounds === null ? '' : ', so whether the session holds a record inside the window is unknown'),
          })
          continue
        }
        if (bounds === null || records.some((span) => insideWindow(bounds, span.start_time) || insideWindow(bounds, span.end_time))) select(group)
        else outsideWindow.push(group.sessionId ?? group.traceId)
      }
    },
    addUnread(session) {
      unreadSessions.push(session)
    },
    build() {
      const digest = createHash('sha256')
      for (const entry of [...digests].sort((a, b) => a.traceId.localeCompare(b.traceId) || a.digest.localeCompare(b.digest))) {
        digest.update(`${entry.traceId}\n${entry.digest}\n`)
      }
      return {
        schemaVersion: 1,
        kind: 'traces.session_facts_report',
        measurementVersion: SESSION_FACTS_MEASUREMENT_VERSION,
        sourceDigest: 'sha256:' + digest.digest('hex'),
        evidenceThrough,
        contentIncluded: options.includeContent !== false,
        generatedAt: options.generatedAt ?? new Date().toISOString(),
        harness: options.harness ?? null,
        spanCount,
        selection: bounds === null && unreadSessions.length === 0
          ? null
          : {
              since: bounds?.since ?? null,
              until: bounds?.until ?? null,
              sessionRule: bounds === null ? SWEEP_SESSION_RULE : WINDOW_SESSION_RULE,
              turnRule: bounds === null ? SWEEP_TURN_RULE : WINDOW_TURN_RULE,
              outsideWindow: [...outsideWindow].sort(compareIds),
              unreadSessions: [...unreadSessions],
            },
        // In the order they were selected: a named session first, each spawned
        // child after it in the order it started.
        sessions: [...sessions],
      }
    },
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
  const selection = report.selection
  if (selection) {
    lines.push(
      `window [${selection.since ?? 'open'}, ${selection.until ?? 'open'}): turn facts count only turns inside it; ` +
        `${selection.outsideWindow.length} session(s) read with no record inside it`,
    )
    for (const unread of selection.unreadSessions) {
      lines.push(`  unread session ${unread.sessionId ?? unread.traceId ?? unread.source ?? 'unknown'}: ${unread.reason}`)
    }
  }
  for (const facts of report.sessions) {
    lines.push('', `${facts.sessionId ?? facts.traceId} [${facts.harness ?? 'unknown harness'}] ${facts.spanCount} spans`)
    lines.push(factLine('cwd', facts.cwd, String(facts.cwd.value)))
    lines.push(factLine('who', facts.agent, facts.agent.value ? renderAgent(facts.agent.value) : ''))
    lines.push(
      factLine(
        'tool calls',
        facts.toolCalls,
        `${facts.toolCalls.value} (${facts.synthesizedToolSpans.value ?? 0} synthesized span(s) excluded` +
          `${(facts.subagentToolSpans.value ?? 0) > 0 ? `, ${facts.subagentToolSpans.value} made by subagents` : ''})`,
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
    const turns = facts.humanTurns.value ?? []
    const signalled = (signal: TurnSignal): number => turns.filter((turn) => turn.signals.includes(signal)).length
    lines.push(factLine(
      'human turns',
      facts.humanTurns,
      `${turns.length} (after an interrupt ${signalled('interrupt')}, after a rejected tool ${signalled('rejected-tool')}, ` +
        `after a completion claim ${signalled('after-claim')})`,
    ))
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
    lines.push(factLine('compactions', facts.measurements.compactions, String(facts.measurements.compactions.value?.length ?? 0)))
    lines.push('  skills: ' + facts.measurements.adoption.totalSkillInvocations + ' recorded invocation(s), ' + facts.measurements.adoption.totalSkillDocumentReads + ' document read(s); telemetry ' + facts.measurements.adoption.skillTelemetryStatus)
    lines.push(`  tokens: ${renderTokens(facts.tokens, facts.cost)}`)
    lines.push(`  first failure: ${renderFirstFailure(facts.firstFailure)}`)
    if ((facts.unreadRecords.value ?? 0) > 0) {
      lines.push(`  unread records: ${facts.unreadRecords.value} (the facts above are computed from the rest)`)
    }
    for (const message of facts.finalMessages.value ?? []) {
      lines.push(`  final message [${message.task ?? 'session agent'}]: ${message.text.split('\n')[0]?.slice(0, 160) ?? ''}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** What a `--match` row is: a turn a person typed, a message the agent wrote, or one shell command it ran. */
export type SessionMatchKind = 'human' | 'agent' | 'command'

/** Characters of text a `--match` row carries, around the first hit. */
export const MATCH_TEXT_CAP = 300

/** One hit of `traces facts --match`. */
export interface SessionMatch {
  readonly sessionId: string | null
  readonly kind: SessionMatchKind
  readonly at: string
  readonly spanId: string
  readonly text: string
}

/** `text` on one line, clipped to {@link MATCH_TEXT_CAP} characters around the first hit of `pattern`. */
function matchExcerpt(text: string, pattern: RegExp): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat.length <= MATCH_TEXT_CAP) return flat
  const at = pattern.exec(flat)?.index ?? 0
  let start = Math.max(0, Math.min(at - 100, flat.length - MATCH_TEXT_CAP))
  let end = start + MATCH_TEXT_CAP
  if (start > 0) start += 1
  if (end < flat.length) end -= 1
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** One row a `--match` search tests, with the whole text the pattern is tested on. */
export interface SessionRow {
  readonly kind: SessionMatchKind
  readonly at: string
  readonly spanId: string
  readonly text: string
}

/**
 * The rows of one session a `--match` search tests: each human turn, each
 * message the session's own agent wrote, and each simple command its shell
 * tool calls ran (as `shell-commands.ts` splits a script, so `^` anchors to a
 * command's start). Human turns first, then the rest in trace order. `spans`
 * is the session in trace order and `turns` its typed turns. A search over
 * parsed sessions and the turn index both take their rows from here.
 */
export function sessionRows(spans: readonly OtlpSpan[], turns: readonly SessionTurnFact[]): SessionRow[] {
  const rows: SessionRow[] = []
  const byId = new Map(spans.map((span) => [span.span_id, span]))
  for (const turn of turns) {
    const span = byId.get(turn.spanId)
    if (turn.author === 'human' && span) rows.push({ kind: 'human', at: span.start_time, spanId: span.span_id, text: rawContent(span) })
  }
  for (const span of spans) {
    if (isSubagentSpan(span.attributes)) continue
    if (isOwnAgentMessage(span)) {
      rows.push({ kind: 'agent', at: span.start_time, spanId: span.span_id, text: rawContent(span) })
      continue
    }
    if (!isToolSpan(span) || isSynthesizedSpan(span)) continue
    const script = commandTextFromInput(inputValue(span) ?? '')
    if (script === undefined) continue
    for (const line of commandLines(script)) rows.push({ kind: 'command', at: span.start_time, spanId: span.span_id, text: line })
  }
  return rows
}

/** The rows of one session that `pattern` matches inside `window`, oldest first, each clipped around its hit. */
export function matchRows(
  sessionId: string | null,
  rows: Iterable<SessionRow>,
  pattern: RegExp,
  window?: SessionFactsWindow,
): SessionMatch[] {
  const bounds = windowBounds(window)
  const matches: SessionMatch[] = []
  for (const row of rows) {
    if (!insideWindow(bounds, row.at)) continue
    pattern.lastIndex = 0
    if (!pattern.test(row.text)) continue
    pattern.lastIndex = 0
    matches.push({ sessionId, kind: row.kind, at: row.at, spanId: row.spanId, text: matchExcerpt(row.text, pattern) })
  }
  return matches.sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
}

/** Every hit of `pattern` in one session read (see {@link sessionRows}), inside `window` when one is given. No model, deterministic. */
export function sessionMatches(reading: SessionReading, pattern: RegExp, window?: SessionFactsWindow): SessionMatch[] {
  return matchRows(reading.facts.sessionId, sessionRows(reading.spans, reading.turns), pattern, window)
}

/** What the turn index keeps of a session it read, whole or one appended piece at a time. */
export interface SessionIndexRead {
  readonly sessionId: string | null
  readonly parentSessionId: string | null
  readonly cwd: string | null
  /** The earliest start and latest end of the session's own spans in this read. */
  readonly firstAt: string | null
  readonly lastAt: string | null
  /** Spans built from the session's records: not its root, not an integrity receipt. */
  readonly records: number
  /** The span ids of the human turns, in order. */
  readonly humanTurns: readonly string[]
  /** The first human turn, as {@link SessionFacts.humanTurns} words it. */
  readonly firstPrompt: string | null
  readonly rows: readonly SessionRow[]
  /** What the next piece of the same session starts from. */
  readonly state: TurnFoldState
}

/**
 * The facts `list` and a `--match` search need from one session's spans: the
 * same turns, rows and times the sheet computes, from the same functions, plus
 * the turn-fold state that lets the next appended piece continue where this
 * one ended. `sessionId` picks the session's trace when `spans` holds more.
 */
export function readSessionIndex(
  spans: readonly OtlpSpan[],
  options: { readonly sessionId?: string; readonly state?: TurnFoldState } = {},
): SessionIndexRead {
  const groups = groupByTrace(spans)
  const group = groups.find((entry) => entry.sessionId === options.sessionId) ?? groups[0]
  const ordered = [...(group?.spans ?? [])].sort(byTraceOrder)
  const own = ordered.filter((span) => !isSubagentSpan(span.attributes))
  const typed = typedTurnsOf(ordered, options.state)
  const human = typed.turns.filter((turn) => turn.author === 'human')
  let firstAt: string | null = null
  let lastAt: string | null = null
  for (const span of own) {
    if (Number.isFinite(Date.parse(span.start_time)) && (firstAt === null || Date.parse(span.start_time) < Date.parse(firstAt))) firstAt = span.start_time
    if (Number.isFinite(Date.parse(span.end_time)) && (lastAt === null || Date.parse(span.end_time) > Date.parse(lastAt))) lastAt = span.end_time
  }
  return {
    sessionId: group?.sessionId ?? null,
    parentSessionId: ordered
      .filter((span) => span.parent_span_id === null)
      .map((span) => stringAttr(span, 'traces.parent_session_id'))
      .find((id) => id !== null) ?? null,
    cwd: ordered.map((span) => stringAttr(span, SESSION_CWD_ATTR)).find((cwd) => cwd !== null) ?? null,
    firstAt,
    lastAt,
    records: ordered.filter(isRecordSpan).length,
    humanTurns: human.map((turn) => turn.spanId),
    firstPrompt: human[0]?.text ?? null,
    rows: sessionRows(ordered, typed.turns),
    state: typed.state,
  }
}

/** `in 2.1M · out 310k · cache read 88M · $38.20 list price (Router rates)`, or why a part is unknown. */
export function renderTokens(tokens: SessionTokens, cost: SessionCost): string {
  if (tokens.input === null) return `unavailable — ${tokens.unavailable}`
  const parts = [`in ${tokenCount(tokens.input)}`, `out ${tokenCount(tokens.output ?? 0)}`]
  if ((tokens.cacheRead ?? 0) > 0) parts.push(`cache read ${tokenCount(tokens.cacheRead!)}`)
  if ((tokens.cacheWrite ?? 0) > 0) parts.push(`cache write ${tokenCount(tokens.cacheWrite!)}`)
  parts.push(cost.usd === null ? `cost unknown (${cost.unavailable})` : `$${cost.usd.toFixed(cost.usd < 1 ? 4 : 2)} ${cost.label}`)
  return parts.join(' · ')
}

function tokenCount(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${Math.round(value / 1e3)}k`
  return String(value)
}

/** The `who:` line: profile and digest, model, directive variant. */
function renderAgent(agent: AgentIdentityFact): string {
  const digest = agent.profileDigest?.replace(/^(sha256:)?([0-9a-f]{4})[0-9a-f]+([0-9a-f]{4})$/u, (_, prefix: string | undefined, head: string, tail: string) => `${prefix ?? ''}${head}…${tail}`)
  const profile = [agent.profileName, digest].filter(Boolean).join(' ')
  return `${[profile, agent.model, agent.directiveVariant].filter(Boolean).join(' · ')} (from ${agent.source})`
}

function renderFirstFailure(failure: FirstFailure): string {
  if (failure.status === 'unknown') return `unknown — not recorded whether this run failed (${failure.reason})`
  if (failure.status === 'none') return `none recorded (${failure.reason})`
  if (failure.status === 'ambiguous') {
    return `ambiguous ${failure.stage}: ${failure.reason} (${failure.candidates.join(', ')})`
  }
  const message = failure.message ? ` — ${failure.message.split('\n')[0]?.slice(0, 160)}` : ''
  return `${failure.stage} ${failure.kind} "${failure.name}" [${failure.spanId}], blame ${failure.blame}${message}`
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
    ['human_turn_answered', (facts) => { for (const turn of facts.human_turns) delete turn.answered }],
    ['human_turn_text', (facts) => { for (const turn of facts.human_turns) delete turn.text }],
    ['final_message_text', (facts) => { for (const message of facts.final_messages) delete message.text }],
    ['pull_request_commands', (facts) => {
      for (const entry of [...(facts.pull_requests.created ?? []), ...(facts.pull_requests.merged ?? [])]) {
        delete entry.command
        delete entry.span_ids
      }
    }],
    ['tool_call_span_ids', (facts) => { facts.tool_calls.span_ids = [] }],
    ['measurements', (facts) => { delete facts.measurements }],
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
  cwd: unknown
  agent: unknown
  spans: number
  tool_calls: {
    count: number | null
    synthesized_excluded: number | null
    subagent_excluded: number | null
    span_ids: readonly string[]
  }
  tool_calls_by_name?: Readonly<Record<string, number>> | null
  subagents: { count: number; entries?: readonly unknown[] }
  pull_requests: CompactPullRequests
  human_turns: Array<{ at: string; span_id: string; text?: string; answered?: string | null }>
  excluded_turns?: readonly unknown[] | null
  turns_by_actor?: readonly unknown[] | null
  final_messages: Array<{ task: string | null; at: string; span_id: string; text?: string }>
  changed_files: { count: number; paths?: readonly unknown[]; partial?: string }
  first_record_at: unknown
  last_record_at: unknown
  token_total: unknown
  first_failure: Record<string, unknown>
  measurements?: SessionMeasurements
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
    cwd: factJson(facts.cwd),
    agent: factJson(facts.agent),
    spans: facts.spanCount,
    tool_calls: {
      count: facts.toolCalls.value,
      synthesized_excluded: facts.synthesizedToolSpans.value,
      subagent_excluded: facts.subagentToolSpans.value,
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
      answered: turn.answered,
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
    first_failure: compactFirstFailure(facts.firstFailure),
    measurements: facts.measurements,
  }
}

function compactFirstFailure(failure: FirstFailure): Record<string, unknown> {
  if (failure.status === 'unknown') {
    return { status: 'unknown', reason: failure.reason, unset_count: failure.unsetCount }
  }
  if (failure.status === 'none') return { status: 'none', reason: failure.reason }
  if (failure.status === 'ambiguous') {
    return { status: 'ambiguous', stage: failure.stage, reason: failure.reason, span_ids: failure.candidates }
  }
  return {
    status: 'found',
    stage: failure.stage,
    span_id: failure.spanId,
    name: failure.name,
    kind: failure.kind,
    blame: failure.blame,
    message: failure.message,
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
export const SESSION_FACTS_VERSION_SUFFIX = 'session-facts.' + SESSION_FACTS_MEASUREMENT_VERSION

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
