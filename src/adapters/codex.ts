/**
 * OpenAI Codex adapter — `~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl`.
 *
 * Line types: `session_meta` (id + cwd), `turn_context`, `event_msg`
 * (carries `token_count` with per-turn `last_token_usage`), and
 * `response_item` (the OpenAI Responses items: `message`, `reasoning`,
 * function/custom tool calls, and their outputs). Current Codex builds also
 * emit `sub_agent_activity` events for delegated agents.
 *
 * Token trajectory comes from the `token_count` deltas (Codex puts usage
 * on events, not on the message). Tools come from `function_call`, with
 * status backfilled from the matching `function_call_output`.
 *
 * Shared by the codex-acp wrapper via alias (same rollout format).
 */

import { type SourceReferences, sourceOf, textSources } from '../source-location.js'

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { deriveHexId } from '@tangle-network/agent-trace-contract'
import { sessionJsonlOptions } from '../integrity.js'
import { isMissingPathError } from '../json.js'
import { readJsonl, takeJsonl } from '../jsonl.js'
import type { OtlpSpan } from '../otlp.js'
import { span } from '../otlp.js'
import type {
  HarnessTraceAdapter,
  LocateOptions,
  ParentTaskResolution,
  ParseOptions,
  SessionRef,
  SpawnedChildResolution,
} from '../types.js'
import { codexActor } from './actor.js'
import { ACTOR_ATTR, capText, userPromptSpan } from './conversation.js'
import {
  type CodexCommandExecution,
  codexCompletedItem,
  type CodexFileChange,
  type CodexLine,
  codexSubagentActivity,
  type CodexTokenUsage,
  contentTextBlocks,
  contentToString,
  latestTimestamp,
  multiAgentOperation,
  spawnedSessionIds,
  targetedSessionIds,
  timestampFromEpochMs,
  validTimestamp,
} from './codex-format.js'
import {
  type CodexTaskBoundary,
  CodexTaskScopeError,
  codexTaskBoundary,
  currentTaskStartedAt,
  findForkTaskBoundary,
  findLatestTaskBoundary,
  isCodexTaskBoundary,
  resolveCodexParentTask,
} from './codex-task-scope.js'
import { INNER_TOOL_CALL_LEVEL, recordToolOutput, TOOL_CALL_LEVEL_ATTR, toolIoAttributes } from './tool-io.js'

export { CodexTaskScopeError } from './codex-task-scope.js'

const SERVICE = 'codex'
const SESSION_HEAD_LINES = 40

const CODEX_SOURCE_TRACE_ID = 'traces.codex.source_trace_id'
const CODEX_SOURCE_SPAN_ID = 'traces.codex.source_span_id'
const CODEX_SOURCE_PARENT_SPAN_ID = 'traces.codex.source_parent_span_id'

/** Convert Codex's readable span identities to fixed-width OTLP wire IDs. */
function normalizeCodexIds(spans: OtlpSpan[]): void {
  for (const item of spans) {
    const sourceTraceId = item.trace_id
    const sourceSpanId = item.span_id
    const sourceParentSpanId = item.parent_span_id
    item.attributes[CODEX_SOURCE_TRACE_ID] = sourceTraceId
    item.attributes[CODEX_SOURCE_SPAN_ID] = sourceSpanId
    if (sourceParentSpanId !== null) {
      item.attributes[CODEX_SOURCE_PARENT_SPAN_ID] = sourceParentSpanId
    }
    item.trace_id = deriveHexId(sourceTraceId, 16)
    item.span_id = deriveHexId(`${sourceTraceId}:${sourceSpanId}`, 8)
    item.parent_span_id = sourceParentSpanId === null
      ? null
      : deriveHexId(`${sourceTraceId}:${sourceParentSpanId}`, 8)
  }
}

function tokenUsageSignature(usage: CodexTokenUsage): string {
  return JSON.stringify([
    usage.input_tokens ?? null,
    usage.cached_input_tokens ?? null,
    usage.cache_write_input_tokens ?? null,
    usage.output_tokens ?? null,
    usage.reasoning_output_tokens ?? null,
    usage.total_tokens ?? null,
  ])
}

/** A message's text (verbatim string body or joined text blocks), trimmed and capped. */
function textOf(content: unknown): string {
  return capText(contentToString(content))
}

function numericStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const code = Number(value)
    if (Number.isSafeInteger(code)) return code
  }
  return undefined
}

function explicitOutputError(value: unknown, timeoutIsError = true): boolean | undefined {
  if (Array.isArray(value)) {
    let observedSuccess = false
    for (const item of value) {
      const status = explicitOutputError(item, timeoutIsError)
      if (status === true) return true
      if (status === false) observedSuccess = true
    }
    return observedSuccess ? false : undefined
  }

  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    let observedSuccess = false
    for (const key of ['is_error', 'isError', 'error']) {
      if (row[key] === true) return true
      if (row[key] === false) observedSuccess = true
    }
    for (const key of ['exit_code', 'exitCode']) {
      const code = numericStatus(row[key])
      if (code !== undefined && code !== 0) return true
      if (code === 0) observedSuccess = true
    }
    for (const key of ['timed_out', 'timedOut']) {
      if (row[key] === true && timeoutIsError) return true
    }
    if (typeof row.succeeded === 'boolean' && ('value' in row || 'error' in row)) {
      if (!row.succeeded) return true
      observedSuccess = true
    }
    if ((row.type === 'input_text' || row.type === 'text') && typeof row.text === 'string') {
      const status = explicitOutputError(row.text, timeoutIsError)
      if (status === true) return true
      if (status === false) observedSuccess = true
    }
    return observedSuccess ? false : undefined
  }

  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return undefined
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      const parsedStatus = explicitOutputError(JSON.parse(text) as unknown, timeoutIsError)
      if (parsedStatus !== undefined) return parsedStatus
    } catch {
      // Some tools return ordinary source text that begins with a brace.
    }
  }
  const outputStart = text.indexOf('\nOutput:\n')
  const header = outputStart >= 0 ? text.slice(0, outputStart) : text
  if (/^(?:Chunk ID:|Process exited with code )/i.test(header)) {
    const exitCode = numericStatus(header.match(/^Process exited with code[ \t]+(-?\d+)[ \t]*$/im)?.[1])
    if (exitCode !== undefined) return exitCode !== 0
  }
  // Receipts print either "Wall time: 1.2 seconds" or "Wall time 1.2 seconds".
  if (/^Script completed\s*\nWall time\b/i.test(header)) return false
  if (/^Script failed\s*\nWall time\b/i.test(header)) return true
  const scriptExitCode = numericStatus(header.match(/^Script error:[ \t]*\r?\nExit code:[ \t]*(-?\d+)[ \t]*(?:\r?\n|$)/i)?.[1])
  if (scriptExitCode !== undefined) return scriptExitCode !== 0
  const commandExitCode = numericStatus(text.match(/^Command failed with exit code[ \t]+(-?\d+)\.?$/i)?.[1])
  if (commandExitCode !== undefined) return commandExitCode !== 0
  if (/^<tool_error>[\s\S]*<\/tool_error>$/i.test(text)) return true
  return undefined
}

