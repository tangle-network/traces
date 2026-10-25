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
 * `subagentTools`, never added to the parent's totals. A trace with no
 * subagent records is unaffected — every one of those counts is zero.
 *
 * The sheet is NOT a span and cannot be cited. It is prepared context, and
 * `trace://` citations still resolve against the raw spans — which is why every
 * fact names its span ids rather than asking the reader to trust the sheet.
 */

import { createHash } from 'node:crypto'
import { canonicalJson } from './adapters/tool-io.js'
import { withholdContent } from './session-facts-withheld.js'
import {
  computeSessionMeasurements,
  operatingSamplesOf,
  STALL_MINUTES,
  type OperatingSamples,
  type SessionMeasurements,
} from './session-measurements.js'
export type {
  SessionMeasurements, ToolMeasurement, CoveredMeasurement, CompactionMeasurement, ContentFootprint,
  SessionWaste, FailingStreak, Stall, RepeatedCommands,
} from './session-measurements.js'
export type { SkillUseCount } from './skill-usage.js'

import { OPENINFERENCE_SPAN_KIND, TOOL_NAME } from '@tangle-network/agent-eval/trace-attributes'
import { type FirstFailure, ingestSpans, rankFirstFailure } from '@tangle-network/agent-eval/diagnosis'
import { ACTOR_ATTR, capText } from './adapters/conversation.js'
import { FACT_TEXT_CAP, rawContent, typedTurnsOf, isOwnAgentMessage, type SessionTurnFact, type TurnSignal, type TurnFoldState, type ExcludedTurn } from './session-turns.js'
import {
  INHERITED_SPAN_ATTR,
  SUBAGENT_SPAWN_ATTR,
  SUBAGENT_SPAWN_TASK_ATTR,
  SUBAGENT_TASK_ATTR,
  isSubagentSpan,
  isSynthesizedSpan as isSynthesizedByProvenance,
} from './adapters/provenance.js'
import { ATTR, SESSION_CWD_ATTR, sourceChannelUnavailable } from './attributes.js'
import { windowBounds, insideWindow, type WindowBounds } from './session-window.js'
import { groupByTrace, type TraceGroup } from './session-scopes.js'
import { needsPrice, routerPrices, sessionCost, sessionTokens, type SessionCost, type SessionTokens } from './execution.js'
import type { OtlpSpan } from './otlp.js'
import { readPullRequests, type PullRequestFacts } from './pull-request-facts.js'
import {
  AGENT_IDENTITY_KEYS,
  identityFieldsOf,
  mergeAgentIdentity,
  type AgentIdentityFact,
  type AgentIdentityLookup,
} from './session-identity.js'
import { commandTextFromInput, isCodeModeScript, simpleCommands } from './shell-commands.js'
export type { AgentIdentityFact, AgentIdentityLookup, AgentIdentitySource, AgentIdentitySourceName } from './session-identity.js'

/** Cache invalidation key for deterministic measurements and prepared analyst context. */
export const SESSION_FACTS_MEASUREMENT_VERSION = '9'

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
  /** Emit folded child sessions as separate facts, each counting only its own tokens and records. */
  readonly includeSubagents?: boolean
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
  /**
   * The kind of agent the call asked for: Claude Code's `subagent_type`
   * (`Explore`, `general-purpose`, …). Null when the call names none, and
   * under `--no-content`, since it is read from the call's input.
   */
  readonly agentType: string | null
  readonly startedAt: string
  /** The spawn span's status: `OK`, `ERROR`, or `UNSET` while still open. */
  readonly status: string
  /** The spawn call span, plus the subagent lifecycle span when one joined it. */
  readonly spanIds: readonly string[]
}

