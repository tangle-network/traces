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

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import {
  applyLlmSpanOtlpAttributes,
  LLM_CACHED_TOKENS,
  LLM_CACHE_WRITE_TOKENS,
  LLM_INPUT_TOKENS,
  LLM_OUTPUT_TOKENS,
} from '@tangle-network/agent-eval/trace-attributes'
import { sessionJsonlOptions } from '../integrity.js'
import { isMissingJsonSource, isMissingPathError, readJsonFile } from '../json.js'
import { readJsonl } from '../jsonl.js'
import type { OtlpSpan, OtlpStatusCode } from '../otlp.js'
import { span } from '../otlp.js'
import type { HarnessTraceAdapter, LocateOptions, ParseOptions, SessionRef } from '../types.js'
import { claudeActor } from './actor.js'
import { capText, userPromptSpan } from './conversation.js'
import { recordToolOutput, toolIoAttributes } from './tool-io.js'

const SERVICE = 'claude-code'

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
    id?: string
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
  llmSpanByMessageId: Map<string, OtlpSpan>
  llmContentByMessageId: Map<string, Set<string>>
  toolCountByMessageId: Map<string, number>
  step: number
  sawUserTurn: boolean
}

function createClaudeStream(startStep: number): ClaudeStreamState {
  return {
    spans: [],
    toolSpanByUseId: new Map(),
    llmSpanByMessageId: new Map(),
    llmContentByMessageId: new Map(),
    toolCountByMessageId: new Map(),
    step: startStep,
    sawUserTurn: false,
  }
}

function consumeClaudeEvent(ev: ClaudeEvent, ctx: ClaudeStreamContext, state: ClaudeStreamState): void {
  const ts = ev.timestamp ?? new Date(0).toISOString()
  const uid = ev.uuid ?? `step${state.step}`

  if (ev.type === 'assistant' && ev.message) {
    const messageId = ev.message.id ?? uid
    let llmSpan = state.llmSpanByMessageId.get(messageId)
    if (!llmSpan) {
      llmSpan = span({
        traceId: ctx.traceId,
        spanId: `${ctx.idPrefix}${uid}`,
        parentSpanId: ctx.rootParent,
        name: 'llm.turn',
        kind: 'LLM',
        startTime: ts,
        service: SERVICE,
        agent: ctx.agent,
        model: ev.message.model ?? null,
        inputTokens: ev.message.usage?.input_tokens ?? null,
        outputTokens: ev.message.usage?.output_tokens ?? null,
        cachedInputTokens: ev.message.usage?.cache_read_input_tokens ?? null,
        cacheWriteInputTokens: ev.message.usage?.cache_creation_input_tokens ?? null,
        step: state.step,
      })
      state.spans.push(llmSpan)
      state.llmSpanByMessageId.set(messageId, llmSpan)
      state.step += 1
    } else {
      includeSpanTimestamp(llmSpan, ev.timestamp)
    }

    // Claude repeats cumulative usage as a response streams; preserve the highest captured total.
    applyLlmSpanOtlpAttributes(llmSpan.attributes, {
      model: ev.message.model,
      inputTokens: maxCapturedUsage(
        llmSpan.attributes[LLM_INPUT_TOKENS],
        ev.message.usage?.input_tokens,
      ),
      outputTokens: maxCapturedUsage(
        llmSpan.attributes[LLM_OUTPUT_TOKENS],
        ev.message.usage?.output_tokens,
      ),
      cachedTokens: maxCapturedUsage(
        llmSpan.attributes[LLM_CACHED_TOKENS],
        ev.message.usage?.cache_read_input_tokens,
      ),
      cacheWriteTokens: maxCapturedUsage(
        llmSpan.attributes[LLM_CACHE_WRITE_TOKENS],
        ev.message.usage?.cache_creation_input_tokens,
      ),
    })
    mergeMessageContent(llmSpan, messageId, textOf(ev.message.content), state)

    for (const block of asBlocks(ev.message.content)) {
      if (block.type !== 'tool_use' || !block.name) continue
      const existingTool = block.id ? state.toolSpanByUseId.get(block.id) : undefined
      if (existingTool) {
        Object.assign(existingTool.attributes, toolIoAttributes({ input: block.input }))
        includeSpanTimestamp(existingTool, ev.timestamp)
        continue
      }
      const toolIdx = state.toolCountByMessageId.get(messageId) ?? 0
      const toolSpan = span({
        traceId: ctx.traceId,
        spanId: `${llmSpan.span_id}:tool:${toolIdx}`,
        parentSpanId: llmSpan.span_id,
        name: `tool.${block.name}`,
        kind: 'TOOL',
        startTime: ts,
        service: SERVICE,
        agent: ctx.agent,
        tool: block.name,
        step: state.step,
        extra: toolIoAttributes({ input: block.input }),
      })
      state.spans.push(toolSpan)
      if (block.id) state.toolSpanByUseId.set(block.id, toolSpan)
      state.toolCountByMessageId.set(messageId, toolIdx + 1)
      state.step += 1
    }
  } else if (ev.type === 'user' && ev.message) {
    const prompt = textOf(ev.message.content)
    if (prompt) {
      const actor = claudeActor({
        text: prompt,
        isSidechain: ev.isSidechain,
        userType: ev.userType ?? null,
        isFirstUserTurn: !state.sawUserTurn,
      })
      state.sawUserTurn = true
      state.spans.push(
        userPromptSpan({
          traceId: ctx.traceId,
          spanId: `${ctx.idPrefix}${uid}:user`,
          parentSpanId: ctx.rootParent,
          startTime: ts,
          service: SERVICE,
          agent: ctx.agent,
          step: state.step,
          content: prompt,
          actor,
        }),
      )
      state.step += 1
    }
    for (const block of asBlocks(ev.message.content)) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      backfillResult(
        state.toolSpanByUseId.get(block.tool_use_id),
        ts,
        block.is_error === true,
        block.content,
      )
    }
  } else if (ev.type === 'attachment' && ev.attachment?.type === 'tool_result' && ev.attachment.toolUseID) {
    const err = typeof ev.attachment.exitCode === 'number' && ev.attachment.exitCode !== 0
    backfillResult(state.toolSpanByUseId.get(ev.attachment.toolUseID), ts, err, ev.attachment.stderr ?? '')
  }
}

