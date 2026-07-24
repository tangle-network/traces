/**
 * Claude Code adapter — `~/.claude/projects/<encoded-cwd>/<session>.jsonl`.
 *
 * Each line is one transcript event: `user`, `assistant`, `attachment`,
 * plus metadata events we ignore. Assistant events carry `message.usage`
 * (token trajectory) and `message.content[]` tool_use blocks; tool results
 * arrive as `tool_result` blocks in the following user message or as a
 * `tool_result` attachment. Subagent runs live in a sibling
 * `<session>/subagents/agent-*.jsonl` with a `.meta.json` carrying the
 * spawning `toolUseId`, so we parent each subagent under its `Agent` call.
 *
 * Shared by the claudish / openclaw / nanoclaw forks via aliases — they
 * write the same transcript shape.
 */

import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { sessionJsonlOptions } from '../integrity.js'
import { appendAll } from '../arrays.js'
import { isMissingJsonSource, isMissingPathError, readJsonFile } from '../json.js'
import { readJsonl } from '../jsonl.js'
import type { OtlpSpan, OtlpStatusCode } from '../otlp.js'
import { span } from '../otlp.js'
import type { HarnessTraceAdapter, LocateOptions, ParseOptions, SessionRef } from '../types.js'
import { claudeActor } from './actor.js'
import { capText, userPromptSpan } from './conversation.js'
import { toolIoAttributes } from './tool-io.js'

const SERVICE = 'claude-code'
const EPOCH = new Date(0).toISOString()

interface ClaudeEvent {
  type?: string
  uuid?: string
  parentUuid?: string | null
  sessionId?: string
  timestamp?: string
  cwd?: string
  isSidechain?: boolean
  userType?: string
  message?: {
    role?: string
    model?: string
    content?: unknown
    stop_reason?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  attachment?: {
    type?: string
    toolUseID?: string
    toolName?: string
    exitCode?: number
    stderr?: string
  }
}

interface BlockText {
  type?: string
  id?: string
  name?: string
  input?: unknown
  text?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function asBlocks(content: unknown): BlockText[] {
  return Array.isArray(content) ? (content as BlockText[]) : []
}

/** Join a message's `text` blocks (the human's prompt or the assistant's prose)
 *  into one capped string. A string body (some events) is taken verbatim. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return capText(content)
  return capText(
    asBlocks(content)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n'),
  )
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as BlockText).text ?? '') : ''))
      .join('')
  }
  return ''
}

export interface ParsedStream {
  spans: OtlpSpan[]
  /** Maps a tool_use id → the TOOL span id, so results can backfill status. */
  toolSpanByUseId: Map<string, OtlpSpan>
  nextStep: number
}

interface ClaudeStreamContext {
  traceId: string
  agent: string
  startStep: number
  idPrefix: string
  rootParent: string | null
}

interface ClaudeStreamState {
  spans: OtlpSpan[]
  toolSpanByUseId: Map<string, OtlpSpan>
  step: number
  sawUserTurn: boolean
}

function createClaudeStream(startStep: number): ClaudeStreamState {
  return { spans: [], toolSpanByUseId: new Map(), step: startStep, sawUserTurn: false }
}

type SeenClaudeEvents = Map<string, string>

class ClaudeEventConflictError extends Error {
  readonly sourcePath: string
  readonly eventId: string