/** The tool calls of one name that a session's subagents made. */
export interface SubagentToolCount {
  readonly name: string
  readonly calls: number
  /** Calls that ended in error. */
  readonly failed: number
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

/** The repository a session worked in, as its spans name it. */
export interface SessionRepo {
  /** The normalized remote (`github.com/<owner>/<repo>`). */
  readonly repository: string
  readonly branch: string | null
  readonly commit: string | null
}

/** {@link SessionFacts.firstFailure}, with when the failing span ended. */
export type SessionFirstFailure = FirstFailure & { readonly at?: string }

/** Everything the spans of one session state, computed without a model. */
export interface SessionFacts {
  readonly schemaVersion: 1
  readonly kind: 'traces.session_facts'
  readonly traceId: string
  readonly sessionId: string | null
  readonly harness: string | null
  /** Recorded canonical span boundary for this session; child facts retain their original trace ID. */
  readonly rootSpanId: SessionFact<string>
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
  /**
   * The repository: `git.repository`, `git.branch` and `git.commit` on the
   * session's spans. The harness's own record when it kept one (Codex's
   * `session_meta`), else read from the checkout at the recorded cwd when the
   * session was read, so a branch can be the checkout's current one.
   */
  readonly repo: SessionFact<SessionRepo>
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
  /**
   * TOOL spans excluded because a subagent, not this agent, made the call, by
   * tool name with the calls that ended in error, most calls first. `spanIds`
   * lists every one, so the exclusion is checkable.
   */
  readonly subagentTools: SessionFact<readonly SubagentToolCount[]>
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
  /** Typed turns after the shared classifier: human, fleet, relay; metadata only. */
  readonly typedTurnCounts: SessionFact<readonly Pick<TurnActorCount, 'actor' | 'turns'>[]>
  /** The last message of the session's own agent, and of each subagent task. */
  readonly finalMessages: SessionFact<readonly FinalMessageFact[]>
  readonly changedFiles: SessionFact<readonly ChangedFileFact[]>
  /** The programs this session's own commands ran, most runs first: see {@link CommandCountFact}. */
  readonly commands: SessionFact<readonly CommandCountFact[]>
  /** Earliest span start among this session's own records. Not the session
   *  file's first record when the adapter selected a task boundary inside the
   *  file, and not a spawned subagent's first record. */
  readonly firstRecordAt: SessionFact<string>
  /** Latest span end among this session's own records. */
  readonly lastRecordAt: SessionFact<string>
  /**
   * The session's own agent's tokens (`execution.ts`): `input` is the whole
   * prompt, cache reads and writes included, on every harness. A subagent
   * folded into the trace is not counted, as `subagentTools` says of tools.
   */
  readonly tokens: SessionTokens
  /**
   * What the Router would charge for `tokens`, labelled `list price (Router rates)`,
   * or null with the reason. `priceReport` fills it; the sheet alone loads no price table.
   */
  readonly cost: SessionCost
  /** `tokens.input + tokens.output`, the one total every harness reports the same way. */
  readonly tokenTotal: SessionFact<number>
  /**
   * The session's first failure by agent-eval's fixed precedence: the innermost
   * ERROR span that ended first, else a failed `agent.outcome`, else `none`.
   * Failures that ended at the same instant are `ambiguous`, never guessed.
   */
  readonly firstFailure: SessionFirstFailure
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

/** The kind of agent a Claude Code `Task` (or `Agent`) call asked for, in its input. */
const SUBAGENT_TYPE_KEY = /"subagent_type"\s*:\s*"((?:[^"\\]|\\.)*)"/u

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
    const agentType = SUBAGENT_TYPE_KEY.exec(inputValue(span) ?? '')?.[1]
    spawns.push({
      taskName,
      taskNameUnavailable: taskName === null
        ? 'the spawn span carries no task name; the harness recorded none for this call'
        : null,
      agentType: agentType === undefined ? null : decodeJsonString(agentType),
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

/** Tool calls by name, with the ones that ended in error, most calls first. */
function toolCounts(spans: readonly OtlpSpan[]): SubagentToolCount[] {
  const rows = new Map<string, { calls: number; failed: number }>()
  for (const span of spans) {
    const row = rows.get(toolName(span)) ?? { calls: 0, failed: 0 }
    row.calls += 1
    if (span.status.code === 'ERROR') row.failed += 1
    rows.set(toolName(span), row)
  }
  return [...rows]
    .map(([name, row]) => ({ name, ...row }))
    .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name))
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
      text: capText(typeof span.attributes.content === 'string' ? span.attributes.content : '', FACT_TEXT_CAP),
      spanId: span.span_id,
    }))
}

/**
 * One program the session's commands ran. Each simple command a tool call ran
 * counts once (as `shell-commands.ts` splits a script), and so does each
 * `tools.exec_command` call a Codex code-mode script made, once per element of
 * a loop over literals.
 */