function maxCapturedUsage(current: unknown, next: number | undefined): number | undefined {
  const captured = typeof current === 'number' && Number.isFinite(current) ? current : undefined
  if (next === undefined) return captured
  return captured === undefined ? next : Math.max(captured, next)
}

function includeSpanTimestamp(target: OtlpSpan, timestamp: string | undefined): void {
  if (!timestamp) return
  const time = Date.parse(timestamp)
  if (!Number.isFinite(time)) return
  const start = Date.parse(target.start_time)
  const end = Date.parse(target.end_time)
  if (!Number.isFinite(start) || time < start) target.start_time = timestamp
  if (!Number.isFinite(end) || time > end) target.end_time = timestamp
}

function mergeMessageContent(
  llmSpan: OtlpSpan,
  messageId: string,
  content: string,
  state: ClaudeStreamState,
): void {
  if (!content) return
  const parts = state.llmContentByMessageId.get(messageId) ?? new Set<string>()
  if (parts.has(content)) return
  parts.add(content)
  state.llmContentByMessageId.set(messageId, parts)
  llmSpan.attributes.content = capText([...parts].join('\n'))
}

function finishClaudeStream(state: ClaudeStreamState): ParsedStream {
  return { spans: state.spans, toolSpanByUseId: state.toolSpanByUseId, nextStep: state.step }
}

/**
 * Project one event stream (a main session or a subagent sidechain) onto
 * spans. `idPrefix` keeps span ids unique when folding subagents into the
 * parent trace.
 */
export function parseClaudeStream(events: readonly ClaudeEvent[], ctx: ClaudeStreamContext): ParsedStream {
  const state = createClaudeStream(ctx.startStep)
  for (const event of events) consumeClaudeEvent(event, ctx, state)
  return finishClaudeStream(state)
}

function backfillResult(s: OtlpSpan | undefined, endTime: string, isError: boolean, output: unknown): void {
  if (!s) return
  s.end_time = endTime
  const code: OtlpStatusCode = isError ? 'ERROR' : 'OK'
  s.status = { code }
  recordToolOutput(s, output)
  const message = stringifyToolResult(output)
  if (isError && message) s.status.message = message.slice(0, 500)
}

interface SubagentMeta {
  agentType?: string
  description?: string
  toolUseId?: string
  parentAgentId?: string
}

interface TimestampBounds {
  start?: string
  end?: string
}