function explicitTimeout(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(explicitTimeout)
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    if (row.timed_out === true || row.timedOut === true) return true
    if ((row.type === 'input_text' || row.type === 'text') && typeof row.text === 'string') {
      return explicitTimeout(row.text)
    }
    return false
  }
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!text || !((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']')))) {
    return false
  }
  try {
    return explicitTimeout(JSON.parse(text) as unknown)
  } catch {
    return false
  }
}

function isWaitAgentOperation(name: string): boolean {
  return name === 'wait_agent' || name.endsWith('__wait_agent')
}

/** Only protocol-level status fields count; arbitrary tool output may itself contain code or logs mentioning errors. */
function outputStatus(
  name: string,
  source: NonNullable<CodexLine['payload']>,
): { status: OtlpSpan['status']; pollOutcome?: 'timeout' } {
  const output = source.output
  const waitAgent = isWaitAgentOperation(name)
  // Error metadata on the source envelope is authoritative. An `error` string
  // inside arbitrary output remains domain data, not execution status.
  const sourceError = source.is_error === true || source.isError === true
    || (source.error !== undefined && source.error !== null && source.error !== false)
  const outputError = explicitOutputError(output, !waitAgent)
  const error = sourceError || outputError === true
  const pollTimeout = !error && waitAgent && explicitTimeout(output)
  const code = error ? 'ERROR'
    : outputError === false || source.is_error === false || source.isError === false || pollTimeout ? 'OK'
      : 'UNSET'
  const message = sourceError ? source.error ?? output : output
  return {
    status: {
      code,
      ...(error ? { message: (typeof message === 'string' ? message : JSON.stringify(message ?? '')).slice(0, 500) } : {}),
    },
    ...(pollTimeout ? { pollOutcome: 'timeout' as const } : {}),
  }
}

/** A custom `exec` call is a small JavaScript program around one or more real tools. */
function singleNestedToolName(input: string | undefined): string | null {
  if (!input) return null
  const names = [...input.matchAll(/\btools\.([A-Za-z][A-Za-z0-9_]*)\s*\(/g)].map((match) => match[1]!)
  const unique = [...new Set(names)]
  return unique.length === 1 ? unique[0]! : null
}

function toolInputToString(input: unknown): string | undefined {
  if (typeof input === 'string') return input
  if (input == null) return undefined
  return JSON.stringify(input)
}

function agentRequestId(output: unknown, depth = 3): string | undefined {
  if (depth < 0 || output == null) return undefined
  if (typeof output === 'string') {
    try {
      return agentRequestId(JSON.parse(output) as unknown, depth - 1)
    } catch {
      return undefined
    }
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = agentRequestId(item, depth - 1)
      if (found) return found
    }
    return undefined
  }
  if (typeof output !== 'object') return undefined
  const record = output as Record<string, unknown>
  for (const key of ['submission_id', 'submissionId', 'request_id', 'requestId']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  for (const value of Object.values(record)) {
    const found = agentRequestId(value, depth - 1)
    if (found) return found
  }
  return undefined
}

/**
 * The agent path a `spawn_agent` call names, from either side of the call.
 *
 * Codex spells it `task_name` in the arguments and the result, and `agent_path` in the child's
 * own `session_meta`; the value is identical (`/root/c1_b_grid`). A leading slash is kept, so the
 * comparison is exact and never a prefix match.
 */
export function spawnAgentPath(value: unknown, depth = 4): string | undefined {
  if (depth < 0 || value == null) return undefined
  if (typeof value === 'string') {
    try {
      return spawnAgentPath(JSON.parse(value) as unknown, depth - 1)
    } catch {
      return undefined
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = spawnAgentPath(item, depth - 1)
      if (found) return found
    }
    return undefined
  }
  if (typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['task_name', 'agent_path', 'taskName', 'agentPath']) {
    const found = record[key]
    if (typeof found === 'string' && found.length > 0) return found
  }
  for (const nested of Object.values(record)) {
    const found = spawnAgentPath(nested, depth - 1)
    if (found) return found
  }
  return undefined
}

function setAgentSessionIds(toolSpan: OtlpSpan, ids: readonly string[]): void {
  if (ids.length === 0) return
  const unique = [...new Set(ids)]
  toolSpan.attributes['traces.codex.agent_session_ids'] = JSON.stringify(unique)
  toolSpan.attributes['traces.codex.agent_session_count'] = unique.length
  if (toolSpan.attributes['traces.codex.agent_operation'] === 'spawn_agent') {
    toolSpan.attributes['traces.child_session_ids'] = JSON.stringify(unique)
  }
}

interface SubagentLifecycleEntry {
  kind: string
  at: string
  eventId?: string
}

function recordSubagentLifecycle(
  agentSpan: OtlpSpan,
  kind: string,
  at: string,
  eventId?: string,
): void {
  const raw = agentSpan.attributes['traces.codex.subagent_lifecycle']
  let entries: SubagentLifecycleEntry[] = []
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) entries = parsed as SubagentLifecycleEntry[]
    } catch {
      // A malformed prior attribute should not hide the current lifecycle event.
    }
  }
  const entry = { kind, at, ...(eventId ? { eventId } : {}) }
  if (entries.some((current) =>
    current.kind === entry.kind
    && current.at === entry.at
    && current.eventId === entry.eventId
  )) return
  entries.push(entry)
  agentSpan.attributes['traces.codex.subagent_lifecycle'] = JSON.stringify(entries)
  if (kind === 'interrupted') {
    const count = agentSpan.attributes['traces.codex.subagent_interruption_count']
    agentSpan.attributes['traces.codex.subagent_interruption_count'] =
      (typeof count === 'number' ? count : 0) + 1
  }
}

function closeSpanAt(target: OtlpSpan, sourceEndTime: string): void {
  const start = Date.parse(target.start_time)
  const end = Date.parse(sourceEndTime)
  if (Number.isFinite(start) && Number.isFinite(end) && end < start) {
    target.end_time = target.start_time
    target.attributes['traces.clock_skew_detected'] = true
    target.attributes['traces.source_end_time'] = sourceEndTime
    return
  }
  const currentEnd = Date.parse(target.end_time)
  if (
    Number.isFinite(start)
    && Number.isFinite(end)
    && Number.isFinite(currentEnd)
    && currentEnd > start
    && end < currentEnd
  ) {
    target.attributes['traces.clock_skew_detected'] = true
    target.attributes['traces.source_end_time'] = sourceEndTime
    return
  }
  target.end_time = sourceEndTime
}

