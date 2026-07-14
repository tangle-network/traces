/**
 * Pi adapter — `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl`.
 *
 * Line types: `session` (id + cwd), `model_change`, `thinking_level_change`,
 * and `message`. A `message` line wraps `message.{role, model, provider,
 * content[], usage.{input,output}, stopReason, errorMessage}`. Tool calls
 * ride inside `message.content[]` as tool blocks.
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { sessionJsonlOptions } from '../integrity.js'
import { isMissingPathError } from '../json.js'
import { readJsonl } from '../jsonl.js'
import type { OtlpSpan } from '../otlp.js'
import { span } from '../otlp.js'
import type { HarnessTraceAdapter, LocateOptions, ParseOptions, SessionRef } from '../types.js'
import { capText, userPromptSpan } from './conversation.js'
import { recordToolOutput, toolIoAttributes } from './tool-io.js'

const SERVICE = 'pi'

interface PiContentBlock {
  type?: string
  text?: string
  name?: string
  toolName?: string
  id?: string
  callId?: string
  toolCallId?: string
  input?: unknown
  args?: unknown
  isError?: boolean
  is_error?: boolean
  content?: unknown
  output?: unknown
  result?: unknown
}

interface PiLine {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string
  cwd?: string
  message?: {
    role?: string
    model?: string
    content?: PiContentBlock[]
    stopReason?: string
    errorMessage?: string
    usage?: { input?: number; output?: number }
  }
}

function isToolBlock(b: PiContentBlock): boolean {
  return typeof b.type === 'string' && /tool[_-]?call|tool[_-]?use|^tool$/i.test(b.type)
}

function isToolResultBlock(b: PiContentBlock): boolean {
  return typeof b.type === 'string' && /tool[_-]?result|tool[_-]?output/i.test(b.type)
}

function textOf(content: PiContentBlock[] | undefined): string {
  if (!content) return ''
  return capText(
    content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(''),
  )
}

export class PiAdapter implements HarnessTraceAdapter {
  readonly harness = 'pi'

  private root(): string {
    return join(homedir(), '.pi', 'agent', 'sessions')
  }

  async locate(opts: LocateOptions = {}): Promise<SessionRef[]> {
    const root = this.root()
    let dirs: string[]
    try {
      dirs = await readdir(root)
    } catch (error) {
      if (isMissingPathError(error)) return []
      throw error
    }
    const refs: SessionRef[] = []
    for (const dir of dirs) {
      const dp = join(root, dir)
      let files: string[]
      try {
        files = await readdir(dp)
      } catch (error) {
        if (isMissingPathError(error)) continue
        throw error
      }
      // Encoded cwd: leading/trailing `--`, separators as `-`.
      const cwd = `/${dir.replace(/^-+/, '').replace(/-+$/, '').replace(/-/g, '/')}`
      if (opts.cwd && !cwd.startsWith(opts.cwd)) continue
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const path = join(dp, f)
        let st: Awaited<ReturnType<typeof stat>>
        try {
          st = await stat(path)
        } catch (error) {
          if (isMissingPathError(error)) continue
          throw error
        }
        if (opts.sinceMs && st.mtimeMs < opts.sinceMs) continue
        const id = basename(f, '.jsonl').replace(/^[\dTZ.-]+_/, '')
        refs.push({ harness: this.harness, sessionId: id, path, cwd, mtimeMs: st.mtimeMs })
      }
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async parse(ref: SessionRef, options: ParseOptions = {}): Promise<OtlpSpan[]> {
    const sourceTraceId = ref.sessionId
    const sourceRootId = `root:${sourceTraceId}`
    const spans: OtlpSpan[] = []
    const toolByCallId = new Map<string, OtlpSpan>()
    let firstTimestamp: string | undefined
    let lastTimestamp: string | undefined
    let sessionLine: Pick<PiLine, 'id' | 'timestamp'> | undefined
    let sawLine = false
    let step = 0

    for await (const l of readJsonl<PiLine>(ref.path, sessionJsonlOptions(ref, options))) {
      if (!sawLine) {
        firstTimestamp = l.timestamp
        sawLine = true
      }
      lastTimestamp = l.timestamp
      if (!sessionLine && l.type === 'session') {
        sessionLine = { id: l.id, timestamp: l.timestamp }
      }
      if (l.type !== 'message' || !l.message) continue

      const ts = l.timestamp ?? new Date(0).toISOString()
      const mid = l.id ?? `m${step}`
      const msg = l.message
      const llmId = `llm:${mid}`
      if (msg.role === 'user') {
        // The human's prompt text. (A tool-result-only user turn yields no
        // text → no user.prompt span.)
        const prompt = textOf(msg.content)
        if (prompt) {
          spans.push(
            userPromptSpan({
              traceId: sourceTraceId,
              spanId: `${mid}:user`,
              parentSpanId: sourceRootId,
              startTime: ts,
              service: SERVICE,
              agent: SERVICE,
              step,
              content: prompt,
            }),
          )
          step += 1
        }
      } else {
        const errored = !!msg.errorMessage
        spans.push(
          span({
            traceId: sourceTraceId,
            spanId: llmId,
            parentSpanId: sourceRootId,
            name: `message.${msg.role ?? 'unknown'}`,
            kind: 'LLM',
            startTime: ts,
            status: errored ? 'ERROR' : 'OK',
            statusMessage: errored ? msg.errorMessage!.slice(0, 500) : undefined,
            service: SERVICE,
            agent: SERVICE,
            model: msg.model ?? null,
            inputTokens: msg.usage?.input ?? null,
            outputTokens: msg.usage?.output ?? null,
            step,
            content: textOf(msg.content) || null,
          }),
        )
        step += 1
      }

      for (const b of msg.content ?? []) {
        if (isToolBlock(b)) {
          const name = b.toolName ?? b.name ?? 'tool'
          const callId = b.id ?? b.callId ?? b.toolCallId ?? `${mid}:${step}`
          const toolSpan = span({
            traceId: sourceTraceId,
            spanId: `tool:${callId}`,
            parentSpanId: llmId,
            name: `tool.${name}`,
            kind: 'TOOL',
            startTime: ts,
            service: SERVICE,
            agent: SERVICE,
            tool: name,
            step,
            extra: toolIoAttributes({ input: b.input ?? b.args }),
          })
          spans.push(toolSpan)
          toolByCallId.set(callId, toolSpan)
          step += 1
        } else if (isToolResultBlock(b)) {
          const callId = b.toolCallId ?? b.callId ?? b.id ?? ''
          const t = toolByCallId.get(callId)
          if (t) {
            const err = b.isError === true || b.is_error === true
            t.end_time = ts
            t.status = err ? { code: 'ERROR', message: 'tool result reported error' } : { code: 'OK' }
            recordToolOutput(t, b.output ?? b.result ?? b.content ?? b.text)
          }
        }
      }
    }

    const traceId = sessionLine?.id ?? sourceTraceId
    const rootId = `root:${traceId}`
    for (const item of spans) {
      item.trace_id = traceId
      if (item.parent_span_id === sourceRootId) item.parent_span_id = rootId
    }
    const root = span({
      traceId,
      spanId: rootId,
      parentSpanId: null,
      name: 'session',
      kind: 'AGENT',
      startTime: sessionLine?.timestamp ?? firstTimestamp ?? new Date(0).toISOString(),
      endTime: lastTimestamp,
      service: SERVICE,
      agent: SERVICE,
    })
    return [root, ...spans]
  }
}