function includeTimestamp(bounds: TimestampBounds, timestamp: string | undefined): void {
  if (!timestamp) return
  const time = Date.parse(timestamp)
  if (!Number.isFinite(time)) return
  if (!bounds.start || time < Date.parse(bounds.start)) bounds.start = timestamp
  if (!bounds.end || time > Date.parse(bounds.end)) bounds.end = timestamp
}

async function listSubagentFiles(root: string): Promise<string[]> {
  const pending = [root]
  const files: string[] = []
  while (pending.length > 0) {
    const dir = pending.pop()
    if (!dir) continue
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (isMissingPathError(error)) continue
      throw error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.isFile() && /^agent-.*\.jsonl$/.test(entry.name)) {
        files.push(path)
      }
    }
  }
  return files.sort()
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
    const bounds: TimestampBounds = {}

    for await (const event of readJsonl<ClaudeEvent>(ref.path, sessionJsonlOptions(ref, options))) {
      includeTimestamp(bounds, event.timestamp)
      if (!discoveredTraceId && event.sessionId) discoveredTraceId = event.sessionId
      consumeClaudeEvent(event, ctx, state)
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
      startTime: bounds.start ?? new Date(0).toISOString(),
      endTime: bounds.end,
      service: SERVICE,
      agent: SERVICE,
    })
    const spans: OtlpSpan[] = [root, ...main.spans]

    await this.foldSubagents(ref, traceId, main, spans, bounds, options)
    root.start_time = bounds.start ?? root.start_time
    root.end_time = bounds.end ?? root.start_time
    return spans
  }

  /** Parse `<session>/subagents/agent-*.jsonl`, parenting each under its Agent call. */
  private async foldSubagents(
    ref: SessionRef,
    traceId: string,
    main: ParsedStream,
    out: OtlpSpan[],
    bounds: TimestampBounds,
    options: ParseOptions,
  ): Promise<void> {
    const subDir = join(ref.path.replace(/\.jsonl$/, ''), 'subagents')
    const files = await listSubagentFiles(subDir)
    let step = main.nextStep
    const parsedAgents: Array<{
      agentId: string
      meta: SubagentMeta
      parsed: ParsedStream
    }> = []
    for (const file of files) {
      const sourceKey = relative(subDir, file)
        .replace(/\.jsonl$/, '')
        .split(/[\\/]/)
        .map((segment) => encodeURIComponent(segment))
        .join(':')
      const metaPath = file.replace(/\.jsonl$/, '.meta.json')
      let meta: SubagentMeta = {}
      try {
        meta = await readJsonFile<SubagentMeta>(metaPath)
      } catch (error) {
        if (!isMissingJsonSource(error)) throw error
      }
      const ctx: ClaudeStreamContext = {
        traceId,
        agent: meta.agentType ? `subagent:${meta.agentType}` : 'subagent',
        startStep: step,
        idPrefix: `${sourceKey}:`,
        rootParent: `root:${traceId}`,
      }
      const state = createClaudeStream(ctx.startStep)
      for await (const event of readJsonl<ClaudeEvent>(
        file,
        sessionJsonlOptions(ref, options),
      )) {
        includeTimestamp(bounds, event.timestamp)
        consumeClaudeEvent(event, ctx, state)
      }
      const parsed = finishClaudeStream(state)
      parsedAgents.push({
        agentId: basename(file, '.jsonl').replace(/^agent-/, ''),
        meta,
        parsed,
      })
      step = parsed.nextStep
    }

    const byAgentId = new Map<string, ParsedStream>()
    for (const agent of parsedAgents) {
      if (byAgentId.has(agent.agentId)) {
        throw new Error(`Duplicate Claude subagent id: ${agent.agentId}`)
      }
      byAgentId.set(agent.agentId, agent.parsed)
    }
    for (const agent of parsedAgents) {
      const parentTools = agent.meta.parentAgentId
        ? byAgentId.get(agent.meta.parentAgentId)?.toolSpanByUseId
        : main.toolSpanByUseId
      const parent =
        (agent.meta.toolUseId && parentTools?.get(agent.meta.toolUseId)?.span_id) ||
        `root:${traceId}`
      for (const item of agent.parsed.spans) {
        if (item.parent_span_id === `root:${traceId}`) item.parent_span_id = parent
      }
      out.push(...agent.parsed.spans)
    }
  }
}