export interface CommandCountFact {
  /**
   * The program and, when its next word is a plain word, that word: `labctl
   * run`, `git push`, `pnpm test`. A program whose first argument is data
   * (`rg`, `cat`, `echo`, …) is named alone.
   */
  readonly command: string
  readonly runs: number
  /**
   * Runs known to have failed: the call ran this one command (a `cd` aside)
   * and ended in error, a non-zero exit on Codex and Claude Code. A command
   * that shared its call with others has the call's status, not its own, and
   * is not counted here.
   */
  readonly failed: number
  /** Runs inside a Codex code-mode script, which records the script's status, never the command's exit code. */
  readonly inScripts: number
  /** Each run {@link failed} counts, oldest first, with the exit code its output printed. */
  readonly nonZeroExits: readonly NonZeroExit[]
  /** The tool call of the latest run. */
  readonly lastSpanId: string
}

/** One run of a command that exited non-zero. */
export interface NonZeroExit {
  /** The code the output printed (`Process exited with code N`, `Exit code N`); null when it printed none. */
  readonly code: number | null
  /** Always false today: a code-mode script records its own status, never a command's. */
  readonly inScript: boolean
  readonly at: string
  readonly spanId: string
}

const EXIT_CODE = /^(?:Process exited with code|Exit code:?|Command failed with exit code)[ \t]+(-?\d+)\.?[ \t]*$/imu

/** The exit code a shell tool's output printed in its header, else null. */
function printedExitCode(span: OtlpSpan): number | null {
  const output = span.attributes['output.value']
  if (typeof output !== 'string') return null
  const end = output.indexOf('\nOutput:\n')
  const code = EXIT_CODE.exec(end >= 0 ? output.slice(0, end) : output.slice(0, 400))?.[1]
  return code === undefined ? null : Number(code)
}

/** Shell builtins that change the shell's own state and start no process: not commands of their own. */
const SHELL_STATE_BUILTINS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'unset', 'source', '.', ':', 'true', 'false', 'exit', 'shift', 'local', 'alias'])

/** Programs whose first argument is data, not a subcommand: named alone. */
const DATA_FIRST_PROGRAMS: ReadonlySet<string> = new Set([
  'awk', 'basename', 'cat', 'chmod', 'column', 'cp', 'curl', 'cut', 'date', 'diff', 'dirname', 'du', 'echo', 'egrep', 'fgrep', 'file',
  'find', 'grep', 'head', 'jq', 'kill', 'less', 'ln', 'ls', 'mkdir', 'mv', 'nl', 'open', 'printf', 'readlink', 'realpath', 'rg', 'rm',
  'sed', 'sleep', 'sort', 'stat', 'tail', 'tee', 'test', '[', 'touch', 'tr', 'uniq', 'wc', 'wget', 'which', 'xargs',
])

const PLAIN_WORD = /^[A-Za-z][\w:-]{0,39}$/u

/** `labctl run`, `git push`, `rg`: the name {@link CommandCountFact.command} groups a command by. */
function commandName(words: readonly string[]): string {
  const program = words[0]!.slice(words[0]!.lastIndexOf('/') + 1)
  const next = words[1]
  return next !== undefined && !DATA_FIRST_PROGRAMS.has(program) && PLAIN_WORD.test(next) ? `${program} ${next}` : program
}

/** The simple commands one tool call ran, and whether each failed when the call's status is that command's own. */
interface CallCommands {
  readonly commands: readonly (readonly string[])[]
  /** The call is a Codex code-mode script. */
  readonly inScript: boolean
  /**
   * Per command: true when the call ran it alone (a `cd` aside) and ended in
   * error, false when it ran it alone and ended OK, else null: a code-mode
   * script records its own status and never a command's, a command that shared
   * its call with others has the call's status, and a call still open has none.
   */
  readonly failed: readonly (boolean | null)[]
}

/** The commands a shell or code-mode tool call ran, or undefined for a call that ran none. */
function callCommands(span: OtlpSpan): CallCommands | undefined {
  const input = inputValue(span)
  const script = input === null ? undefined : commandTextFromInput(input)
  if (script === undefined) return undefined
  const inScript = isCodeModeScript(input!)
  const commands = simpleCommands(script)
  const programs = commands.flatMap((words, index) => (SHELL_STATE_BUILTINS.has(words[0]!) ? [] : [index]))
  const own = !inScript && programs.length === 1 && span.status.code !== 'UNSET' ? programs[0]! : -1
  return { commands, inScript, failed: commands.map((_, index) => (index === own ? span.status.code === 'ERROR' : null)) }
}

