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

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
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
} from '../types.js'
import { codexActor } from './actor.js'
import { capText, userPromptSpan } from './conversation.js'
import {
  type CodexLine,
  type CodexTokenUsage,
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
import { recordToolOutput, toolIoAttributes } from './tool-io.js'

export { CodexTaskScopeError } from './codex-task-scope.js'

const SERVICE = 'codex'
const SESSION_HEAD_LINES = 40

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
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value)
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
    for (const key of ['exit_code', 'exitCode']) {
      const code = numericStatus(row[key])
      if (code !== undefined && ('output' in row || 'chunk_id' in row || 'wall_time_seconds' in row)) {
        return code !== 0
      }
    }
    for (const key of ['timed_out', 'timedOut']) {
      if (row[key] === true && timeoutIsError) return true
    }
    if (typeof row.succeeded === 'boolean' && ('value' in row || 'error' in row)) {
      return !row.succeeded
    }
    if ((row.type === 'input_text' || row.type === 'text') && typeof row.text === 'string') {
      return explicitOutputError(row.text, timeoutIsError)
    }
    return undefined
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
  if (/^Chunk ID:/i.test(header)) {
    const exitCode = header.match(/^Process exited with code\s+(-?\d+)\b/im)?.[1]
    if (exitCode !== undefined) return Number(exitCode) !== 0
  }
  if (/^Script completed\s*\nWall time:/i.test(header)) return false
  if (/^Script failed\s*\nWall time:/i.test(header)) return true
  const scriptExitCode = header.match(/^Script error:\s*\nExit code:\s*(-?\d+)\b/im)?.[1]
  if (scriptExitCode !== undefined) return Number(scriptExitCode) !== 0
  const commandExitCode = text.match(/^Command failed with exit code\s+(-?\d+)\.?$/i)?.[1]
  if (commandExitCode !== undefined) return Number(commandExitCode) !== 0
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
function outputStatus(name: string, output: unknown): { error: boolean; message: string; pollOutcome?: 'timeout' } {
  const waitAgent = isWaitAgentOperation(name)
  const error = explicitOutputError(output, !waitAgent) === true
  const message = typeof output === 'string' ? output : JSON.stringify(output ?? '')
  return {
    error,
    message: error ? message.slice(0, 500) : '',
    ...(!error && waitAgent && explicitTimeout(output) ? { pollOutcome: 'timeout' as const } : {}),
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
          service: SERVICE,
          agent: SERVICE,
          tool: name,
          step,
          extra: {
            ...toolIoAttributes({ input }),
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
          const { error, message, pollOutcome } = outputStatus(name, l.payload.output)
          closeSpanAt(t, ts)
          t.status = error ? { code: 'ERROR', message } : { code: 'OK' }
          if (pollOutcome) t.attributes['traces.poll.outcome'] = pollOutcome
          recordToolOutput(t, l.payload.output)
          const operation = t.attributes['traces.codex.agent_operation']
          if (operation === 'spawn_agent') {
            setAgentSessionIds(t, spawnedSessionIds(l.payload.output))
          }
          if (typeof operation === 'string') {
            const requestId = agentRequestId(l.payload.output)
            if (requestId) t.attributes['traces.codex.agent_request_id'] = requestId
          }
        }
      } else if (l.type === 'event_msg' && l.payload?.type === 'sub_agent_activity') {
        const threadId = l.payload.agent_thread_id
        const occurredAtMs = l.payload.occurred_at_ms
        const eventTime = timestampFromEpochMs(occurredAtMs) ?? ts
        const eventCallSpan = toolByCallId.get(l.payload.event_id ?? '')
        if (eventCallSpan && threadId) setAgentSessionIds(eventCallSpan, [threadId])
        const agentPath = l.payload.agent_path ?? 'subagent'
        if (l.payload.kind === 'started' && threadId) {
          const toolSpan = ensureSubagentSpan(threadId, agentPath, eventTime, eventCallSpan, true)
          recordSubagentLifecycle(toolSpan, 'started', eventTime, l.payload.event_id)
        } else if (l.payload.kind === 'completed' && threadId) {
          const toolSpan = ensureSubagentSpan(threadId, agentPath, eventTime, eventCallSpan, false)
          recordSubagentLifecycle(toolSpan, 'completed', eventTime, l.payload.event_id)
          closeSpanAt(toolSpan, eventTime)
          toolSpan.status = { code: 'OK' }
        } else if (
          ['interrupted', 'failed', 'timed_out'].includes(l.payload.kind ?? '') &&
          threadId
        ) {
          const toolSpan = ensureSubagentSpan(threadId, agentPath, eventTime, eventCallSpan, false)
          recordSubagentLifecycle(toolSpan, l.payload.kind!, eventTime, l.payload.event_id)
          closeSpanAt(toolSpan, eventTime)
          toolSpan.status = { code: 'ERROR', message: `subagent ${l.payload.kind}` }
        } else if (l.payload.kind === 'interacted' && threadId) {
          const toolSpan = ensureSubagentSpan(threadId, agentPath, eventTime, eventCallSpan, false)
          recordSubagentLifecycle(toolSpan, 'interacted', eventTime, l.payload.event_id)
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
        const prompt = textOf(l.payload.content)
        if (prompt) {
          const actor = sessionRole === 'child'
            ? 'agent'
            : codexActor({ text: prompt, isFirstUserTurn: !sawUserTurn })
          sawUserTurn = true
          spans.push(
            userPromptSpan({
              traceId,
              spanId: `msg:${step}:user`,
              parentSpanId: rootId,
              startTime: ts,
              content: prompt,
              service: SERVICE,
              agent: SERVICE,
              step,
              actor,
            }),
          )
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
    if (selectedBoundary?.turnId) {
      for (const item of spans) item.attributes['traces.codex.turn_id'] ??= selectedBoundary.turnId
    }
    closeSpanAt(root, lastTimestamp ?? root.start_time)
    return spans
  }
}