  constructor(sourcePath: string, eventId: string) {
    super(`${sourcePath}: Claude transcript event ${JSON.stringify(eventId)} has conflicting payloads`)
    this.name = 'ClaudeEventConflictError'
    this.sourcePath = sourcePath
    this.eventId = eventId
  }
}

interface ToolResultProjection {
  toolUseId: string
  isError: boolean
  attributes: Record<string, unknown>
  message: string
}

type ClaudeEventProjection =
  | {
      kind: 'assistant'
      timestamp: string
      model: string | null
      inputTokens: number | null
      outputTokens: number | null
      cachedInputTokens: number | null
      cacheWriteInputTokens: number | null
      content: string | null
      tools: Array<{ id: string | null; name: string; attributes: Record<string, unknown> }>
    }
  | {
      kind: 'user'
      timestamp: string
      prompt: string | null
      isSidechain?: boolean
      userType?: string | null
      results: ToolResultProjection[]
    }
  | { kind: 'attachment'; timestamp: string; result: ToolResultProjection }
  | { kind: 'ignored' }

function projectToolResult(toolUseId: string, isError: boolean, output: unknown): ToolResultProjection {
  return {
    toolUseId,
    isError,
    attributes: toolIoAttributes({ output }),
    message: stringifyToolResult(output).slice(0, 500),
  }
}

function projectClaudeEvent(event: ClaudeEvent): ClaudeEventProjection {
  const timestamp = event.timestamp ?? EPOCH
  if (event.type === 'assistant' && event.message) {
    const tools: Array<{ id: string | null; name: string; attributes: Record<string, unknown> }> = []
    for (const block of asBlocks(event.message.content)) {
      if (block.type !== 'tool_use' || !block.name) continue
      tools.push({ id: block.id || null, name: block.name, attributes: toolIoAttributes({ input: block.input }) })
    }
    return {
      kind: 'assistant',
      timestamp,
      model: event.message.model ?? null,
      inputTokens: event.message.usage?.input_tokens ?? null,
      outputTokens: event.message.usage?.output_tokens ?? null,
      cachedInputTokens: event.message.usage?.cache_read_input_tokens ?? null,
      cacheWriteInputTokens: event.message.usage?.cache_creation_input_tokens ?? null,
      content: textOf(event.message.content) || null,
      tools,
    }
  }
  if (event.type === 'user' && event.message) {
    const results: ToolResultProjection[] = []
    for (const block of asBlocks(event.message.content)) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      results.push(projectToolResult(block.tool_use_id, block.is_error === true, block.content))
    }
    const prompt = textOf(event.message.content)
    return {
      kind: 'user',
      timestamp,
      prompt: prompt || null,
      ...(prompt ? { isSidechain: event.isSidechain, userType: event.userType ?? null } : {}),
      results,
    }
  }
  if (event.type === 'attachment' && event.attachment?.type === 'tool_result' && event.attachment.toolUseID) {
    return {
      kind: 'attachment',
      timestamp,
      result: projectToolResult(
        event.attachment.toolUseID,
        typeof event.attachment.exitCode === 'number' && event.attachment.exitCode !== 0,
        event.attachment.stderr ?? '',
      ),
    }
  }
  return { kind: 'ignored' }
}

function fingerprintClaudeEvent(event: ClaudeEventProjection): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex')
}

/**
 * Claude occasionally persists the same event twice. A repeated UUID with the
 * same span-producing fields is one logical event; a changed emitted field is
 * corruption that must remain visible to callers.
 */
function consumeDistinctClaudeEvent(
  event: ClaudeEvent,
  ctx: ClaudeStreamContext,
  state: ClaudeStreamState,
  seen: SeenClaudeEvents,
  sourcePath: string,
): boolean {
  const projection = projectClaudeEvent(event)
  if (event.uuid) {
    const fingerprint = fingerprintClaudeEvent(projection)
    const previous = seen.get(event.uuid)
    if (previous !== undefined) {
      if (previous !== fingerprint) {
        throw new ClaudeEventConflictError(sourcePath, event.uuid)
      }
      return false
    }
    seen.set(event.uuid, fingerprint)
  }
  consumeClaudeEvent(projection, event.uuid ?? `${ctx.idPrefix}step${state.step}`, ctx, state)
  return true
}

