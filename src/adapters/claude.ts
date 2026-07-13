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

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { isMissingJsonSource, isMissingPathError, readJsonFile } from '../json.js'
import { readJsonl } from '../jsonl.js'
import type { OtlpSpan, OtlpStatusCode } from '../otlp.js'
import { span } from '../otlp.js'
import { claudeActor } from './actor.js'
import { capText, userPromptSpan } from './conversation.js'
import { recordToolOutput, toolIoAttributes } from './tool-io.js'
import type { HarnessTraceAdapter, LocateOptions, SessionRef } from '../types.js'

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

/** Total input tokens billed for an assistant turn (fresh + cache). */
function inputTokens(u: NonNullable<ClaudeEvent['message']>['usage']): number | null {
  if (!u) return null
  const v = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  return v > 0 ? v : null
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

function consumeClaudeEvent(ev: ClaudeEvent, ctx: ClaudeStreamContext, state: ClaudeStreamState): void {
  const ts = ev.timestamp ?? new Date(0).toISOString()
  const uid = ev.uuid ?? `${ctx.idPrefix}step${state.step}`

  if (ev.type === 'assistant' && ev.message) {
    const llmId = `${ctx.idPrefix}${uid}`
    state.spans.push(
      span({
        traceId: ctx.traceId,
        spanId: llmId,
        parentSpanId: ctx.rootParent,
        name: 'llm.turn',
        kind: 'LLM',
        startTime: ts,
        service: SERVICE,
        agent: ctx.agent,
        model: ev.message.model ?? null,
        inputTokens: inputTokens(ev.message.usage),
        outputTokens: ev.message.usage?.output_tokens ?? null,
        step: state.step,
        content: textOf(ev.message.content) || null,
      }),
    )
    state.step += 1

    let toolIdx = 0
    for (const block of asBlocks(ev.message.content)) {
      if (block.type !== 'tool_use' || !block.name) continue
      const toolSpan = span({
        traceId: ctx.traceId,
        spanId: `${ctx.idPrefix}${uid}:tool:${toolIdx}`,
        parentSpanId: llmId,
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
      toolIdx += 1
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

  async parse(ref: SessionRef): Promise<OtlpSpan[]> {
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
    let firstTimestamp: string | undefined
    let lastTimestamp: string | undefined
    let sawEvent = false

    for await (const event of readJsonl<ClaudeEvent>(ref.path)) {
      if (!sawEvent) {
        firstTimestamp = event.timestamp
        sawEvent = true
      }
      lastTimestamp = event.timestamp
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
    const spans: OtlpSpan[] = [
      span({
        traceId,
        spanId: rootId,
        parentSpanId: null,
        name: 'session',
        kind: 'AGENT',
        startTime: firstTimestamp ?? new Date(0).toISOString(),
        endTime: lastTimestamp,
        service: SERVICE,
        agent: SERVICE,
      }),
      ...main.spans,
    ]

    await this.foldSubagents(ref, traceId, main, spans)
    return spans
  }

  /** Parse `<session>/subagents/agent-*.jsonl`, parenting each under its Agent call. */
  private async foldSubagents(ref: SessionRef, traceId: string, main: ParsedStream, out: OtlpSpan[]): Promise<void> {
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
      for await (const event of readJsonl<ClaudeEvent>(join(subDir, file))) {
        consumeClaudeEvent(event, ctx, state)
      }
      const parsed = finishClaudeStream(state)
      out.push(...parsed.spans)
      step = parsed.nextStep
    }
  }
}
