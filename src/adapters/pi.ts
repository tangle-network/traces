/**
 * Pi adapter — `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl`.
 *
 * Line types: `session` (id + cwd), `model_change`, `thinking_level_change`,
 * and `message`. A `message` line wraps `message.{role, model, provider,
 * content[], usage.{input,output}, stopReason, errorMessage}`. Tool calls
 * ride inside `message.content[]` as tool blocks.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { OtlpSpan } from '../otlp.js'
import { span } from '../otlp.js'
import type { HarnessTraceAdapter, LocateOptions, SessionRef } from '../types.js'

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

function parseLines(raw: string): PiLine[] {
  const out: PiLine[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line) as PiLine)
    } catch {
      // skip malformed
    }
  }
  return out
}

function isToolBlock(b: PiContentBlock): boolean {
  return typeof b.type === 'string' && /tool[_-]?call|tool[_-]?use|^tool$/i.test(b.type)
}

function isToolResultBlock(b: PiContentBlock): boolean {
  return typeof b.type === 'string' && /tool[_-]?result|tool[_-]?output/i.test(b.type)
}

function textOf(content: PiContentBlock[] | undefined): string {
  if (!content) return ''
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
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
    } catch {
      return []
    }
    const refs: SessionRef[] = []
    for (const dir of dirs) {
      const dp = join(root, dir)
      let files: string[]
      try {
        files = await readdir(dp)
      } catch {
        continue
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
        } catch {
          continue
        }
        if (opts.sinceMs && st.mtimeMs < opts.sinceMs) continue
        const id = basename(f, '.jsonl').replace(/^[\dTZ.-]+_/, '')
        refs.push({ harness: this.harness, sessionId: id, path, cwd, mtimeMs: st.mtimeMs })
      }
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async parse(ref: SessionRef): Promise<OtlpSpan[]> {
    const lines = parseLines(await readFile(ref.path, 'utf8'))
    const sessionLine = lines.find((l) => l.type === 'session')
    const traceId = sessionLine?.id ?? ref.sessionId
    const rootId = `root:${traceId}`

    const spans: OtlpSpan[] = [
      span({
        traceId,
        spanId: rootId,
        parentSpanId: null,
        name: 'session',
        kind: 'AGENT',
        startTime: sessionLine?.timestamp ?? lines[0]?.timestamp ?? new Date(0).toISOString(),
        endTime: lines.at(-1)?.timestamp,
        service: SERVICE,
        agent: SERVICE,
      }),
    ]

    const toolByCallId = new Map<string, OtlpSpan>()
    let step = 0

    for (const l of lines) {
      if (l.type !== 'message' || !l.message) continue
      const ts = l.timestamp ?? new Date(0).toISOString()
      const mid = l.id ?? `m${step}`
      const msg = l.message
      const llmId = `llm:${mid}`
      const errored = !!msg.errorMessage
      spans.push(
        span({
          traceId,
          spanId: llmId,
          parentSpanId: rootId,
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
          content: textOf(msg.content).slice(0, 8000) || null,
        }),
      )
      step += 1

      for (const b of msg.content ?? []) {
        if (isToolBlock(b)) {
          const name = b.toolName ?? b.name ?? 'tool'
          const callId = b.id ?? b.callId ?? b.toolCallId ?? `${mid}:${step}`
          const toolSpan = span({
            traceId,
            spanId: `tool:${callId}`,
            parentSpanId: llmId,
            name: `tool.${name}`,
            kind: 'TOOL',
            startTime: ts,
            service: SERVICE,
            agent: SERVICE,
            tool: name,
            step,
            content: (b.input ?? b.args) != null ? JSON.stringify(b.input ?? b.args) : null,
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
          }
        }
      }
    }
    return spans
  }
}