function consumeClaudeEvent(
  event: ClaudeEventProjection,
  uid: string,
  ctx: ClaudeStreamContext,
  state: ClaudeStreamState,
): void {
  if (event.kind === 'assistant') {
    const llmId = `${ctx.idPrefix}${uid}`
    state.spans.push(
      span({
        traceId: ctx.traceId,
        spanId: llmId,
        parentSpanId: ctx.rootParent,
        name: 'llm.turn',
        kind: 'LLM',
        startTime: event.timestamp,
        service: SERVICE,
        agent: ctx.agent,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cachedInputTokens: event.cachedInputTokens,
        cacheWriteInputTokens: event.cacheWriteInputTokens,
        step: state.step,
        content: event.content,
      }),
    )
    state.step += 1

    let toolIdx = 0
    for (const tool of event.tools) {
      const toolSpan = span({
        traceId: ctx.traceId,
        spanId: `${ctx.idPrefix}${uid}:tool:${toolIdx}`,
        parentSpanId: llmId,
        name: `tool.${tool.name}`,
        kind: 'TOOL',
        startTime: event.timestamp,
        service: SERVICE,
        agent: ctx.agent,
        tool: tool.name,
        step: state.step,
        extra: tool.attributes,
      })
      state.spans.push(toolSpan)
      if (tool.id) state.toolSpanByUseId.set(tool.id, toolSpan)
      toolIdx += 1
      state.step += 1
    }
  } else if (event.kind === 'user') {
    if (event.prompt) {
      const actor = claudeActor({
        text: event.prompt,
        isSidechain: event.isSidechain,
        userType: event.userType ?? null,
        isFirstUserTurn: !state.sawUserTurn,
      })
      state.sawUserTurn = true
      state.spans.push(
        userPromptSpan({
          traceId: ctx.traceId,
          spanId: `${ctx.idPrefix}${uid}:user`,
          parentSpanId: ctx.rootParent,
          startTime: event.timestamp,
          service: SERVICE,
          agent: ctx.agent,
          step: state.step,
          content: event.prompt,
          actor,
        }),
      )
      state.step += 1
    }
    for (const result of event.results) {
      backfillResult(state.toolSpanByUseId.get(result.toolUseId), event.timestamp, result)
    }
  } else if (event.kind === 'attachment') {
    backfillResult(state.toolSpanByUseId.get(event.result.toolUseId), event.timestamp, event.result)
  }
}

function finishClaudeStream(state: ClaudeStreamState): ParsedStream {
  return { spans: state.spans, toolSpanByUseId: state.toolSpanByUseId, nextStep: state.step }
}

function setRootTimeBounds(root: OtlpSpan, spans: readonly OtlpSpan[]): void {
  let firstTimestamp: { value: number; source: string } | undefined
  let lastTimestamp: { value: number; source: string } | undefined

  for (const item of spans) {
    if (item === root) continue
    for (const source of [item.start_time, item.end_time]) {
      if (!source) continue
      const value = Date.parse(source)
      if (!Number.isFinite(value)) continue
      if (!firstTimestamp || value < firstTimestamp.value) firstTimestamp = { value, source }
      if (!lastTimestamp || value > lastTimestamp.value) lastTimestamp = { value, source }
    }
  }

  if (firstTimestamp) root.start_time = firstTimestamp.source
  if (lastTimestamp) root.end_time = lastTimestamp.source
}

/**
 * Project one event stream (a main session or a subagent sidechain) onto
 * spans. `idPrefix` keeps span ids unique when folding subagents into the
 * parent trace.
 */
export function parseClaudeStream(events: readonly ClaudeEvent[], ctx: ClaudeStreamContext): ParsedStream {
  const state = createClaudeStream(ctx.startStep)
  const seen = new Map<string, string>()
  for (const event of events) consumeDistinctClaudeEvent(event, ctx, state, seen, '<stream>')
  return finishClaudeStream(state)
}

function backfillResult(s: OtlpSpan | undefined, endTime: string, result: ToolResultProjection): void {
  if (!s) return
  s.end_time = endTime
  const code: OtlpStatusCode = result.isError ? 'ERROR' : 'OK'
  s.status = { code }
  Object.assign(s.attributes, result.attributes)
  if (result.isError && result.message) s.status.message = result.message
}

interface SubagentMeta {
  agentType?: string
  description?: string
  toolUseId?: string
}

export class ClaudeAdapter implements HarnessTraceAdapter {
  readonly harness = 'claude-code'
  readonly aliases = ['claude', 'claudish', 'openclaw', 'nanoclaw'] as const

  private root(): string {
    return join(homedir(), '.claude', 'projects')
  }