/** The item types the adapter turns into inner spans; user messages take the turn path instead. */
type InnerItemType = 'CommandExecution' | 'FileChange'

/**
 * An inner span built at the moment its item was read, waiting only for the
 * complete map of tool-call windows to place it. Retaining the span rather than
 * the parsed item keeps adapter memory bounded by span count instead of by
 * total raw command output: `toolIoAttributes` already capped the command text
 * and the command output when the span was built.
 */
interface PendingInnerSpan {
  readonly span: OtlpSpan
  readonly startMs: number
  readonly endMs: number
}

/** The time window of a model-issued call: its call record to its output record. */
interface ToolWindow {
  readonly startMs: number
  readonly endMs: number
}

/**
 * How an item was placed. Codex item IDs never equal call IDs, so an item joins
 * the one call whose window contains the item's whole run. An item that ran
 * past every window (a command left running, then polled) or sits inside two
 * windows (parallel calls) stays under the session root instead of a guess.
 */
type ItemJoin = 'call' | 'unmatched' | 'ambiguous'

function joinItem(
  windows: ReadonlyMap<OtlpSpan, ToolWindow>,
  startMs: number,
  endMs: number,
): { parent?: OtlpSpan; join: ItemJoin } {
  const matches: OtlpSpan[] = []
  for (const [toolSpan, window] of windows) {
    if (window.startMs <= startMs && endMs <= window.endMs) matches.push(toolSpan)
  }
  if (matches.length === 1) return { parent: matches[0], join: 'call' }
  return { join: matches.length === 0 ? 'unmatched' : 'ambiguous' }
}

function itemTimes(
  item: { readonly startedAtMs?: number; readonly completedAtMs?: number },
  recordTime: string,
): { start: string; end: string; timeSource?: 'completed_only' | 'record' } {
  const end = timestampFromEpochMs(item.completedAtMs) ?? recordTime
  const start = timestampFromEpochMs(item.startedAtMs) ?? end
  if (item.startedAtMs !== undefined && item.completedAtMs !== undefined) return { start, end }
  return { start, end, timeSource: item.completedAtMs === undefined ? 'record' : 'completed_only' }
}

function itemStatus(
  status: string | undefined,
  noun: string,
  exitCode?: number,
): { code: OtlpSpan['status']['code']; message?: string } {
  if (exitCode !== undefined && exitCode !== 0) return { code: 'ERROR', message: `${noun} exited ${exitCode}` }
  if (status === 'failed' || status === 'declined') return { code: 'ERROR', message: `${noun} ${status}` }
  if (exitCode === 0 || status === 'completed') return { code: 'OK' }
  return { code: 'UNSET' }
}

function itemSources(item: object, fields: readonly string[]) {
  return fields.flatMap((field) => {
    const reference = sourceOf(item, field)
    return reference ? [reference] : []
  })
}

function innerItemAttributes(
  type: InnerItemType,
  itemId: string,
  timeSource: string | undefined,
  status: string | undefined,
): Record<string, unknown> {
  return {
    // Existing OTLP importers classify this marker as a container, not a call.
    'span.type': 'tool.execution',
    [TOOL_CALL_LEVEL_ATTR]: INNER_TOOL_CALL_LEVEL,
    'traces.codex.item_type': type,
    'traces.codex.item_id': itemId,
    // `placeInnerSpans` decides the join once every tool window is known. An
    // item that matches no window keeps this value.
    'traces.codex.item_join': 'unmatched',
    ...(timeSource ? { 'traces.codex.item_time_source': timeSource } : {}),
    ...(status ? { 'traces.codex.item_status': status } : {}),
  }
}

interface ItemSpanContext {
  readonly traceId: string
  readonly rootId: string
}

function itemCountsJson(counts: ReadonlyMap<string, number>): string {
  return JSON.stringify(
    Object.fromEntries([...counts].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))),
  )
}

/**
 * Attach each inner span to the model-issued call whose window contains it.
 * This is the only part of an inner span that depends on records written after
 * the item, which is why the span itself is built when the item is read.
 */
function placeInnerSpans(
  pending: readonly PendingInnerSpan[],
  windows: ReadonlyMap<OtlpSpan, ToolWindow>,
): OtlpSpan[] {
  return pending.map((entry) => {
    const { parent, join } = joinItem(windows, entry.startMs, entry.endMs)
    if (parent) entry.span.parent_span_id = parent.span_id
    entry.span.attributes['traces.codex.item_join'] = join
    return entry.span
  })
}

/**
 * One CHAIN span per command. Command text, cwd, and output stay in the tool
 * I/O keys, which metadata-only upload strips and external redactors scrub.
 */
function commandSpan(context: ItemSpanContext, item: object, command: CodexCommandExecution, recordTime: string): PendingInnerSpan {
  const { start, end, timeSource } = itemTimes(command, recordTime)
  const status = itemStatus(command.status, 'command', command.exitCode)
  const commandSpan = span({
    traceId: context.traceId,
    spanId: `command:${command.itemId}`,
    parentSpanId: context.rootId,
    name: 'command.execution',
    kind: 'CHAIN',
    startTime: start,
    status: status.code,
    statusMessage: status.message,
    service: SERVICE,
    agent: SERVICE,
    extra: {
      ...toolIoAttributes({
        input: { command: command.command, ...(command.cwd ? { cwd: command.cwd } : {}) },
        inputSource: itemSources(item, ['command', ...(command.cwd ? ['cwd'] : [])]),
        output: command.output,
        outputSource: itemSources(item, command.outputFields),
      }),
      ...innerItemAttributes('CommandExecution', command.itemId, timeSource, command.status),
      ...(command.exitCode === undefined ? {} : { 'process.exit_code': command.exitCode }),
      ...(command.processId ? { 'traces.codex.process_id': command.processId } : {}),
      ...(command.source ? { 'traces.codex.command_source': command.source } : {}),
    },
  })
  closeSpanAt(commandSpan, end)
  return { span: commandSpan, startMs: Date.parse(start), endMs: Date.parse(end) }
}

/** One CHAIN span per changed path; the path stays in `input.value` for the same reason as commands. */
function fileChangeSpans(context: ItemSpanContext, item: object, fileChange: CodexFileChange, recordTime: string): PendingInnerSpan[] {
  const { start, end, timeSource } = itemTimes(fileChange, recordTime)
  const status = itemStatus(fileChange.status, 'file change')
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  return fileChange.changes.map((change, index) => {
    const changeSpan = span({
      traceId: context.traceId,
      spanId: `file-change:${fileChange.itemId}:${index}`,
      parentSpanId: context.rootId,
      name: 'file.change',
      kind: 'CHAIN',
      startTime: start,
      status: status.code,
      statusMessage: status.message,
      service: SERVICE,
      agent: SERVICE,
      extra: {
        ...toolIoAttributes({
          input: { path: change.path, kind: change.kind, ...(change.movePath ? { move_path: change.movePath } : {}) },
          inputSource: sourceOf(item, 'changes'),
        }),
        ...innerItemAttributes('FileChange', fileChange.itemId, timeSource, fileChange.status),
        'traces.codex.file_change_kind': change.kind,
      },
    })
    closeSpanAt(changeSpan, end)
    return { span: changeSpan, startMs, endMs }
  })
}

