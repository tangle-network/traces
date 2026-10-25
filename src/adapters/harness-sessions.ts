/** Native-session adapter for formats owned by @tangle-network/harness-sessions.
 * Traces keeps selection and trace-specific presentation here; the shared reader
 * alone interprets the harness's records, model calls, tools, and token usage. */
import { homedir } from 'node:os'
import { nativeRef, tracesRef, type SupportedHarness } from './harness-refs.js'
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, dirname, join, resolve } from 'node:path'
import {
  claudeCodeRefForFile,
  opencodeSessionsInStore,
  readerFor,
  readSessionInput,
  toOtlpSpans,
  type HarnessSession,
  type SessionRef as NativeRef,
} from '@tangle-network/harness-sessions'
import { contractSpan, deriveHexId } from '@tangle-network/agent-trace-contract'
import { applyLlmSpanOtlpAttributes } from '@tangle-network/agent-eval/trace-attributes'
import {
  SESSION_CWD_ATTR,
  SESSION_TOTAL_CACHE_WRITE_ATTR,
  SESSION_TOTAL_CACHED_INPUT_ATTR,
  SESSION_TOTAL_INPUT_ATTR,
  SESSION_TOTAL_OUTPUT_ATTR,
  SESSION_TOTAL_REASONING_ATTR,
  SESSION_TOTAL_TOKENS_ATTR,
} from '../attributes.js'
import type { OtlpSpan } from '../otlp.js'
import { takeJsonl } from '../jsonl.js'
import type { HarnessTraceAdapter, LocateOptions, ParentTaskResolution, ParseOptions, SessionRef, SpawnedChildResolution } from '../types.js'
import { codexActor } from './actor.js'
import { ClaudeAdapter, spawnsSubagent, spawnTaskName } from './claude.js'
import { stampNativeProvenance } from './native-provenance.js'
import { SUBAGENT_SPAWN_ATTR, SUBAGENT_SPAWN_TASK_ATTR } from './provenance.js'
import { agentOperationFailed, classifyNestedTool, CodexAdapter, spawnAgentPath, userTurnKey } from './codex.js'
import { codexCompletedItem, type CodexLine, contentTextBlocks, multiAgentOperation, spawnedSessionIds, targetedSessionIds } from './codex-format.js'
import { uuidV7TimestampMs } from './codex-task-scope.js'
import { OpencodeAdapter } from './opencode.js'

async function isClaudeStreamJson(path: string): Promise<boolean> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(65536)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n').slice(0, 20)) {
      if (!line || line.length > 60000) continue
      try {
        const row = JSON.parse(line) as { type?: string; subtype?: string }
        if (row.type === 'system' && row.subtype === 'init') return true
      } catch {
        // A torn head is the shared reader's integrity decision.
      }
    }
    return false
  } finally {
    await file.close()
  }
}

function status(code: string): OtlpSpan['status']['code'] {
  return code === 'STATUS_CODE_OK' ? 'OK' : code === 'STATUS_CODE_ERROR' ? 'ERROR' : 'UNSET'
}

function stringTooLong(error: unknown): boolean {
  return error instanceof Error && /Cannot create a string longer than/u.test(error.message)
}

function asTracesSpan(item: ReturnType<typeof toOtlpSpans>[number]): OtlpSpan {
  const attributes: Record<string, unknown> = { ...item.attributes }
  if (item.kind === 'LLM') {
    applyLlmSpanOtlpAttributes(attributes, {
      model: typeof attributes['gen_ai.request.model'] === 'string' ? attributes['gen_ai.request.model'] : undefined,
      inputTokens: typeof attributes['gen_ai.usage.input_tokens'] === 'number' ? attributes['gen_ai.usage.input_tokens'] : undefined,
      outputTokens: typeof attributes['gen_ai.usage.output_tokens'] === 'number' ? attributes['gen_ai.usage.output_tokens'] : undefined,
      reasoningTokens: typeof attributes['gen_ai.usage.reasoning_tokens'] === 'number' ? attributes['gen_ai.usage.reasoning_tokens'] : undefined,
      cachedTokens: typeof attributes['gen_ai.usage.cache_read.input_tokens'] === 'number' ? attributes['gen_ai.usage.cache_read.input_tokens'] : undefined,
      cacheWriteTokens: typeof attributes['gen_ai.usage.cache_creation.input_tokens'] === 'number' ? attributes['gen_ai.usage.cache_creation.input_tokens'] : undefined,
    })
  }
  if (item.kind === 'TOOL' && typeof attributes['gen_ai.tool.name'] === 'string') {
    attributes['tool.name'] = attributes['gen_ai.tool.name']
  }
  return {
    trace_id: item.trace_id,
    span_id: item.span_id,
    parent_span_id: item.parent_span_id,
    name: item.name,
    start_time: item.start_time,
    end_time: item.end_time,
    status: { code: status(item.status.code), ...(item.status.message ? { message: item.status.message } : {}) },
    attributes,
    ...(item.links ? { links: [...item.links] } : {}),
  }
}