  async locate(opts: LocateOptions = {}): Promise<SessionRef[]> {
    const root = this.root()
    let projectDirs: string[]
    try {
      projectDirs = await readdir(root)
    } catch (error) {
      if (isMissingPathError(error)) return []
      throw error
    }
    const refs: SessionRef[] = []
    for (const dir of projectDirs) {
      const dirPath = join(root, dir)
      let files: string[]
      try {
        files = await readdir(dirPath)
      } catch (error) {
        if (isMissingPathError(error)) continue
        throw error
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const path = join(dirPath, f)
        let st: Awaited<ReturnType<typeof stat>>
        try {
          st = await stat(path)
        } catch (error) {
          if (isMissingPathError(error)) continue
          throw error
        }
        if (!st.isFile()) continue
        if (opts.sinceMs && st.mtimeMs < opts.sinceMs) continue
        // Encoded cwd: leading dashes for path separators. Decode best-effort.
        const cwd = `/${dir.replace(/^-/, '').replace(/-/g, '/')}`
        if (opts.cwd && !cwd.startsWith(opts.cwd)) continue
        refs.push({ harness: this.harness, sessionId: basename(f, '.jsonl'), path, cwd, mtimeMs: st.mtimeMs })
      }
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async parse(ref: SessionRef, options: ParseOptions = {}): Promise<OtlpSpan[]> {
    const sourceTraceId = ref.sessionId
    const sourceRootId = `root:${sourceTraceId}`
    const ctx: ClaudeStreamContext = {
      traceId: sourceTraceId,
      agent: SERVICE,
      startStep: 0,
      idPrefix: '',
      rootParent: sourceRootId,
    }
    const state = createClaudeStream(ctx.startStep)
    let discoveredTraceId: string | undefined
    const seen = new Map<string, string>()

    for await (const event of readJsonl<ClaudeEvent>(ref.path, sessionJsonlOptions(ref, options))) {
      if (!discoveredTraceId && event.sessionId) discoveredTraceId = event.sessionId
      if (!consumeDistinctClaudeEvent(event, ctx, state, seen, ref.path)) continue
    }

    const main = finishClaudeStream(state)
    const traceId = discoveredTraceId ?? sourceTraceId
    const rootId = `root:${traceId}`
    for (const item of main.spans) {
      item.trace_id = traceId
      if (item.parent_span_id === sourceRootId) item.parent_span_id = rootId
    }
    const root = span({
      traceId,
      spanId: rootId,
      parentSpanId: null,
      name: 'session',
      kind: 'AGENT',
      startTime: new Date(0).toISOString(),
      service: SERVICE,
      agent: SERVICE,
    })
    const spans: OtlpSpan[] = [root]
    appendAll(spans, main.spans)

    await this.foldSubagents(ref, traceId, main, spans, options)
    setRootTimeBounds(root, spans)
    return spans
  }

  /** Parse `<session>/subagents/agent-*.jsonl`, parenting each under its Agent call. */
  private async foldSubagents(
    ref: SessionRef,
    traceId: string,
    main: ParsedStream,
    out: OtlpSpan[],
    options: ParseOptions,
  ): Promise<void> {
    const subDir = join(ref.path.replace(/\.jsonl$/, ''), 'subagents')
    let files: string[]
    try {
      files = await readdir(subDir)
    } catch (error) {
      if (isMissingPathError(error)) return
      throw error
    }
    let step = main.nextStep
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const hash = basename(file, '.jsonl')
      const metaPath = join(subDir, `${hash}.meta.json`)
      let meta: SubagentMeta = {}
      try {
        meta = await readJsonFile<SubagentMeta>(metaPath)
      } catch (error) {
        if (!isMissingJsonSource(error)) throw error
      }
      const parent = (meta.toolUseId && main.toolSpanByUseId.get(meta.toolUseId)?.span_id) || `root:${traceId}`
      const ctx: ClaudeStreamContext = {
        traceId,
        agent: meta.agentType ? `subagent:${meta.agentType}` : 'subagent',
        startStep: step,
        idPrefix: `${hash}:`,
        rootParent: parent,
      }
      const state = createClaudeStream(ctx.startStep)
      const seen = new Map<string, string>()
      for await (const event of readJsonl<ClaudeEvent>(
        join(subDir, file),
        sessionJsonlOptions(ref, options),
      )) {
        consumeDistinctClaudeEvent(event, ctx, state, seen, join(subDir, file))
      }
      const parsed = finishClaudeStream(state)
      appendAll(out, parsed.spans)
      step = parsed.nextStep
    }
  }
}