/** A user turn awaiting its second record: Codex logs each typed turn as a response item and a `user_message` event. */
interface UserTurnCandidate {
  readonly span: OtlpSpan
  readonly key: string
  readonly task: number
}

/**
 * Legacy Codex prepends context to the submitted message and marks the typed
 * text with this line (openai/codex `codex-rs/protocol/src/protocol.rs`
 * `USER_MESSAGE_BEGIN`), so the two records of one turn can differ by a prefix.
 */
const USER_MESSAGE_BEGIN = '## My request for Codex:'

function userTurnKey(text: string): string {
  const begin = text.indexOf(USER_MESSAGE_BEGIN)
  const typed = begin === -1 ? text : text.slice(begin + USER_MESSAGE_BEGIN.length)
  return typed.trim().replace(/\s+/g, ' ')
}

/** Remove and return the latest candidate with the same text in the same task. */
function takeUserTurn(candidates: UserTurnCandidate[], key: string, task: number): UserTurnCandidate | undefined {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!
    if (candidate.key === key && candidate.task === task) return candidates.splice(index, 1)[0]
  }
  return undefined
}

const USER_MESSAGE_EVENT_ATTR = 'traces.codex.user_message_event'

const verificationCommand =
  /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint|build|check)(?::[A-Za-z0-9:_-]+)?\b|\b(?:vitest|jest|pytest|tsc|biome|eslint|sha256sum|pdfinfo|pdftotext)\b|\bgo\s+test\b|\bcargo\s+(?:test|check|clippy|build)\b|\bgit\s+(?:status|diff|show|merge-tree)\b|\bgh-drew\s+pr\s+(?:view|checks)\b/i

function hasReadOnlyCurl(input: string): boolean {
  if (!/\bcurl\b/i.test(input)) return false
  const method =
    input.match(/(?:^|\s)-X(?:=|\s*)([A-Za-z]+)\b/)?.[1] ??
    input.match(/(?:^|\s)--request(?:=|\s+)([A-Za-z]+)\b/i)?.[1]
  if (method && !/^(?:GET|HEAD)$/i.test(method)) return false
  return !/(?:^|\s)-(?:d|F|T)(?:\S*|\s+\S+)|(?:^|\s)--(?:data(?:-ascii|-binary|-raw|-urlencode)?|form(?:-string)?|json|upload-file)(?:=|\s)/i.test(input)
}

function classifyNestedTool(name: string, input: string | undefined): string {
  return name === 'exec_command' && input && (verificationCommand.test(input) || hasReadOnlyCurl(input))
    ? 'exec_command.verify'
    : name
}