/**
 * The programs the session's own tool calls ran (inherited history left out),
 * most runs first. Null with the reason when no tool call kept its arguments:
 * which commands ran is then unknown, not none. A row names no span ids: one
 * program can run hundreds of times, and `--match` gives each run's span. The
 * fact's `spanIds` are every call that ran a command.
 */
function commandsOf(tools: readonly OtlpSpan[]): SessionFact<readonly CommandCountFact[]> {
  const own = tools.filter((span) => span.attributes[INHERITED_SPAN_ATTR] !== true)
  if (own.length > 0 && !own.some((span) => inputValue(span) !== null)) {
    return { value: null, spanIds: [], unavailable: 'no tool call recorded its arguments, so which commands ran cannot be read' }
  }
  const rows = new Map<string, { runs: number; failed: number; inScripts: number; nonZeroExits: NonZeroExit[]; lastSpanId: string }>()
  const spanIds: string[] = []
  for (const span of own) {
    const call = callCommands(span)
    if (call === undefined) continue
    let ran = false
    call.commands.forEach((words, index) => {
      if (SHELL_STATE_BUILTINS.has(words[0]!)) return
      ran = true
      const name = commandName(words)
      const row = rows.get(name) ?? { runs: 0, failed: 0, inScripts: 0, nonZeroExits: [], lastSpanId: span.span_id }
      row.runs += 1
      row.lastSpanId = span.span_id
      if (call.failed[index] === true) {
        row.failed += 1
        row.nonZeroExits.push({ code: printedExitCode(span), inScript: call.inScript, at: span.start_time, spanId: span.span_id })
      }
      if (call.inScript) row.inScripts += 1
      rows.set(name, row)
    })
    if (ran) spanIds.push(span.span_id)
  }
  const counts = [...rows]
    .map(([command, row]) => ({ command, ...row }))
    .sort((left, right) => right.runs - left.runs || left.command.localeCompare(right.command))
  return listFact(counts, spanIds)
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
  return groupByTrace(spans, options.includeSubagents)
    .sort((left, right) => compareIds(left.traceId, right.traceId))
    .map((group) => readSession(group.traceId, group.sessionId, group.spans, options, bounds).facts)
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
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
  /** The raw values behind `facts.measurements.modelCalls`, which `analyze` pools across sessions. */
  readonly operating: OperatingSamples
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
  const typedCounts = new Map<string, number>()
  for (const turn of typedTurns) typedCounts.set(turn.author, (typedCounts.get(turn.author) ?? 0) + 1)
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
  const operating = operatingSamplesOf(ownSpans, invoked)
  const receipts = spans.filter((span) => span.attributes[CORRUPTION_RECEIPT_VERSION_ATTR] !== undefined)
  const recordSpans = spans.filter(isRecordSpan).length
  const corruptionSpan = spans.find((span) => typeof span.attributes[CORRUPTION_COUNT_ATTR] === 'number')
  const cwdSpan = spans.find((span) => stringAttr(span, SESSION_CWD_ATTR) !== null)
  const repoSpan = spans.find((span) => stringAttr(span, ATTR.GIT_REPOSITORY) !== null)
  const firstFailure: SessionFirstFailure = ownSpans.length === 0
    ? { status: 'unknown', traceId, unsetCount: 0, reason: "no span of this session's own records" }
    : rankFirstFailure(ingestSpans(ownSpans, { contentIncluded: true }).spans)
  const failedSpan = firstFailure.status === 'found' ? ownSpans.find((span) => span.span_id === firstFailure.spanId) : undefined
  const agent = agentFact(spans, sessionId, harness, options.agentIdentity)

  const facts: SessionFacts = {
    schemaVersion: 1,
    kind: 'traces.session_facts',
    traceId,
    sessionId,
    harness,
    rootSpanId: spans.find((span) => span.parent_span_id === null)
      ? { value: spans.find((span) => span.parent_span_id === null)!.span_id, spanIds: [spans.find((span) => span.parent_span_id === null)!.span_id], unavailable: null }
      : { value: null, spanIds: [], unavailable: 'no recorded root span boundary' },
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
    repo: repoSpan
      ? {
          value: {
            repository: stringAttr(repoSpan, ATTR.GIT_REPOSITORY)!,
            branch: stringAttr(repoSpan, ATTR.GIT_BRANCH_NAME),
            commit: stringAttr(repoSpan, ATTR.GIT_COMMIT),
          },
          spanIds: [repoSpan.span_id],
          unavailable: null,
        }
      : {
          value: null,
          spanIds: [],
          unavailable: `no span carries ${ATTR.GIT_REPOSITORY}: the recorded cwd is not a checkout with a remote, or no longer exists`,
        },
    measurements: computeSessionMeasurements({ spans: ownSpans, records: ownSpans.filter(isRecordSpan), tools: invoked, sessionId, harness, operating }),
    toolCalls: {
      value: sourceChannelUnavailable(ownSpans, 'tool-calls') ? null : invoked.length,
      spanIds: invoked.map((span) => span.span_id),
      unavailable: sourceChannelUnavailable(ownSpans, 'tool-calls') ? 'The source does not record tool calls.' : null,
    },
    synthesizedToolSpans: {
      value: synthesized.length,
      spanIds: synthesized.map((span) => span.span_id),
      unavailable: null,
    },
    subagentTools: {
      value: toolCounts(subagentTools),
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
    humanTurns: sourceChannelUnavailable(ownSpans, 'human-turns') ? { value: null, spanIds: [], unavailable: 'The source does not record human turns.' } : listFact(humanTurns, humanTurns.map((turn) => turn.spanId)),
    excludedTurns: listFact(excludedTurns, excludedTurns.flatMap((entry) => entry.spanIds)),
    typedTurnCounts: sourceChannelUnavailable(ownSpans, 'human-turns') ? { value: null, spanIds: [], unavailable: 'The source does not record typed turns.' } : listFact([...typedCounts].map(([actor, turns]) => ({ actor, turns })), []),
    turnsByActor: listFact(
      [...actorCounts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([actor, spanIds]) => ({ actor, turns: spanIds.length, spanIds })),
      promptSpans.map((span) => span.span_id),
    ),
    finalMessages: listFact(finalMessages, finalMessages.map((entry) => entry.spanId)),
    changedFiles: changedFilesFact(files, truncatedInputs, unresolvedPaths),
    commands: commandsOf(invoked),
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
    firstFailure: failedSpan ? { ...firstFailure, at: failedSpan.end_time } : firstFailure,
    tokens,
    // Priced by `priceReport`, which loads the price table only when a session needs it.
    cost: sessionCost(tokens, undefined),
    tokenTotal: tokens.input === null
      ? { value: null, spanIds: [], unavailable: tokens.unavailable }
      : { value: tokens.input + (tokens.output ?? 0), spanIds: tokens.spanIds, unavailable: null },
    agent,
  }
  if (options.includeContent !== false) return { facts, spans, turns: typedTurns, operating }
  return { facts: withholdContent(facts), spans, turns: [], operating }
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

/**
 * The report with each session's `cost` priced from agent-runtime's price
 * table. The table is imported only when some session has tokens to price, so
 * a report with none, and every command that prints no cost, never loads it.
 */
export async function priceReport(report: SessionFactsReport): Promise<SessionFactsReport> {
  if (!report.sessions.some((session) => needsPrice(session.tokens))) return report
  const price = await routerPrices()
  return { ...report, sessions: report.sessions.map((session) => ({ ...session, cost: sessionCost(session.tokens, price) })) }
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
      for (const group of groupByTrace(spans, options.includeSubagents)) {
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

/** Characters of a message, command or reason a sheet line keeps. */
const SHEET_TEXT_CAP = 100

/** One line of `text`, at most `cap` characters, with `…` where it was cut. */
export function sheetText(text: string, cap = SHEET_TEXT_CAP): string {
  const line = text.trim().split('\n', 1)[0]!.replace(/\s+/gu, ' ')
  return line.length > cap || text.trim().includes('\n') ? `${line.slice(0, cap - 1)}…` : line
}

/** `MM-DD HH:MM` in UTC; a time no reader can parse is printed as recorded. */
export function utcMinute(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(5, 16).replace('T', ' ') : iso
}

/** `18 s` under a minute, `42 min`, or `3.1 h` from an hour up. */
export function minutesText(minutes: number): string {
  if (minutes > 0 && minutes < 1) return `${Math.round(minutes * 60)} s`
  return minutes < 60 ? `${Math.round(minutes)} min` : `${(minutes / 60).toFixed(1)} h`
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** `name 3, other 1, …`: the largest counts first, at most `keep` of them, each followed by its `note`. */
export function topCounts(counts: Readonly<Record<string, number>>, keep = 3, note: (name: string) => string = () => ''): string {
  const rows = Object.entries(counts).sort(([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName))
  return rows.slice(0, keep).map(([name, count]) => `${name} ${count}${note(name)}`).join(', ') + (rows.length > keep ? ', …' : '')
}

/** ` (2 failed, 1 in scripts)`, or nothing when both are zero. */
function failedNote(failed: number, inScripts: number): string {
  const parts = [...(failed > 0 ? [`${failed} failed`] : []), ...(inScripts > 0 ? [`${inScripts} in scripts`] : [])]
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

/** Programs the sheet's commands line names; `--format json` lists every one in `.commands.value`. */
const SHEET_COMMANDS = 5

/** `commands 556: labctl status 523, labctl run 9 (1 failed, 2 in scripts), …`; null for a session that ran none. */
function commandLine(facts: SessionFacts): string | null {
  const commands = facts.commands.value
  if (commands === null) return `commands unknown: ${facts.commands.unavailable}`
  if (commands.length === 0) return null
  const runs = commands.reduce((sum, row) => sum + row.runs, 0)
  const shown = commands.slice(0, SHEET_COMMANDS).map((row) => `${row.command} ${row.runs}${failedNote(row.failed, row.inScripts)}`)
  return `commands ${runs}: ${shown.join(', ')}${commands.length > SHEET_COMMANDS ? ', …' : ''}`
}

/**
 * The text sheet: at most 25 lines per session, each a fact a person reads
 * first. Times are UTC. A fact the spans cannot support says `unknown` with
 * the reason; `--format json` carries every value with its span ids.
 */
export function renderSessionFacts(report: SessionFactsReport): string {
  const lines: string[] = []
  const selection = report.selection
  if (selection !== null || report.sessions.length !== 1) {
    const window = selection && (selection.since !== null || selection.until !== null)
      ? ` · window ${selection.since ?? 'open'} → ${selection.until ?? 'open'}, ${selection.outsideWindow.length} read with no record inside it`
      : ''
    const unread = selection?.unreadSessions ?? []
    lines.push(`${plural(report.sessions.length, 'session')}${window}${unread.length > 0 ? ` · ${unread.length} unreadable` : ''} · $0, no model call`)
    for (const entry of unread.slice(0, 3)) {
      lines.push(`unreadable ${entry.sessionId ?? entry.traceId ?? entry.source ?? 'unknown'}: ${sheetText(entry.reason)}`)
    }
    if (unread.length > 3) lines.push(`… ${unread.length - 3} more unreadable: --format json | jq .selection.unreadSessions`)
  }
  for (const facts of report.sessions) {
    if (lines.length > 0) lines.push('')
    lines.push(...sessionSheet(facts))
  }
  return `${lines.join('\n')}\n`
}

function sessionSheet(facts: SessionFacts): string[] {
  const lines = [sheetHeader(facts)]
  if (facts.agent.value) lines.push(`who ${renderAgent(facts.agent.value)}`)
  lines.push(turnLine(facts))
  const subagents = facts.subagents.value ?? []
  const names = subagents.flatMap((entry) => (entry.taskName === null ? [] : [
    `${sheetText(entry.taskName, 40)}${entry.agentType ? ` [${sheetText(entry.agentType, 40)}]` : ''}`,
  ]))
  const failedCalls = new Map(facts.measurements.tools.map((row) => [row.name, row.outcomes.error]))
  lines.push(
    `tools ${facts.toolCalls.value}${facts.toolCalls.value ? ` (${topCounts(facts.toolCallsByName.value ?? {}, 3, (name) => failedNote(failedCalls.get(name) ?? 0, 0))})` : ''}` +
      ` · subagents ${subagents.length}${names.length > 0 ? ` (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})` : ''}`,
  )
  const subagentTools = facts.subagentTools.value ?? []
  if (subagentTools.length > 0) {
    const calls = Object.fromEntries(subagentTools.map((row) => [row.name, row.calls]))
    const failed = new Map(subagentTools.map((row) => [row.name, row.failed]))
    lines.push(`subagent tools ${facts.subagentTools.spanIds.length} (${topCounts(calls, 3, (name) => failedNote(failed.get(name) ?? 0, 0))}), not in the tools count`)
  }
  const commands = commandLine(facts)
  if (commands !== null) lines.push(commands)
  const skills = Object.fromEntries(Object.entries(facts.measurements.skills).map(([name, use]) => [name, use.model + use.slash + use.read]))
  if (Object.keys(skills).length > 0) lines.push(`skills ${topCounts(skills, 5)}`)
  lines.push(`tokens ${renderTokens(facts.tokens, facts.cost)}`)
  lines.push(wasteLine(facts))
  lines.push(pullRequestLine(facts))
  lines.push(`first failure ${renderFirstFailure(facts.firstFailure)}`)
  const final = facts.finalMessages.value?.find((message) => message.task === null)
  if (final && final.text.trim().length > 0) lines.push(`final "${sheetText(final.text)}"`)
  if ((facts.unreadRecords.value ?? 0) > 0) {
    lines.push(`unread records ${facts.unreadRecords.value}: the facts above are computed from the rest`)
  }
  return lines
}

/** `99d75d4b claude-code · agent-dev-container (feat/x) · 10-15 09:12→12:40 UTC · active 3.1 h`. */
function sheetHeader(facts: SessionFacts): string {
  const parts = [`${(facts.sessionId ?? facts.traceId).slice(0, 8)} ${facts.harness ?? 'unknown harness'}`]
  const repo = facts.repo.value
  const place = repo
    ? `${repo.repository.split('/').at(-1)}${repo.branch ? ` (${repo.branch})` : ''}`
    : facts.cwd.value?.split('/').filter(Boolean).at(-1)
  if (place) parts.push(place)
  const first = facts.firstRecordAt.value
  const last = facts.lastRecordAt.value
  if (first !== null && last !== null) {
    const [from, to] = [utcMinute(first), utcMinute(last)]
    parts.push(`${from}→${from.slice(0, 5) === to.slice(0, 5) ? to.slice(6) : to} UTC`)
  }
  const active = facts.measurements.activeMinutes.value
  if (active !== null) parts.push(`active ${minutesText(active)}`)
  if (facts.parentSessionId) parts.push(`child of ${facts.parentSessionId.slice(0, 8)}`)
  return parts.join(' · ')
}

/** `human turns 14 (excluded: fleet 2, injected 6) · interrupts 2`. */
function turnLine(facts: SessionFacts): string {
  const turns = facts.humanTurns.value
  if (turns === null) return `human turns unknown: ${facts.humanTurns.unavailable}`
  const excluded: Record<string, number> = {}
  for (const entry of facts.excludedTurns.value ?? []) excluded[entry.author] = (excluded[entry.author] ?? 0) + entry.turns
  const signalled = (signal: TurnSignal): number => turns.filter((turn) => turn.signals.includes(signal)).length
  return [
    `human turns ${turns.length}${Object.keys(excluded).length > 0 ? ` (excluded: ${topCounts(excluded, 6)})` : ''}`,
    `interrupts ${turns.filter((turn) => turn.interrupted).length}`,
    ...(signalled('rejected-tool') > 0 ? [`after a rejected tool ${signalled('rejected-tool')}`] : []),
    ...(signalled('after-claim') > 0 ? [`after a completion claim ${signalled('after-claim')}`] : []),
  ].join(' · ')
}

/** `waste 52 min: \`pnpm test\` failed 14× in a row (31 min) · 2 stalls ≥ 10 min (21 min) · reverts 1`. */
function wasteLine(facts: SessionFacts): string {
  const waste = facts.measurements.waste
  if (waste.minutes === null) return `waste unknown: ${waste.unavailable}`
  const parts: string[] = []
  const streaks = waste.failingStreaks.value ?? []
  const worst = [...streaks].sort((left, right) => right.minutes - left.minutes || right.runs - left.runs)[0]
  if (worst) {
    const command = worst.command === null ? `a ${worst.tool} command` : `\`${sheetText(worst.command, 60)}\``
    parts.push(`${command} failed ${worst.runs}× in a row (${minutesText(worst.minutes)})${streaks.length > 1 ? ` + ${plural(streaks.length - 1, 'more streak')}` : ''}`)
  }
  const stalls = waste.stalls.value ?? []
  if (stalls.length > 0) {
    parts.push(`${plural(stalls.length, 'stall')} ≥ ${STALL_MINUTES} min (${minutesText(stalls.reduce((sum, stall) => sum + stall.minutes, 0))})`)
  }
  if ((waste.rollbacks.value ?? 0) > 0) parts.push(`reverts ${waste.rollbacks.value}`)
  return `waste ${minutesText(waste.minutes)}${parts.length > 0 ? `: ${parts.join(' · ')}` : ''}`
}

/** `PRs opened #11021 #11022 · merged #11006 · changed 23 files`. */
function pullRequestLine(facts: SessionFacts): string {
  const files = facts.changedFiles.value === null ? '' : ` · changed ${plural(facts.changedFiles.value.length, 'file')}`
  const prs = facts.pullRequests.value
  if (prs === null) return `PRs unknown: ${facts.pullRequests.unavailable}${files}`
  const named = (entries: readonly { readonly identifier: string | null }[]): string => {
    const ids = entries.flatMap((entry) => entry.identifier === null ? [] : [/^\d+$/u.test(entry.identifier) ? `#${entry.identifier}` : entry.identifier])
    const unnumbered = entries.length - ids.length
    if (entries.length === 0) return 'none'
    return [...ids, ...(unnumbered > 0 ? [`${ids.length > 0 ? '+ ' : ''}${unnumbered} unnumbered`] : [])].join(' ')
  }
  return `PRs opened ${named(prs.created)} · merged ${named(prs.merged)}${files}`
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
  /** A `command` row only: whether the command failed, by the rule of {@link CommandCountFact.failed}; null when its call's status is not its own. */
  readonly failed?: boolean | null
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
  /** A `command` row only: see {@link SessionMatch.failed}. */
  readonly failed?: boolean | null
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
    const call = callCommands(span)
    if (call === undefined) continue
    call.commands.forEach((words, index) => {
      rows.push({ kind: 'command', at: span.start_time, spanId: span.span_id, text: words.join(' '), failed: call.failed[index] ?? null })
    })
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
    matches.push({
      sessionId, kind: row.kind, at: row.at, spanId: row.spanId, text: matchExcerpt(row.text, pattern),
      ...(row.kind === 'command' ? { failed: row.failed ?? null } : {}),
    })
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
function renderTokens(tokens: SessionTokens, cost: SessionCost): string {
  if (tokens.input === null) return `unknown: ${tokens.unavailable}`
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

export function renderFirstFailure(failure: SessionFirstFailure): string {
  if (failure.status === 'unknown') return `unknown: ${sheetText(failure.reason)}`
  if (failure.status === 'none') return `none: ${sheetText(failure.reason)}`
  if (failure.status === 'ambiguous') return `ambiguous ${failure.stage}: ${sheetText(failure.reason)} (spans ${failure.candidates.join(', ')})`
  const when = failure.at ? `${utcMinute(failure.at).slice(6)} ` : ''
  const message = failure.message ? `: ${sheetText(failure.message, 80)}` : ''
  return `${when}${failure.name}${message} (blame ${failure.blame}, span ${failure.spanId})`
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
      subagent_excluded: facts.subagentTools.spanIds.length,
      span_ids: facts.toolCalls.spanIds,
    },
    tool_calls_by_name: facts.toolCallsByName.value,
    subagents: {
      count: facts.subagents.value?.length ?? 0,
      entries: facts.subagents.value?.map((entry) => ({
        task_name: entry.taskName,
        ...(entry.taskNameUnavailable ? { task_name_unavailable: entry.taskNameUnavailable } : {}),
        ...(entry.agentType ? { agent_type: entry.agentType } : {}),
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

/** Only the typed turns and selection evidence, from the same fold as the full facts sheet. */
export function readSessionTurnGroups(spans: readonly OtlpSpan[], window?: SessionFactsWindow) {
  const bounds = windowBounds(window)
  return groupByTrace(spans).flatMap((group) => {
    const records = group.spans.filter(isRecordSpan)
    if (records.length > 0 && bounds !== null && !records.some((span) => insideWindow(bounds, span.start_time) || insideWindow(bounds, span.end_time))) return []
    const ordered = [...group.spans].sort(byTraceOrder)
    return [{
      sessionId: group.sessionId,
      records: records.length,
      harness: ordered.map((span) => stringAttr(span, 'service.name')).find((value) => value !== null) ?? null,
      cwd: ordered.map((span) => stringAttr(span, SESSION_CWD_ATTR)).find((value) => value !== null) ?? null,
      turns: typedTurnsOf(ordered).turns.filter((turn) => insideWindow(bounds, turn.at)),
    }]
  })
}