function messageText(message: HarnessSession['messages'][number]): string {
  return message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

function presentationSpans(session: HarnessSession, root: OtlpSpan): OtlpSpan[] {
  const spans = new Map<string, OtlpSpan>()
  for (const message of session.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (!message.at) continue
    const text = messageText(message)
    if (!text) continue
    const isPrompt = message.role === 'user'
    const item = contractSpan({
      traceId: root.trace_id,
      spanId: deriveHexId(`${session.harness}:${session.nativeSessionId}:message:${message.id}`, 8),
      parentSpanId: root.span_id,
      name: isPrompt ? 'user.prompt' : 'message.assistant',
      kind: 'CHAIN',
      startTime: message.at,
      endTime: message.at,
      attributes: {
        'service.name': session.harness,
        'tangle.actor': message.actor,
        content: text.slice(0, 8000),
      },
    })
    // Claude can re-emit a message with the same native ID after a resumed
    // subagent turn. The later copy can carry stronger actor attribution.
    spans.set(item.span_id, asTracesSpan(item))
  }
  return [...spans.values()]
}

/** Codex's `exec` is a JavaScript envelope around one or more actual tools. */
function nestedToolName(input: string | null): string | null {
  if (!input) return null
  const names = [...new Set([...input.matchAll(/\btools\.([A-Za-z][A-Za-z0-9_]*)\s*\(/gu)].map((match) => match[1]!))]
  return names.length === 1 ? names[0]! : null
}

function decorateCodexTools(session: HarnessSession, spans: OtlpSpan[]): void {
  const byCallId = new Map(session.toolCalls.map((call) => [call.id, call]))
  for (const item of spans) {
    if (item.attributes['openinference.span.kind'] !== 'TOOL') continue
    const callId = item.attributes['gen_ai.tool.call.id']
    if (typeof callId !== 'string') continue
    const call = byCallId.get(callId)
    if (!call) continue
    const nested = call.name === 'exec' ? nestedToolName(call.inputText) : null
    // The name traces' own Codex reader gives the same call, so both read paths count tools alike.
    const named = classifyNestedTool(nested ?? call.name, call.inputText ?? undefined)
    if (named !== call.name) {
      item.attributes['traces.codex.outer_tool_name'] = call.name
      item.attributes['tool.name'] = named
      item.name = `tool.${named}`
    }
    if (nested) item.attributes['traces.codex.nested_tool_name'] = nested
    const name = nested ?? call.name
    const operation = multiAgentOperation(name)
    if (!operation) continue
    item.attributes['traces.codex.agent_operation'] = operation
    const output = call.result?.output
    if (agentOperationFailed(name, output)) item.status = { code: 'ERROR', message: String(output).slice(0, 500) }
    const children = session.children
      .filter((child) => child.toolCallId === callId)
      .map((child) => child.nativeSessionId)
    const ids = operation === 'spawn_agent'
      ? [...new Set([...children, ...spawnedSessionIds(call.result?.output)])]
      : targetedSessionIds(operation, call.inputText ?? call.input)
    if (ids.length > 0) item.attributes['traces.codex.agent_session_ids'] = JSON.stringify(ids)
    if (operation !== 'spawn_agent') continue
    item.attributes['traces.agent.spawn'] = true
    // The task path the child stamps in its own session_meta: its name, and
    // the join key when the spawn returned no child id.
    const path = spawnAgentPath(call.input) ?? spawnAgentPath(call.inputText) ?? spawnAgentPath(call.result?.output)
    if (path) item.attributes['traces.codex.spawn_agent_path'] = path
  }
}

/** A Claude Code tool call that names an agent to run spawned a subagent: the rule traces' own Claude reader applies. */
function decorateClaudeSpawns(session: HarnessSession, spans: OtlpSpan[]): void {
  const byCallId = new Map(session.toolCalls.map((call) => [call.id, call]))
  for (const item of spans) {
    if (item.attributes['openinference.span.kind'] !== 'TOOL') continue
    const call = byCallId.get(String(item.attributes['gen_ai.tool.call.id']))
    if (!call || !spawnsSubagent(call.input)) continue
    item.attributes[SUBAGENT_SPAWN_ATTR] = true
    const task = spawnTaskName(call.input)
    if (task) item.attributes[SUBAGENT_SPAWN_TASK_ATTR] = task
  }
}

function lifecycleSpans(session: HarnessSession, root: OtlpSpan, spans: readonly OtlpSpan[]): OtlpSpan[] {
  if (session.harness !== 'codex') return []
  const tools = new Map(spans
    .filter((item) => item.attributes['openinference.span.kind'] === 'TOOL')
    .map((item) => [item.attributes['gen_ai.tool.call.id'], item]))
  const result: OtlpSpan[] = []
  for (const child of session.children) {
    const tool = child.toolCallId ? tools.get(child.toolCallId) : undefined
    if (!tool) continue
    const marker = contractSpan({
      traceId: root.trace_id,
      spanId: deriveHexId(`${session.harness}:${session.nativeSessionId}:child:${child.nativeSessionId}`, 8),
      parentSpanId: tool.span_id,
      name: 'subagent.lifecycle',
      kind: 'AGENT',
      startTime: tool.start_time,
      endTime: tool.end_time,
      attributes: {
        'service.name': session.harness,
        'traces.codex.subagent_thread_id': child.nativeSessionId,
        'traces.span.synthesized': true,
        'traces.span.synthesized_from': 'harness-session.child',
      },
    })
    result.push(asTracesSpan(marker))
  }
  return result
}

type CodexHead = { timestamp?: string; type?: string; payload?: {
  type?: string; role?: string; content?: unknown; id?: string; agent_nickname?: string; turn_id?: string;
  internal_chat_message_metadata_passthrough?: { content_item_kinds?: readonly unknown[] };
  forked_from_id?: string; thread_source?: string; originator?: string; cwd?: string; model_provider?: string;
  agent_role?: string; agent_path?: string; parent_thread_id?: string;
  git?: { repository_url?: unknown }; source?: { subagent?: { thread_spawn?: {
    depth?: number; agent_nickname?: string; agent_role?: string; agent_path?: string; parent_thread_id?: string
  } } }
} }

/** A Codex rollout's `session_meta` payload, from the head of the file; a torn head has none. */
async function codexMeta(path: string): Promise<NonNullable<CodexHead['payload']> | undefined> {
  try {
    const head = await takeJsonl<CodexHead>(path, 40, { mode: 'recover', onCorruption: () => {} })
    return head.find((row) => row.type === 'session_meta')?.payload
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * A Codex child that starts with its parent's history: its head starts a task
 * before the child existed (the task's UUIDv7 turn id predates the child's id).
 * Only such a child has records the shared reader would count as its own.
 */
function hasForkPrefix(head: readonly CodexHead[]): boolean {
  const meta = head.find((row) => row.type === 'session_meta')?.payload
  if (!meta?.id || !(meta.parent_thread_id || meta.source?.subagent?.thread_spawn?.parent_thread_id || meta.thread_source === 'subagent')) return false
  const born = uuidV7TimestampMs(meta.id)
  return born !== undefined && head.some((row) => {
    if (row.type !== 'event_msg' || row.payload?.type !== 'task_started') return false
    const started = uuidV7TimestampMs(row.payload.turn_id)
    return started !== undefined && started < born
  })
}

async function codexForkPrefix(path: string): Promise<boolean> {
  try {
    return hasForkPrefix(await takeJsonl<CodexHead>(path, 40, { mode: 'recover', onCorruption: () => {} }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function ownHome(): string {
  return process.env.HOME || homedir()
}

/** A user-role message record of a rollout: a turn typed into it. */
function isCodexUserMessage(row: CodexHead): boolean {
  return row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user'
}

/** A user-role message of a rollout: when, its turn key, its task, and whether Codex's labels call it the person's. */
interface CodexTypedItem { readonly time: number; readonly key: string; readonly task: number; readonly person: boolean }

/** A turn Codex reports as submitted: an `item_completed` UserMessage, or the older `user_message` event. */
interface CodexTypedEvent { readonly at: string; readonly id: string; readonly text: string; readonly key: string; readonly task: number }

/** What a rollout's own records say about the turns typed into it. */
interface CodexTypedTimes {
  /** When each user-role message was written. */
  readonly all: ReadonlySet<number>
  readonly items: readonly CodexTypedItem[]
  readonly events: readonly CodexTypedEvent[]
}

/** A bounded pairing key: equal turns give equal keys, and a long injected block cannot grow the fold. */
const boundedKey = (text: string): string => {
  const key = userTurnKey(text)
  return `${key.length}:${key.slice(0, 512)}`
}

/** Fold a rollout's records, one at a time, into {@link CodexTypedTimes}; a task starts at each `task_started`. */
function typedTimesFold(): { add(row: CodexHead): void; result(): CodexTypedTimes } {
  const all = new Set<number>()
  const items: CodexTypedItem[] = []
  const events: CodexTypedEvent[] = []
  let task = 0
  return {
    add(row) {
      if (!row.timestamp) return
      if (row.type === 'event_msg' && row.payload?.type === 'task_started') task += 1
      if (row.type === 'event_msg' && row.payload?.type === 'user_message') {
        const text = (row.payload as { message?: unknown }).message
        if (typeof text === 'string' && text.trim()) events.push({ at: row.timestamp, id: row.timestamp, text, key: boundedKey(text), task })
        return
      }
      if (row.type === 'event_msg' && row.payload?.type === 'item_completed') {
        const completed = codexCompletedItem(row as CodexLine)
        if (completed?.type === 'UserMessage') {
          const { itemId, text } = completed.userMessage
          events.push({ at: row.timestamp, id: itemId, text, key: boundedKey(text), task })
        }
        return
      }
      if (!isCodexUserMessage(row)) return
      const time = Date.parse(row.timestamp)
      all.add(time)
      const blocks = contentTextBlocks(row.payload?.content)
      const kinds = row.payload?.internal_chat_message_metadata_passthrough?.content_item_kinds
      items.push({ time, key: boundedKey(blocks.join('\n')), task, person: codexActor({ text: blocks.join('\n'), blocks, kinds }) === 'human' })
    },
    result: () => ({ all, items, events }),
  }
}

/** The records {@link typedTimesFold} reads, found without parsing every line. */
const TYPED_RECORD = /"task_started"|"user_message"|"UserMessage"|"response_item"[^\n]*"user"|"user"[^\n]*"response_item"/

/** {@link CodexTypedTimes} for a whole rollout. */
async function codexUserMessageTimes(path: string): Promise<CodexTypedTimes> {
  const fold = typedTimesFold()
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!TYPED_RECORD.test(line)) continue
    try {
      fold.add(JSON.parse(line) as CodexHead)
    } catch {
      // A torn line is the shared reader's integrity decision.
    }
  }
  return fold.result()
}

/**
 * A turn the person typed that opens with a tag: an answer to Codex's question
 * tool (`<send_user_message_question_reply>`), or a turn with an attached image
 * (`<image name=…>`). The shared reader (harness-sessions 0.1.7) calls every
 * user message that opens with a tag injected. This reads them as traces' own
 * Codex reader does:
 *
 *   - In a task where Codex reported its submitted turns, a user message is the
 *     person's when one of those reports pairs with it (the same turn key) and
 *     Codex's labels (`content_item_kinds`, read by `codexActor`) say so.
 *   - A report that pairs with no message, because the message carries markup
 *     the report does not (an image's `<image …>` wrapper), is the turn itself,
 *     with the report's text and time; the message stays injected.
 *   - In a task without reports, Codex's labels decide alone.
 *
 * The rollout is read only when a turn called injected reads as typed by its
 * text. A spawned child's messages stay as they are.
 */
async function relabelTaggedTurns(typedTimes: () => Promise<CodexTypedTimes>, root: OtlpSpan, spans: OtlpSpan[]): Promise<void> {
  if (root.attributes['traces.session.role'] === 'child') return
  const candidates = spans.filter((item) => item.name === 'user.prompt' && item.attributes['tangle.actor'] === 'injected'
    && typeof item.attributes.content === 'string' && codexActor({ text: item.attributes.content }) === 'human')
  if (candidates.length === 0) return
  const typed = await typedTimes()
  const reportedTasks = new Set(typed.events.map((event) => event.task))
  const paired = new Set<CodexTypedEvent>()
  const pairs = new Map<CodexTypedItem, CodexTypedEvent>()
  for (const item of typed.items) {
    const event = typed.events.find((candidate) => !paired.has(candidate) && candidate.task === item.task && candidate.key === item.key)
    if (!event) continue
    paired.add(event)
    pairs.set(item, event)
  }
  for (const span of candidates) {
    const time = Date.parse(span.start_time)
    const item = typed.items.find((candidate) => candidate.time === time && !candidate.key.startsWith('0:'))
    if (!item?.person) continue
    if (!reportedTasks.has(item.task) || pairs.has(item)) {
      span.attributes['tangle.actor'] = 'human'
      continue
    }
    // The report of this turn: unpaired, in the same task, at or just after the message.
    const report = typed.events.find((event) => !paired.has(event) && event.task === item.task
      && Date.parse(event.at) >= time && Date.parse(event.at) - time <= 2_000)
    if (!report) continue
    paired.add(report)
    spans.push(asTracesSpan(contractSpan({
      traceId: root.trace_id,
      spanId: deriveHexId(`codex:${root.trace_id}:user-message:${report.id}`, 8),
      parentSpanId: root.span_id,
      name: 'user.prompt',
      kind: 'CHAIN',
      startTime: report.at,
      endTime: report.at,
      attributes: { 'service.name': 'codex', 'tangle.actor': codexActor({ text: report.text }), content: report.text },
    })))
  }
}

/**
 * A fork the person made (`/fork`, `codex fork`) records the thread it came
 * from, and the shared reader (harness-sessions 0.1.4) then labels every turn
 * typed into it a spawned agent's brief, so the session showed no human turn.
 * A spawned agent's fork says so in `thread_source` or `source.subagent`; a
 * person's does not. Its user-role messages are the person's again, and the
 * session is an operator's. Messages another agent sent stay as they are.
 */
async function relabelUserFork(typedTimes: () => Promise<CodexTypedTimes>, meta: NonNullable<CodexHead['payload']>, root: OtlpSpan, spans: OtlpSpan[]): Promise<void> {
  if (typeof meta.forked_from_id !== 'string' || meta.thread_source === 'subagent' || meta.source?.subagent !== undefined) return
  root.attributes['traces.session.role'] = 'operator'
  const typed = await typedTimes()
  for (const item of spans) {
    if (item.name === 'user.prompt' && item.attributes['tangle.actor'] === 'subagent-spawn' && typed.all.has(Date.parse(item.start_time))) {
      item.attributes['tangle.actor'] = 'human'
    }
  }
}

/**
 * A Codex session a script or another agent launched, which the shared reader
 * calls a person's. `codex exec` runs a script's prompt, so its first turn is
 * the launcher's brief, as traces' own Codex reader says (`codexActor`); a
 * session the Claude Code plugin opened takes every prompt from Claude.
 * `promptSeen` says an earlier piece of the session already held its first
 * prompt. Returns whether this session has had a person's prompt by now.
 */
function relabelLaunched(meta: NonNullable<CodexHead['payload']>, spans: OtlpSpan[], promptSeen = false): boolean {
  const prompts = spans
    .filter((item) => item.name === 'user.prompt' && item.attributes['tangle.actor'] === 'human')
    .sort((left, right) => Date.parse(left.start_time) - Date.parse(right.start_time))
  if (meta.originator === 'Claude Code') {
    for (const item of prompts) item.attributes['tangle.actor'] = 'agent'
  } else if (meta.originator === 'codex_exec' || (meta.source as unknown) === 'exec') {
    if (prompts[0] && !promptSeen) prompts[0].attributes['tangle.actor'] = 'injected'
  }
  return promptSeen || prompts.length > 0
}

/** What a Codex session's own records say about it, beside what the shared reader reads. */
interface CodexDecoration {
  readonly meta: NonNullable<CodexHead['payload']> | undefined
  /** When each user-role message of the session was written, and which are the person's. */
  readonly typedTimes: () => Promise<CodexTypedTimes>
  readonly promptSeen?: boolean
  /** The head of the file, read whole: its older plain-string prompts. */
  readonly legacyHead?: readonly CodexHead[]
}

/** One line of a session file as the turn index read it: the record, or null for a blank or unreadable line. */
export type PieceRecord = Record<string, unknown> | null

/**
 * What the pieces of a session file read so far established, which the next
 * piece needs to read as one read of the whole file would. Plain JSON: the
 * turn index stores it with the file's byte cursor.
 */
export interface PieceCarry {
  /** Lines of the file before the next piece. */
  readonly lines: number
  readonly nativeSessionId: string | null
  readonly parentNativeSessionId: string | null
  readonly cwd: string | null
  /** Codex: model calls the fold made before the next piece. */
  readonly calls: number
  /** Codex: the last cumulative token usage recorded before the next piece. */
  readonly tokens: Record<string, unknown> | null
  /** Codex: the fields of `session_meta` that relabel turns and stamp the root. */
  readonly meta: NonNullable<CodexHead['payload']> | null
  /** Codex: a person's prompt came before the next piece. */
  readonly promptSeen: boolean
}

export const PIECE_START: PieceCarry = {
  lines: 0, nativeSessionId: null, parentNativeSessionId: null, cwd: null, calls: 0, tokens: null, meta: null, promptSeen: false,
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `session_meta` fields traces reads, without the instructions it also carries. */
function codexMetaSummary(meta: NonNullable<CodexHead['payload']>): NonNullable<CodexHead['payload']> {
  const keep = ['id', 'cwd', 'model_provider', 'forked_from_id', 'thread_source', 'originator', 'source', 'agent_nickname', 'agent_role', 'agent_path', 'parent_thread_id'] as const
  return Object.fromEntries(keep.filter((key) => meta[key] !== undefined).map((key) => [key, meta[key]])) as NonNullable<CodexHead['payload']>
}

/**
 * Where a piece of `records` may end so the next piece, read on its own,
 * reads as one read of both: the index of the first record that waits for
 * the next piece.
 *
 * Claude Code writes each content block of a response as its own record,
 * repeating the response's `message.id`, and may write tool results between
 * them; the blocks are one message. So a piece ends before the last
 * response's first record. Codex holds a response open until a person's
 * message or a new turn starts, a turn ends, or a cumulative token count
 * moves with the response's own usage; a piece ends at the last of those
 * that no tool call is waiting across: a call's status arrives with its
 * output, and a search row of a command carries it. A turn that ended leaves
 * no call waiting. A Codex fork first replays the history of the thread it
 * came from, from that thread's `session_meta` to its own first turn; no
 * piece ends inside it.
 */
export function pieceBoundary(harness: string, records: readonly PieceRecord[], carry: PieceCarry = PIECE_START): number {
  if (harness === 'claude-code') {
    let start = records.length
    let last: unknown
    records.forEach((record, index) => {
      if (!record || record.isSidechain === true || record.type !== 'assistant') return
      const message = isPlainObject(record.message) ? record.message : {}
      const id = typeof message.id === 'string' ? message.id : `${String(record.uuid)}#${index}`
      if (id !== last) {
        start = index
        last = id
      }
    })
    return start
  }
  return codexScan(records, carry).cut
}

/** Codex records that open a tool call; its `*_output` record with the same call id closes it. */
const CODEX_CALLS: ReadonlySet<string> = new Set(['function_call', 'custom_tool_call', 'local_shell_call'])

/** A turn starting or ending: no output for a call before it is still to come. */
const TURN_EDGES: ReadonlySet<string> = new Set(['task_started', 'task_complete', 'turn_aborted'])

/**
 * A Codex piece read the way the fold reads it: where it may end (see
 * {@link pieceBoundary}) and the last cumulative token usage the fold took
 * in, which a replayed fork's history does not set.
 */
function codexScan(records: readonly PieceRecord[], carry: PieceCarry): { cut: number; tokens: Record<string, unknown> | null } {
  let cut = 0
  let tokens = carry.tokens
  let sawMeta = carry.lines > 0
  let forked = typeof carry.meta?.forked_from_id === 'string'
  let sessionId = carry.nativeSessionId ?? ''
  let inherited = false
  // Calls written without their output yet, by call id.
  const waiting = new Set<string>()
  const end = (index: number): void => {
    if (waiting.size === 0) cut = index
  }
  records.forEach((record, index) => {
    const payload = record && isPlainObject(record.payload) ? record.payload : null
    if (!record || !payload) return
    if (record.type === 'session_meta') {
      if (sawMeta) inherited ||= forked
      else {
        sawMeta = true
        forked = typeof payload.forked_from_id === 'string'
        if (typeof payload.id === 'string') sessionId = payload.id
      }
      return
    }
    if (inherited) {
      // The fork's own first turn: its id sorts at or after the session's (UUIDv7).
      if (record.type === 'event_msg' && payload.type === 'task_started' && typeof payload.turn_id === 'string' && payload.turn_id >= sessionId) {
        inherited = false
        cut = index
      }
      return
    }
    const callId = typeof payload.call_id === 'string' ? payload.call_id : null
    if (record.type === 'response_item' && callId !== null) {
      if (CODEX_CALLS.has(String(payload.type))) waiting.add(callId)
      else if (String(payload.type).endsWith('_output')) waiting.delete(callId)
    }
    if (record.type === 'event_msg' && TURN_EDGES.has(String(payload.type))) waiting.clear()
    if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') end(index)
    else if (record.type === 'event_msg' && payload.type === 'task_started') end(index)
    else if (record.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'turn_aborted')) end(index + 1)
    else if (record.type === 'event_msg' && payload.type === 'token_count' && isPlainObject(payload.info)) {
      const usage = payload.info.total_token_usage
      if (!isPlainObject(usage)) return
      const last = payload.info.last_token_usage
      if (typeof usage.total_tokens === 'number' && usage.total_tokens !== tokens?.total_tokens && isPlainObject(last) && typeof last.output_tokens === 'number') end(index + 1)
      tokens = usage
    }
  })
  return { cut, tokens }
}

/** Relabel and stamp a Codex session's spans from its `session_meta`. Returns whether it has had a person's prompt. */
async function decorateCodexMeta(decoration: CodexDecoration, root: OtlpSpan, spans: OtlpSpan[]): Promise<boolean> {
  const { meta } = decoration
  let promptSeen = decoration.promptSeen ?? false
  let typed: Promise<CodexTypedTimes> | undefined
  const typedTimes = (): Promise<CodexTypedTimes> => (typed ??= decoration.typedTimes())
  if (meta) await relabelUserFork(typedTimes, meta, root, spans)
  await relabelTaggedTurns(typedTimes, root, spans)
  if (meta) promptSeen = relabelLaunched(meta, spans, promptSeen)
  const spawn = meta?.source?.subagent?.thread_spawn
  if (typeof spawn?.depth === 'number') root.attributes['traces.codex.agent_depth'] = spawn.depth
  const nickname = meta?.agent_nickname ?? spawn?.agent_nickname
  if (nickname) root.attributes['traces.codex.agent_nickname'] = nickname
  const role = meta?.agent_role ?? spawn?.agent_role
  if (role) root.attributes['traces.codex.agent_role'] = role
  if (spawn?.agent_path) root.attributes['traces.codex.agent_path'] = spawn.agent_path
  return promptSeen
}

/** A user-role message in Codex's older plain-string form, which the shared reader's parts omit. */
function isLegacyPrompt(row: CodexHead): boolean {
  return isCodexUserMessage(row) && typeof row.payload?.content === 'string'
}

/**
 * Older Codex rollouts can put a plain string in a user message. The shared
 * reader's 0.1.0 normalized parts omit it; retain the visible subject here
 * from the head of the file.
 */
function addLegacyPrompts(head: readonly CodexHead[], session: HarnessSession, root: OtlpSpan, spans: OtlpSpan[]): void {
  if (session.messages.some((message) => message.role === 'user' && messageText(message))) return
  for (const row of head) {
    if (!isLegacyPrompt(row) || !row.timestamp || !row.payload) continue
    spans.push(asTracesSpan(contractSpan({
      traceId: root.trace_id,
      spanId: deriveHexId(`codex:${session.nativeSessionId}:legacy-prompt:${row.payload.id ?? row.timestamp}`, 8),
      parentSpanId: root.span_id,
      name: 'user.prompt',
      kind: 'CHAIN',
      startTime: row.timestamp,
      endTime: row.timestamp,
      attributes: { 'service.name': 'codex', 'tangle.actor': session.parentNativeSessionId ? 'subagent-spawn' : 'human', content: row.payload.content },
    })))
  }
}

/** The compatibility boundary between traces' session selection and the shared native reader. */
export class HarnessSessionsAdapter implements HarnessTraceAdapter {
  readonly harness: string
  readonly aliases: readonly string[]
  private readonly reader
  private readonly refs = new Map<string, NativeRef>()
  private readonly legacyOpencode: OpencodeAdapter | undefined
  private readonly scopedAdapter: ClaudeAdapter | CodexAdapter | undefined

  constructor(readonly nativeHarness: SupportedHarness, displayHarness?: string, aliases: readonly string[] = []) {
    this.reader = readerFor(nativeHarness)
    this.harness = displayHarness ?? nativeHarness
    this.aliases = aliases
    this.legacyOpencode = nativeHarness === 'opencode' ? new OpencodeAdapter() : undefined
    this.scopedAdapter = nativeHarness === 'claude-code' ? new ClaudeAdapter()
      : nativeHarness === 'codex' ? new CodexAdapter() : undefined
  }

  /**
   * Sessions under `home` through the shared reader, which reads the recorded
   * cwd and, for Codex, every Codex home and the id in `session_meta`. `home`
   * is HOME or a store root such as a trace archive's `<host>/home`.
   */
  async locateIn(home: string, opts: LocateOptions & { nativeSessionId?: string } = {}): Promise<SessionRef[]> {
    const found = await this.reader.locate(home, { nativeSessionId: opts.nativeSessionId, sinceMs: opts.sinceMs, cwd: opts.cwd })
    const refs = found
      .filter((native) => this.nativeHarness !== 'claude-code' || native.parentNativeSessionId === null)
      .map((native) => {
        const ref = tracesRef(native, this.harness)
        // Claude Code and Codex parse a file ref the way an explicit session
        // path parses, so the same session reads the same whichever way it
        // was named. A shared store (OpenCode) needs the reader's own ref.
        if (!this.scopedAdapter) this.refs.set(`${ref.sessionId}\0${ref.path}`, native)
        return ref
      })
    if (this.legacyOpencode) {
      // This machine's own legacy store follows XDG_DATA_HOME; a store root's sits in its layout.
      const own = resolve(home) === resolve(ownHome())
      const legacy = await this.legacyOpencode.locate({ sinceMs: opts.sinceMs, cwd: opts.cwd, ...(own ? {} : { home }) })
      refs.push(...legacy.filter((ref) => opts.nativeSessionId === undefined || ref.sessionId === opts.nativeSessionId))
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  /** Sessions under HOME, or under the store root `opts.home` names, through the shared reader. */
  async locate(opts: LocateOptions = {}): Promise<SessionRef[]> {
    return this.locateIn(opts.home ?? ownHome(), opts)
  }

  async locateBySessionId(sessionId: string, opts: LocateOptions = {}): Promise<SessionRef[]> {
    return (await this.locateIn(opts.home ?? ownHome(), { ...opts, nativeSessionId: sessionId })).filter((ref) => ref.sessionId === sessionId)
  }

  /**
   * The repository a session recorded for itself, normalized by the caller:
   * Codex writes `git.repository_url` into `session_meta`. Other harnesses
   * record no repository, so they have none.
   */
  async recordedRepository(ref: SessionRef): Promise<string | null> {
    if (this.nativeHarness !== 'codex') return null
    const url = (await codexMeta(ref.path))?.git?.repository_url
    return typeof url === 'string' && url.length > 0 ? url : null
  }

  async sourcePaths(ref: SessionRef): Promise<readonly string[]> {
    if (this.legacyOpencode && !ref.path.endsWith('.db')) return this.legacyOpencode.sourcePaths(ref)
    const paths = (await this.resolveNativeRef(ref))?.files ?? [ref.path]
    if (this.nativeHarness !== 'factory-droids') return paths
    const settings = ref.path.replace(/\.jsonl$/u, '.settings.json')
    if (paths.includes(settings)) return paths
    try {
      await stat(settings)
      return [...paths, settings]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return paths
      throw error
    }
  }

  private async resolveNativeRef(ref: SessionRef): Promise<NativeRef | undefined> {
    const key = `${ref.sessionId}\0${ref.path}`
    const cached = this.refs.get(key)
    if (cached) return cached
    if (this.scopedAdapter instanceof ClaudeAdapter) {
      const native = claudeCodeRefForFile(ref.path)
      let files: readonly string[]
      try {
        files = await this.scopedAdapter.sourcePaths(ref)
      } catch (error) {
        if (!stringTooLong(error)) throw error
        files = [ref.path]
      }
      const found = {
        ...native,
        // A retained capture's filename cannot establish native identity.
        // The shared fold replaces this sentinel only when records name one.
        nativeSessionId: ref.sessionId.startsWith('unattributed:') ? ref.sessionId : native.nativeSessionId,
        files: files.filter((path) => path.endsWith('.jsonl')),
      }
      this.refs.set(key, found)
      return found
    }
    return undefined
  }

  async parse(ref: SessionRef, options: ParseOptions = {}): Promise<OtlpSpan[]> {
    if (this.legacyOpencode && !ref.path.endsWith('.db')) return this.legacyOpencode.parse(ref, options)
    // Scoped/cited reads retain their existing projection; ordinary sessions use the shared fold.
    if (this.scopedAdapter && (options.taskScope === 'latest' || options.taskScope === 'turn' || options.captureSources)) {
      return this.scopedAdapter.parse(ref, options)
    }
    if (this.scopedAdapter instanceof ClaudeAdapter && await isClaudeStreamJson(ref.path)) {
      return this.scopedAdapter.parse(ref, options)
    }
    // A forked Codex child starts with its parent's history, rewritten to the fork time.
    // The shared fold has no task scope yet (U18), so it would count that history as the
    // child's own work; traces' own reader scopes a child to the task it was given.
    if (this.scopedAdapter instanceof CodexAdapter && await codexForkPrefix(ref.path)) {
      return this.scopedAdapter.parse(ref, options)
    }
    options.signal?.throwIfAborted()
    let source = options.includeSubagents === false && this.nativeHarness === 'claude-code'
      ? nativeRef(this.nativeHarness, ref) : await this.resolveNativeRef(ref)
    if (!source && this.nativeHarness === 'opencode') {
      const matches = await opencodeSessionsInStore(ref.path, null, {
        ...(ref.sessionId.startsWith('ses_') ? { nativeSessionId: ref.sessionId } : {}),
      })
      if (matches.length !== 1) {
        throw new Error(`OpenCode store ${ref.path} contains ${matches.length} matching sessions; select one native session ID`)
      }
      source = matches[0]!
    }
    source ??= nativeRef(this.nativeHarness, ref)
    if (this.scopedAdapter instanceof ClaudeAdapter && source.files.some((path) => basename(path) === 'journal.jsonl')) return this.scopedAdapter.parse(ref, options)
    let session: HarnessSession
    try {
      session = await this.reader.read(source, {
        signal: options.signal,
        corruption: options.corruptionMode,
      })
    } catch (error) {
      // The 0.1.0 shared JSONL reader materializes each record as one string.
      // Preserve traces' bounded-row recovery for an over-limit Claude row.
      if (this.scopedAdapter instanceof ClaudeAdapter && stringTooLong(error)) {
        return this.scopedAdapter.parse(ref, options)
      }
      throw error
    }
    // A missing timestamp is not epoch work. Exclude it rather than allowing the
    // projection's display fallback to enter measured totals.
    if (!session.startedAt) return []
    let codex: CodexDecoration | undefined
    if (session.harness === 'codex') {
      const head = await takeJsonl<CodexHead>(ref.path, 40, { mode: 'recover', onCorruption: () => {} })
      codex = {
        meta: head.find((row) => row.type === 'session_meta')?.payload,
        typedTimes: () => codexUserMessageTimes(ref.path),
        legacyHead: head,
      }
    }
    const { spans, root } = await this.project(session, codex)
    if (session.harness === 'claude-code' && source.parentNativeSessionId === null) {
      const childPaths = source.files.filter((path) => path !== source.path && path.endsWith('.jsonl'))
      const toolByCallId = new Map(spans
        .filter((item) => item.attributes['openinference.span.kind'] === 'TOOL')
        .map((item) => [item.attributes['gen_ai.tool.call.id'], item]))
      let childSpanCount = 0
      const readIds = new Set<string>()
      for (const path of childPaths) {
        const childRef = claudeCodeRefForFile(path, session.nativeSessionId)
        const read = await this.reader.read(childRef, { signal: options.signal, corruption: options.corruptionMode })
        // Claude Code can write one agent ID to two transcripts (a top-level subagent and a
        // workflow run). Span identity derives from the session ID, so the later file takes
        // its directory as scope; its spans stay distinct, and only the first binds to the parent.
        const repeated = readIds.has(read.nativeSessionId)
        readIds.add(read.nativeSessionId)
        const child = repeated
          ? { ...read, nativeSessionId: `${read.nativeSessionId}@${basename(dirname(path))}` }
          : read
        if (!child.startedAt) continue
        const binding = repeated ? undefined : session.children.find((item) => item.nativeSessionId === child.nativeSessionId)
        const parent = binding?.toolCallId ? toolByCallId.get(binding.toolCallId) : undefined
        const projected = toOtlpSpans(child).map(asTracesSpan)
        stampNativeProvenance(child, projected)
        projected[0]!.parent_span_id = parent?.span_id ?? root.span_id
        for (const item of [...projected, ...presentationSpans(child, projected[0]!)]) {
          item.trace_id = root.trace_id
          item.attributes['traces.span.subagent'] = true
          item.attributes['traces.span.subagent_session_id'] = child.nativeSessionId
          item.attributes['traces.span.parent_session_id'] = session.nativeSessionId
          item.attributes['service.name'] = this.harness
          // Folded into this session's trace, the subagent's records belong to
          // this session: its own id stays in `traces.claude.source_trace_id`,
          // so the trace keeps one session identity.
          delete item.attributes['tangle.sessionId']
          spans.push(item)
          childSpanCount += 1
        }
      }
      if (childSpanCount > 0) root.attributes['traces.session.subagent_span_count'] = childSpanCount
    }
    return this.finish(session, spans)
  }

  /**
   * The shared reader's session as traces' spans, before any subagent is
   * folded in: the one projection a whole read and a piece read both take.
   */
  private async project(session: HarnessSession, codex?: CodexDecoration): Promise<{ spans: OtlpSpan[]; root: OtlpSpan; promptSeen: boolean }> {
    const spans = toOtlpSpans(session).map(asTracesSpan)
    const root = spans[0]!
    root.attributes['service.name'] = this.harness
    root.attributes['traces.session.role'] = session.parentNativeSessionId ? 'child' : 'operator'
    // The directory the shared reader read from the session's own records.
    if (session.cwd) root.attributes[SESSION_CWD_ATTR] = session.cwd
    if (session.parentNativeSessionId) root.attributes['traces.parent_session_id'] = session.parentNativeSessionId
    // Children a selection joins as their own sessions. Claude Code subagent
    // transcripts are folded into this trace instead, so they are not.
    if (session.children.length > 0 && session.harness !== 'claude-code') {
      root.attributes['traces.child_session_ids'] = JSON.stringify(session.children.map((child) => child.nativeSessionId))
    }
    root.attributes['traces.session.corruption_count'] = session.integrity.unparsedRecords
    root.attributes['traces.session.integrity'] = session.integrity.unparsedRecords > 0
      || session.integrity.truncated || session.integrity.gaps.length > 0
      ? 'degraded_not_lossless' : 'complete'
    if (session.integrity.unparsedRecords > 0) {
      root.attributes['traces.source.unreadable_rows'] = session.integrity.unparsedRecords
    }
    // The session-total counter is distinct from a sum of individual calls.
    // The shared reader's input excludes the cache; the counter's input is the
    // whole prompt, as traces' own Codex reader and `execution.ts` read it.
    const usage = session.usage
    if ((session.harness === 'codex' || session.harness === 'factory-droids') && usage?.input != null && usage.output != null) {
      const input = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
      root.attributes[SESSION_TOTAL_TOKENS_ATTR] = input + usage.output
      root.attributes[SESSION_TOTAL_INPUT_ATTR] = input
      root.attributes[SESSION_TOTAL_OUTPUT_ATTR] = usage.output
      if (usage.cacheRead != null) root.attributes[SESSION_TOTAL_CACHED_INPUT_ATTR] = usage.cacheRead
      if (usage.cacheWrite != null) root.attributes[SESSION_TOTAL_CACHE_WRITE_ATTR] = usage.cacheWrite
      if (usage.reasoning != null) root.attributes[SESSION_TOTAL_REASONING_ATTR] = usage.reasoning
      root.attributes['traces.session.total_tokens_source'] = '@tangle-network/harness-sessions'
    }
    spans.push(...presentationSpans(session, root))
    let promptSeen = false
    if (session.harness === 'codex' && codex) {
      decorateCodexTools(session, spans)
      promptSeen = await decorateCodexMeta(codex, root, spans)
      if (codex.legacyHead) addLegacyPrompts(codex.legacyHead, session, root, spans)
    }
    if (session.harness === 'claude-code') decorateClaudeSpawns(session, spans)
    stampNativeProvenance(session, spans)
    spans.push(...lifecycleSpans(session, root, spans))
    return { spans, root, promptSeen }
  }

  private finish(session: HarnessSession, spans: OtlpSpan[]): OtlpSpan[] {
    if (session.harness === 'claude-code') {
      const traceId = deriveHexId(session.nativeSessionId, 16)
      for (const item of spans) item.trace_id = traceId
    }
    for (const item of spans) item.attributes['service.name'] ??= this.harness
    return spans
  }

  /**
   * True when the turn index may read this session's file a piece at a time
   * (Claude Code and Codex JSONL); any other session it reads whole whenever
   * the session changes. `first` is the file's first piece, which says
   * whether its layout allows it: `claude -p` stream-json, a Codex rollout
   * with no `session_meta` at its head, and one in the older plain-string
   * prompt form are read whole.
   */
  readsPieces(ref: SessionRef, first?: readonly PieceRecord[]): boolean {
    if (!ref.path.endsWith('.jsonl') || ref.sessionId.startsWith('unattributed:')) return false
    if (this.nativeHarness !== 'claude-code' && this.nativeHarness !== 'codex') return false
    if (first === undefined) return true
    const records = first.filter((record): record is Record<string, unknown> => record !== null)
    if (this.nativeHarness === 'claude-code') return !records.some((record) => record.type === 'system' && record.subtype === 'init')
    // A forked child is read whole by traces' own reader (`parse`), so the index reads it whole too.
    const head = records.slice(0, 40) as CodexHead[]
    return records.some((record) => record.type === 'session_meta') && !hasForkPrefix(head) && !head.some((record) => isLegacyPrompt(record))
  }

  /**
   * One piece of a session file read on its own: records the turn index found
   * appended since it last read the file, one entry per line (null for a
   * blank or unreadable line). `carry` is what the pieces before it
   * established; the next piece starts from the carry this returns. The fold
   * and projection are `parse`'s, so a session read in pieces cut where
   * {@link pieceBoundary} says yields the spans one read of it does, less the
   * subagents a whole read folds in.
   */
  async readPiece(ref: SessionRef, records: readonly PieceRecord[], carry: PieceCarry = PIECE_START): Promise<{ spans: OtlpSpan[]; carry: PieceCarry }> {
    const native = nativeRef(this.nativeHarness, ref)
    // Codex reads its session_meta once, numbers its responses from the
    // session's start, and skips a token count that repeats the last one:
    // replay all three before the piece, as records whose own output is
    // dropped below.
    const primer: Record<string, unknown>[] = []
    if (this.nativeHarness === 'codex') {
      if (carry.meta) primer.push({ type: 'session_meta', payload: carry.meta })
      if (carry.tokens) primer.push({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: carry.tokens } } })
      for (let call = 0; call < carry.calls; call += 1) primer.push({ type: 'event_msg', payload: { type: 'stream_error', message: 'earlier piece' } })
    }
    // The piece's records keep their file lines, since a record without an id is
    // named by its line; the primer takes the lines just before them.
    const read = readSessionInput(this.nativeHarness, { records: [...primer, ...records] }, {
      nativeSessionId: carry.nativeSessionId ?? native.nativeSessionId,
      parentNativeSessionId: carry.parentNativeSessionId ?? native.parentNativeSessionId,
      label: ref.path,
      firstLine: carry.lines - primer.length + 1,
    })
    const session: HarnessSession = {
      ...read,
      nativeSessionId: carry.nativeSessionId ?? read.nativeSessionId,
      parentNativeSessionId: carry.parentNativeSessionId ?? read.parentNativeSessionId,
      cwd: carry.cwd ?? read.cwd,
      modelCalls: read.modelCalls.slice(carry.calls),
    }
    const present = records.filter((record): record is Record<string, unknown> => record !== null)
    const metaRecord = present.find((record) => record.type === 'session_meta')?.payload as CodexHead['payload'] | undefined
    const meta = carry.meta ?? (metaRecord ? codexMetaSummary(metaRecord) : null)
    const tokens = this.nativeHarness === 'codex' ? codexScan(records, carry).tokens : null
    let spans: OtlpSpan[] = []
    let promptSeen = carry.promptSeen
    if (session.startedAt) {
      const fold = typedTimesFold()
      for (const record of present) fold.add(record as CodexHead)
      const typed = fold.result()
      const projected = await this.project(session, this.nativeHarness === 'codex'
        ? { meta: meta ?? undefined, typedTimes: async () => typed, promptSeen }
        : undefined)
      spans = this.finish(session, projected.spans)
      promptSeen = projected.promptSeen
    }
    return {
      spans,
      carry: {
        lines: carry.lines + records.length,
        nativeSessionId: session.nativeSessionId,
        parentNativeSessionId: session.parentNativeSessionId,
        cwd: session.cwd,
        calls: read.modelCalls.length,
        tokens,
        meta,
        promptSeen,
      },
    }
  }

  async resolveParentTask(ref: SessionRef, childSessionId: string, options?: Pick<ParseOptions, 'corruptionMode' | 'signal'>): Promise<ParentTaskResolution> {
    if (this.scopedAdapter instanceof CodexAdapter) {
      return this.scopedAdapter.resolveParentTask(ref, childSessionId, options)
    }
    return { kind: 'unavailable', reason: 'parent-turn-metadata-missing' }
  }

  /**
   * Join a Codex parent's `spawn_agent` calls to the child rollouts they made,
   * by the exact pair (parent thread id, agent path) each child stamps in its
   * `session_meta`. Candidates come from the shared reader under the same home
   * or store root the parent was read from; only their heads are read.
   */
  async locateSpawnedChildren(
    parentSessionId: string,
    agentPaths: readonly string[],
    options: LocateOptions & Pick<ParseOptions, 'corruptionMode' | 'signal'> = {},
  ): Promise<readonly SpawnedChildResolution[]> {
    const wanted = [...new Set(agentPaths)].filter((path) => path.length > 0)
    if (this.nativeHarness !== 'codex') return wanted.map((agentPath) => ({ agentPath, reason: 'not-found' as const }))
    if (wanted.length === 0 || parentSessionId.length === 0) return []
    const children = (await this.reader.locate(options.home ?? ownHome()))
      .filter((native) => native.parentNativeSessionId === parentSessionId)
    const matches = new Map<string, SessionRef[]>()
    for (const native of children) {
      options.signal?.throwIfAborted()
      const meta = await codexMeta(native.path)
      const spawn = meta?.source?.subagent?.thread_spawn
      const agentPath = meta?.agent_path ?? spawn?.agent_path
      if (typeof agentPath !== 'string' || !wanted.includes(agentPath)) continue
      matches.set(agentPath, [...(matches.get(agentPath) ?? []), tracesRef(native, this.harness)])
    }
    return wanted.map((agentPath) => {
      const found = matches.get(agentPath) ?? []
      if (found.length === 1) return { agentPath, ref: found[0]! }
      if (found.length === 0) return { agentPath, reason: 'not-found' as const }
      return { agentPath, reason: 'ambiguous' as const, candidates: found.map((ref) => ref.sessionId).sort() }
    })
  }
}

/** True for an adapter that reads a store root (`LocateOptions.home`) instead of HOME. */
export function readsStoreRoots(adapter: HarnessTraceAdapter): adapter is HarnessSessionsAdapter {
  return adapter instanceof HarnessSessionsAdapter
}

export const SHARED_SESSION_ADAPTERS: readonly HarnessTraceAdapter[] = [
  new HarnessSessionsAdapter('claude-code', 'claude-code', ['claude', 'claudish', 'openclaw', 'nanoclaw']),
  new HarnessSessionsAdapter('codex', 'codex', ['codex-acp']),
  new HarnessSessionsAdapter('opencode'),
  new HarnessSessionsAdapter('pi'),
  new HarnessSessionsAdapter('kimi-code', 'kimi', ['kimi-code']),
  new HarnessSessionsAdapter('factory-droids', 'factory', ['factory-droids', 'droid']),
]