function isExpectedBlockingTool(name: string, input: string | undefined): boolean {
  if (isWaitAgentOperation(name)) return true
  if (!input) return false
  if (name === 'wait') return /\bcell_id\b["']?\s*:/.test(input)
  if (name === 'write_stdin') return /\bsession_id\b["']?\s*:/.test(input)
  return false
}

async function* walkRollouts(root: string): AsyncGenerator<string> {
  let years: string[]
  try {
    years = await readdir(root)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
  for (const y of years) {
    const yp = join(root, y)
    let months: string[]
    try {
      months = await readdir(yp)
    } catch (error) {
      if (isMissingPathError(error)) continue
      throw error
    }
    for (const m of months) {
      const mp = join(yp, m)
      let days: string[]
      try {
        days = await readdir(mp)
      } catch (error) {
        if (isMissingPathError(error)) continue
        throw error
      }
      for (const d of days) {
        const dp = join(mp, d)
        let files: string[]
        try {
          files = await readdir(dp)
        } catch (error) {
          if (isMissingPathError(error)) continue
          throw error
        }
        for (const f of files) {
          if (f.startsWith('rollout-') && f.endsWith('.jsonl')) yield join(dp, f)
        }
      }
    }
  }
}

export class CodexAdapter implements HarnessTraceAdapter {
  readonly harness = 'codex'
  readonly aliases = ['codex-acp'] as const

  private root(): string {
    return process.env.CODEX_HOME
      ? join(process.env.CODEX_HOME, 'sessions')
      : join(homedir(), '.codex', 'sessions')
  }

  private async refFromPath(path: string, opts: LocateOptions): Promise<SessionRef | undefined> {
    let st: Awaited<ReturnType<typeof stat>>
    try {
      st = await stat(path)
    } catch (error) {
      if (isMissingPathError(error)) return undefined
      throw error
    }
    if (opts.sinceMs && st.mtimeMs < opts.sinceMs) return undefined
    // Continuation sessions can lead with turn_context or metadata without cwd.
    let cwd: string | null = null
    let id = basename(path).replace(/^rollout-[\dT-]+-/, '').replace(/\.jsonl$/, '')
    const ref: SessionRef = { harness: this.harness, sessionId: id, path, cwd, mtimeMs: st.mtimeMs }
    const head = await takeJsonl<CodexLine>(path, SESSION_HEAD_LINES, sessionJsonlOptions(ref))
    for (const parsed of head) {
      if (parsed.type === 'session_meta' && parsed.payload?.id) id = parsed.payload.id
      if (!cwd && parsed.payload?.cwd) cwd = parsed.payload.cwd
      if (cwd) break
    }
    ref.sessionId = id
    ref.cwd = cwd
    if (ref.integrity) {
      ref.integrity.corruptions = ref.integrity.corruptions.map((receipt) => ({ ...receipt, sessionId: id }))
    }
    if (opts.cwd && cwd && !cwd.startsWith(opts.cwd)) return undefined
    if (opts.cwd && !cwd && !ref.integrity) return undefined
    return ref
  }

  async locate(opts: LocateOptions = {}): Promise<SessionRef[]> {
    const refs: SessionRef[] = []
    for await (const path of walkRollouts(this.root())) {
      const ref = await this.refFromPath(path, opts)
      if (ref) refs.push(ref)
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async locateBySessionId(sessionId: string, opts: LocateOptions = {}): Promise<SessionRef[]> {
    const refs: SessionRef[] = []
    for await (const path of walkRollouts(this.root())) {
      if (!basename(path).includes(sessionId)) continue
      const ref = await this.refFromPath(path, opts)
      if (ref?.sessionId === sessionId) refs.push(ref)
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async resolveParentTask(
    ref: SessionRef,
    childSessionId: string,
    options: Pick<ParseOptions, 'corruptionMode'> = {},
  ): Promise<ParentTaskResolution> {
    return resolveCodexParentTask(ref, childSessionId, options)
  }

  /**
   * Join a parent's `spawn_agent` calls to the child rollouts they produced, by the exact pair
   * (parent thread ID, agent path). Only the head of each candidate file is read.
   */
  async locateSpawnedChildren(
    parentSessionId: string,
    agentPaths: readonly string[],
    opts: LocateOptions & Pick<ParseOptions, 'corruptionMode' | 'signal'> = {},
  ): Promise<readonly SpawnedChildResolution[]> {
    const wanted = [...new Set(agentPaths)].filter((path) => path.length > 0)
    if (wanted.length === 0 || parentSessionId.length === 0) return []
    const matches = new Map<string, SessionRef[]>()
    for await (const path of walkRollouts(this.root())) {
      opts.signal?.throwIfAborted()
      const spawn = await this.readSpawnIdentity(path)
      if (!spawn || spawn.parentSessionId !== parentSessionId) continue
      if (!wanted.includes(spawn.agentPath)) continue
      const ref = await this.refFromPath(path, { ...opts, cwd: undefined })
      if (!ref) continue
      matches.set(spawn.agentPath, [...(matches.get(spawn.agentPath) ?? []), ref])
    }
    return wanted.map((agentPath) => {
      const found = matches.get(agentPath) ?? []
      if (found.length === 1) return { agentPath, ref: found[0]! }
      if (found.length === 0) return { agentPath, reason: 'not-found' as const }
      return {
        agentPath,
        reason: 'ambiguous' as const,
        candidates: found.map((ref) => ref.sessionId).sort(),
      }
    })
  }

  /** The parent thread ID and agent path a child rollout stamps in its own session metadata. */
  private async readSpawnIdentity(
    path: string,
  ): Promise<{ parentSessionId: string; agentPath: string } | undefined> {
    let head: CodexLine[]
    try {
      // A candidate file is read only to test the pair; a corrupt head disqualifies it and is
      // never a reason to fail the whole expansion.
      head = await takeJsonl<CodexLine>(path, SESSION_HEAD_LINES, { mode: 'recover', onCorruption: () => {} })
    } catch (error) {
      if (isMissingPathError(error)) return undefined
      throw error
    }
    const meta = head.find((line) => line.type === 'session_meta')
    const spawn = meta?.payload?.source?.subagent?.thread_spawn
    const parentSessionId = meta?.payload?.parent_thread_id ?? spawn?.parent_thread_id
    const agentPath = meta?.payload?.agent_path ?? spawn?.agent_path
    if (typeof parentSessionId !== 'string' || typeof agentPath !== 'string') return undefined
    if (parentSessionId.length === 0 || agentPath.length === 0) return undefined
    return { parentSessionId, agentPath }
  }

  async parse(ref: SessionRef, options: ParseOptions = {}): Promise<OtlpSpan[]> {
    const jsonl = sessionJsonlOptions(ref, options)
    const head = await takeJsonl<CodexLine>(ref.path, SESSION_HEAD_LINES, jsonl)
    let first = head[0]
    let meta = head.find((line) => line.type === 'session_meta')
    const taskStartedAt = currentTaskStartedAt(meta)
    const spawnMeta = meta?.payload?.source?.subagent?.thread_spawn
    const parentSessionId = meta?.payload?.parent_thread_id ?? spawnMeta?.parent_thread_id
    const isChildSession = Boolean(parentSessionId || meta?.payload?.thread_source === 'subagent')
    const forkBoundary = isChildSession
      ? await findForkTaskBoundary(
          ref.path,
          jsonl,
          meta?.payload?.id ?? ref.sessionId,
          taskStartedAt,
        )
      : undefined
    const latestBoundary = options.taskScope === 'latest'
      ? await findLatestTaskBoundary(ref.path, jsonl)
      : undefined
    if (options.taskScope === 'latest' && !latestBoundary) {
      throw new CodexTaskScopeError(
        'CODEX_LATEST_TURN_NOT_FOUND',
        `cannot select the latest Codex turn because no task_started event exists in ${ref.path}`,
      )
    }
    if (options.taskScope === 'turn' && !options.taskTurnId) {
      throw new CodexTaskScopeError(
        'CODEX_TURN_ID_REQUIRED',
        'taskTurnId is required when taskScope is "turn"',
      )
    }
    const exactBoundary: CodexTaskBoundary | undefined = options.taskScope === 'turn'
      ? { turnId: options.taskTurnId!, timestamp: new Date(0).toISOString() }
      : undefined
    const selectedBoundary = latestBoundary ?? exactBoundary ?? forkBoundary
    let model = selectedBoundary ? null : head.find((line) => line.type === 'turn_context')?.payload?.model ?? null
    if (!first || !meta) {
      for await (const line of readJsonl<CodexLine>(ref.path, jsonl)) {
        first ??= line
        if (!meta && line.type === 'session_meta') meta = line
        if (!model && line.type === 'turn_context') model = line.payload?.model ?? null
        if (first && meta) break
      }
    }
    const traceId = meta?.payload?.id ?? ref.sessionId
    const sessionRole = parentSessionId || meta?.payload?.thread_source === 'subagent' ? 'child' : 'operator'

    const rootId = `root:${traceId}`
    const root = span({
      traceId,
      spanId: rootId,
      parentSpanId: null,
      name: 'session',
      kind: 'AGENT',
      startTime: selectedBoundary?.timestamp ?? meta?.timestamp ?? first?.timestamp ?? new Date(0).toISOString(),
      service: SERVICE,
      agent: SERVICE,
      model,
      status: 'UNSET',
      extra: {
        // Keep the source session identity searchable after the wire id is normalized.
        'tangle.sessionId': traceId,
        'traces.session.role': sessionRole,
        'traces.codex.task_scope': options.taskScope === 'latest'
          ? 'latest'
          : options.taskScope === 'turn'
            ? 'turn'
          : forkBoundary
            ? 'fork-current'
            : 'all',
        ...(selectedBoundary?.turnId ? { 'traces.codex.turn_id': selectedBoundary.turnId } : {}),
        ...(parentSessionId ? { 'traces.parent_session_id': parentSessionId } : {}),
        ...(spawnMeta?.depth != null ? { 'traces.codex.agent_depth': spawnMeta.depth } : {}),
        ...(meta?.payload?.agent_nickname ?? spawnMeta?.agent_nickname
          ? { 'traces.codex.agent_nickname': meta?.payload?.agent_nickname ?? spawnMeta?.agent_nickname }
          : {}),
        ...(meta?.payload?.agent_role ?? spawnMeta?.agent_role
          ? { 'traces.codex.agent_role': meta?.payload?.agent_role ?? spawnMeta?.agent_role }
          : {}),
        ...(spawnMeta?.agent_path ? { 'traces.codex.agent_path': spawnMeta.agent_path } : {}),
      },
    })
    const spans: OtlpSpan[] = [root]

    const toolByCallId = new Map<string, OtlpSpan>()
    const subagentByThreadId = new Map<string, OtlpSpan>()
    const subagentThreadIdByPath = new Map<string, string>()
    const seenAgentMessages = new Set<string>()
    let activeTaskTurnId: string | null | undefined
    let step = 0
    let lastLlm = rootId
    let sawUserTurn = false
    let lastCumulativeTokenUsage: string | undefined
    let lastTimestamp: string | undefined
    const awaitingModel = model ? [] : [root]
    const toolWindows = new Map<OtlpSpan, ToolWindow>()
    const itemContext: ItemSpanContext = { traceId, rootId }
    const pendingInnerSpans: PendingInnerSpan[] = []
    const completedItemKeys = new Set<string>()
    // Two separate censuses: item types this adapter models no span for, and
    // items of a modeled type that produced none. Only the second reads as
    // lost facts, so they never share one count.
    const unmodeledItemCounts = new Map<string, number>()
    const droppedItemCounts = new Map<string, number>()
    const countItem = (counts: Map<string, number>, label: string): void => {
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    // Pairs the two records of one typed turn. A task index scopes the pairing,
    // so the same short reply in two turns stays two turns.
    let taskIndex = 0
    const unpairedUserItems: UserTurnCandidate[] = []
    const unpairedUserEvents: UserTurnCandidate[] = []
    const tasksWithUserEvents = new Set<number>()
    /**
     * Record one turn Codex reports as submitted input. Codex reports these
     * turns and never its own context blocks: the legacy `user_message` event
     * and the current `item_completed`/`UserMessage` item both come from the
     * same filter (openai/codex `codex-rs/core/src/event_mapping.rs`), and the
     * rollout carries one or the other by history mode (openai/codex
     * `codex-rs/rollout/src/policy.rs`). The response-item copy of the same turn
     * pairs with this record instead of becoming a second span.
     */
    const recordSubmittedTurn = (raw: string, ts: string, contentSource: SourceReferences): void => {
      const prompt = capText(raw)
      if (!prompt) return
      tasksWithUserEvents.add(taskIndex)
      const key = userTurnKey(raw)
      const recorded = takeUserTurn(unpairedUserItems, key, taskIndex)
      if (recorded) {
        recorded.span.attributes[USER_MESSAGE_EVENT_ATTR] = true
        return
      }
      const actor = sessionRole === 'child'
        ? 'agent'
        : codexActor({ text: prompt, isFirstUserTurn: !sawUserTurn })
      sawUserTurn = true
      const turnSpan = userPromptSpan({
        traceId,
        spanId: `msg:${step}:user`,
        parentSpanId: rootId,
        startTime: ts,
        content: prompt,
        contentSource,
        service: SERVICE,
        agent: SERVICE,
        step,
        actor,
      })
      turnSpan.attributes[USER_MESSAGE_EVENT_ATTR] = true
      spans.push(turnSpan)
      unpairedUserEvents.push({ span: turnSpan, key, task: taskIndex })
      step += 1
    }
    const ensureSubagentSpan = (
      threadId: string,
      agentPath: string,
      eventTime: string,
      eventCallSpan: OtlpSpan | undefined,
      observedStart: boolean,
    ): OtlpSpan => {
      const existing = subagentByThreadId.get(threadId)
      if (existing) {
        subagentThreadIdByPath.set(agentPath, threadId)
        if (observedStart) {
          const eventStartedAt = Date.parse(eventTime)
          const previousStartedAt = Date.parse(existing.start_time)
          const previousEndedAt = Date.parse(existing.end_time)
          if (eventStartedAt < previousStartedAt) existing.start_time = eventTime
          if (
            existing.status.code !== 'UNSET'
            && Number.isFinite(eventStartedAt)
            && Number.isFinite(previousEndedAt)
            && eventStartedAt > previousEndedAt
          ) {
            existing.end_time = eventTime
            existing.status = { code: 'UNSET' }
          }
          delete existing.attributes['traces.codex.subagent_start_missing']
          if (eventCallSpan) existing.parent_span_id = eventCallSpan.span_id
        }
        return existing
      }
      const subagentType = agentPath.split('/').filter(Boolean).at(-1) ?? 'subagent'
      const toolSpan = span({
        traceId,
        spanId: `subagent:${threadId}`,
        parentSpanId: eventCallSpan?.span_id ?? lastLlm,
        name: 'tool.Agent',
        kind: 'TOOL',
        startTime: eventTime,
        service: SERVICE,
        agent: SERVICE,
        tool: 'Agent',
        step,
        status: 'UNSET',
        extra: {
          ...toolIoAttributes({
            input: {
              subagent_type: subagentType,
              agent_path: agentPath,
              agent_thread_id: threadId,
            },
          }),
          'traces.codex.subagent_path': agentPath,
          'traces.codex.subagent_thread_id': threadId,
          ...(!observedStart ? { 'traces.codex.subagent_start_missing': true } : {}),
        },
      })
      spans.push(toolSpan)
      subagentByThreadId.set(threadId, toolSpan)
      subagentThreadIdByPath.set(agentPath, threadId)
      step += 1
      return toolSpan
    }

    let reachedCurrentTask = !selectedBoundary
    for await (const l of readJsonl<CodexLine>(ref.path, jsonl)) {
      if (!reachedCurrentTask) {
        if (!isCodexTaskBoundary(l, selectedBoundary!)) continue
        reachedCurrentTask = true
        if (options.taskScope === 'turn') {
          root.start_time = codexTaskBoundary(l)?.timestamp ?? root.start_time
          root.end_time = root.start_time
        }
      } else if (
        (options.taskScope === 'latest' || options.taskScope === 'turn') &&
        selectedBoundary
        && codexTaskBoundary(l)
        && !isCodexTaskBoundary(l, selectedBoundary)
      ) {
        break
      }
      lastTimestamp = latestTimestamp(lastTimestamp, l.timestamp)
      const ts = validTimestamp(l.timestamp) ?? lastTimestamp ?? root.start_time
      if (l.type === 'event_msg' && l.payload?.type === 'task_started') {
        taskIndex += 1
        activeTaskTurnId = l.payload.turn_id ?? null
        root.status = { code: 'UNSET' }
      } else if (l.type === 'event_msg' && l.payload?.type === 'task_complete') {
        const completedTurnId = l.payload.turn_id ?? null
        if (activeTaskTurnId !== undefined && activeTaskTurnId === completedTurnId) {
          activeTaskTurnId = undefined
          root.status = { code: 'OK' }
        }
      }
      if (!model && l.type === 'turn_context' && l.payload?.model) {
        model = l.payload.model
        for (const pending of awaitingModel) pending.attributes['llm.model_name'] = model
        awaitingModel.length = 0
      } else if (l.type === 'event_msg' && l.payload?.type === 'token_count') {
        const u = l.payload.info?.last_token_usage
        if (u && (u.input_tokens || u.output_tokens)) {
          const cumulative = l.payload.info?.total_token_usage
          const cumulativeSignature = cumulative ? tokenUsageSignature(cumulative) : undefined
          if (cumulativeSignature && cumulativeSignature === lastCumulativeTokenUsage) continue
          lastCumulativeTokenUsage = cumulativeSignature
          const id = `llm:${step}`
          const llm = span({
            traceId,
            spanId: id,
            parentSpanId: rootId,
            name: 'llm.turn',
            kind: 'LLM',
            startTime: ts,
            service: SERVICE,
            agent: SERVICE,
            model,
            inputTokens: u.input_tokens ?? null,
            outputTokens: u.output_tokens ?? null,
            reasoningTokens: u.reasoning_output_tokens ?? null,
            cachedInputTokens: u.cached_input_tokens ?? null,
            step,
          })
          spans.push(llm)
          if (!model) awaitingModel.push(llm)
          lastLlm = id
          step += 1
        }
      } else if (
        l.type === 'response_item' &&
        (l.payload?.type === 'function_call' || l.payload?.type === 'custom_tool_call')
      ) {
        const outerName = l.payload.name ?? 'tool'
        const callId = l.payload.call_id ?? `${step}`
        const input = toolInputToString(
          l.payload.type === 'custom_tool_call' ? l.payload.input : l.payload.arguments,
        )
        const nestedName = l.payload.type === 'custom_tool_call' ? singleNestedToolName(input) : null
        const name = classifyNestedTool(nestedName ?? outerName, input)
        const agentOperation = multiAgentOperation(nestedName ?? outerName)
        const toolSpan = span({
          traceId,
          spanId: `tool:${callId}`,
          parentSpanId: lastLlm,
          name: `tool.${name}`,
          kind: 'TOOL',
          startTime: ts,
          status: 'UNSET',
          service: SERVICE,
          agent: SERVICE,
          tool: name,
          step,
          extra: {
            ...toolIoAttributes({ input, inputSource: sourceOf(l.payload, l.payload.type === 'custom_tool_call' ? 'input' : 'arguments') }),
            'traces.codex.call_type': l.payload.type,
            ...(name !== outerName ? { 'traces.codex.outer_tool_name': outerName } : {}),
            ...(nestedName ? { 'traces.codex.nested_tool_name': nestedName } : {}),
            ...(isExpectedBlockingTool(name, input) ? { 'traces.expected_blocking': true } : {}),
            ...(agentOperation ? { 'traces.codex.agent_operation': agentOperation } : {}),
          },
        })
        if (agentOperation && agentOperation !== 'spawn_agent') {
          setAgentSessionIds(toolSpan, targetedSessionIds(agentOperation, input))
        }
        // The join key of last resort. `spawn_agent` returns `{"task_name": "/root/c1_b_grid"}`
        // with no agent id, and codex `exec` builds (0.148–0.152) emit no `sub_agent_activity`
        // stream, so both id-bearing keys are absent and the child is invisible from the parent.
        // The same string IS on both sides: `task_name` here, `session_meta.agent_path` in the
        // child. Recording it lets the workflow expansion join by path instead of reporting a
        // parent with no children as clean.
        if (agentOperation === 'spawn_agent') {
          const path = spawnAgentPath(input)
          if (path) toolSpan.attributes['traces.codex.spawn_agent_path'] = path
        }
        spans.push(toolSpan)
        toolByCallId.set(callId, toolSpan)
        step += 1
      } else if (
        l.type === 'response_item' &&
        (l.payload?.type === 'function_call_output' || l.payload?.type === 'custom_tool_call_output')
      ) {
        const t = toolByCallId.get(l.payload.call_id ?? '')
        if (t) {
          const name = String(t.attributes['tool.name'] ?? '')
          const { status, pollOutcome } = outputStatus(name, l.payload)
          closeSpanAt(t, ts)
          toolWindows.set(t, { startMs: Date.parse(t.start_time), endMs: Date.parse(ts) })
          t.status = status
          if (pollOutcome) t.attributes['traces.poll.outcome'] = pollOutcome
          recordToolOutput(t, l.payload.output, sourceOf(l.payload, 'output'))
          const operation = t.attributes['traces.codex.agent_operation']
          if (operation === 'spawn_agent') {
            setAgentSessionIds(t, spawnedSessionIds(l.payload.output))
            if (!t.attributes['traces.codex.spawn_agent_path']) {
              const path = spawnAgentPath(l.payload.output)
              if (path) t.attributes['traces.codex.spawn_agent_path'] = path
            }
          }
          if (typeof operation === 'string') {
            const requestId = agentRequestId(l.payload.output)
            if (requestId) t.attributes['traces.codex.agent_request_id'] = requestId
          }
        }
      } else if (l.type === 'event_msg' && l.payload?.type === 'user_message') {
        recordSubmittedTurn(
          typeof l.payload.message === 'string' ? l.payload.message : '',
          ts,
          textSources(l.payload, 'message'),
        )
      } else if (l.type === 'event_msg') {
        const activity = codexSubagentActivity(l)
        if (!activity) {
          const completed = codexCompletedItem(l)
          if (completed?.type === 'skipped') {
            countItem(completed.reason === 'unmodeled' ? unmodeledItemCounts : droppedItemCounts, completed.label)
          } else if (completed?.type === 'UserMessage') {
            recordSubmittedTurn(completed.userMessage.text, ts, textSources(completed.item, 'content'))
          } else if (completed) {
            const itemId = completed.type === 'CommandExecution' ? completed.command.itemId : completed.fileChange.itemId
            // Scoped by task: Codex item ids are UUIDs today, but a turn-scoped
            // id scheme must not make a later turn's command a `:duplicate`.
            const itemKey = `${completed.type}:${taskIndex}:${itemId}`
            if (completedItemKeys.has(itemKey)) countItem(droppedItemCounts, `${completed.type}:duplicate`)
            else {
              completedItemKeys.add(itemKey)
              if (completed.type === 'CommandExecution') {
                pendingInnerSpans.push(commandSpan(itemContext, completed.item, completed.command, ts))
              } else {
                pendingInnerSpans.push(...fileChangeSpans(itemContext, completed.item, completed.fileChange, ts))
              }
            }
          }
          continue
        }
        const threadId = activity.agentThreadId
        const eventTime = timestampFromEpochMs(activity.occurredAtMs) ?? ts
        const eventCallSpan = toolByCallId.get(activity.eventId ?? '')
        if (eventCallSpan && threadId) setAgentSessionIds(eventCallSpan, [threadId])
        const agentPath = activity.agentPath ?? 'subagent'
        if (activity.kind === 'started' && threadId) {
          const toolSpan = ensureSubagentSpan(threadId, agentPath, eventTime, eventCallSpan, true)
          recordSubagentLifecycle(toolSpan, 'started', eventTime, activity.eventId)
        } else if (activity.kind === 'completed' && threadId) {
          const toolSpan = ensureSubagentSpan(threadId, agentPath, eventTime, eventCallSpan, false)
          recordSubagentLifecycle(toolSpan, 'completed', eventTime, activity.eventId)
          closeSpanAt(toolSpan, eventTime)
          toolSpan.status = { code: 'OK' }
        } else if (
          ['interrupted', 'failed', 'timed_out'].includes(activity.kind ?? '') &&
          threadId
        ) {
          const toolSpan = ensureSubagentSpan(threadId, agentPath, eventTime, eventCallSpan, false)
          recordSubagentLifecycle(toolSpan, activity.kind!, eventTime, activity.eventId)
          closeSpanAt(toolSpan, eventTime)
          toolSpan.status = { code: 'ERROR', message: `subagent ${activity.kind}` }
        } else if (activity.kind === 'interacted' && threadId) {
          const toolSpan = ensureSubagentSpan(threadId, agentPath, eventTime, eventCallSpan, false)
          recordSubagentLifecycle(toolSpan, 'interacted', eventTime, activity.eventId)
          const operation = eventCallSpan?.attributes['traces.codex.agent_operation']
          if (operation === 'followup_task' || operation === 'send_input') {
            closeSpanAt(toolSpan, eventTime)
            toolSpan.status = { code: 'UNSET' }
          }
        }
        // `interacted` is a progress event, not a terminal state.
      } else if (l.type === 'response_item' && l.payload?.type === 'agent_message') {
        const messageIdentity = JSON.stringify([
          l.timestamp ?? null,
          l.payload.author ?? null,
          l.payload.recipient ?? null,
          l.payload.content ?? null,
        ])
        if (seenAgentMessages.has(messageIdentity)) continue
        seenAgentMessages.add(messageIdentity)
        const text = textOf(l.payload.content)
        const author = l.payload.author
        const recipient = l.payload.recipient
        const messageType = /^Message Type:\s*FINAL_ANSWER\b/m.test(text)
          ? 'final'
          : /^Message Type:\s*MESSAGE\b/m.test(text)
            ? 'progress'
            : 'unknown'
        const threadId = author ? subagentThreadIdByPath.get(author) : undefined
        const agentSpan = threadId ? subagentByThreadId.get(threadId) : undefined
        const messageSpan = span({
          traceId,
          spanId: `msg:${step}:agent`,
          parentSpanId: agentSpan?.span_id ?? rootId,
          name: `message.agent.${messageType}`,
          kind: 'CHAIN',
          startTime: ts,
          service: SERVICE,
          agent: SERVICE,
          step,
          content: text,
          contentSource: textSources(l.payload, 'content'),
          extra: {
            'traces.codex.agent_message_type': messageType,
            ...(author ? { 'traces.codex.agent_message_author': author } : {}),
            ...(recipient ? { 'traces.codex.agent_message_recipient': recipient } : {}),
            ...(threadId ? {
              'traces.codex.agent_thread_id': threadId,
              'traces.codex.agent_session_ids': JSON.stringify([threadId]),
              'traces.codex.agent_session_count': 1,
            } : {}),
          },
        })
        spans.push(messageSpan)
        step += 1
        if (messageType === 'progress' && agentSpan) {
          closeSpanAt(agentSpan, ts)
          agentSpan.status = { code: 'UNSET' }
        } else if (messageType === 'final' && agentSpan) {
          recordSubagentLifecycle(agentSpan, 'final_answer', ts)
          closeSpanAt(agentSpan, ts)
          agentSpan.status = { code: 'OK' }
        }
      } else if (l.type === 'response_item' && l.payload?.type === 'message' && l.payload.role === 'user') {
        // The human's prompt text. Codex drops the user turn from token events,
        // so capture it here as its own CHAIN span (no text → no span).
        const raw = contentToString(l.payload.content)
        const prompt = capText(raw)
        if (prompt) {
          const key = userTurnKey(raw)
          // The user_message event already recorded this turn.
          if (takeUserTurn(unpairedUserEvents, key, taskIndex)) continue
          const actor = sessionRole === 'child'
            ? 'agent'
            : codexActor({ text: prompt, blocks: contentTextBlocks(l.payload.content), isFirstUserTurn: !sawUserTurn })
          sawUserTurn = true
          const turnSpan = userPromptSpan({
            traceId,
            spanId: `msg:${step}:user`,
            parentSpanId: rootId,
            startTime: ts,
            content: prompt,
            contentSource: textSources(l.payload, 'content'),
            service: SERVICE,
            agent: SERVICE,
            step,
            actor,
          })
          spans.push(turnSpan)
          unpairedUserItems.push({ span: turnSpan, key, task: taskIndex })
          step += 1
        }
      } else if (l.type === 'response_item' && l.payload?.type === 'message') {
        const text = textOf(l.payload.content)
        if (text) {
          spans.push(
            span({
              traceId,
              spanId: `msg:${step}`,
              parentSpanId: rootId,
              name: `message.${l.payload.role ?? 'unknown'}`,
              kind: 'CHAIN',
              startTime: ts,
              service: SERVICE,
              agent: SERVICE,
              step,
              content: text,
          contentSource: textSources(l.payload, 'content'),
            }),
          )
          step += 1
        }
      }
    }
    if (!reachedCurrentTask && options.taskScope === 'turn') {
      throw new CodexTaskScopeError(
        'CODEX_TURN_NOT_FOUND',
        `Codex turn ${JSON.stringify(options.taskTurnId)} does not exist in ${ref.path}`,
      )
    }
    // Where Codex recorded user_message events for a task, a user-role message
    // without one is harness context, even under a wrapper not listed in actor.ts.
    for (const candidate of unpairedUserItems) {
      if (candidate.span.attributes[ACTOR_ATTR] !== 'human' || !tasksWithUserEvents.has(candidate.task)) continue
      candidate.span.attributes[ACTOR_ATTR] = 'injected'
      candidate.span.attributes['traces.codex.actor_evidence'] = 'no_user_message_event'
    }
    spans.push(...placeInnerSpans(pendingInnerSpans, toolWindows))
    if (unmodeledItemCounts.size > 0) {
      root.attributes['traces.codex.unmodeled_item_counts'] = itemCountsJson(unmodeledItemCounts)
    }
    if (droppedItemCounts.size > 0) {
      root.attributes['traces.codex.dropped_item_counts'] = itemCountsJson(droppedItemCounts)
    }
    if (selectedBoundary?.turnId) {
      for (const item of spans) item.attributes['traces.codex.turn_id'] ??= selectedBoundary.turnId
    }
    closeSpanAt(root, lastTimestamp ?? root.start_time)
    normalizeCodexIds(spans)
    return spans
  }
}
