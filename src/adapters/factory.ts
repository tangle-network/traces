/**
 * Factory Droid adapter — `~/.factory/sessions/<encoded-cwd>/<uuid>.jsonl`
 * plus a `<uuid>.settings.json` sidecar.
 *
 * Confirmed from disk + two parsers (droid-sync-plugin, tokscale): the JSONL
 * has only `session_start` and `message` lines; `message.content[]` carries
 * Anthropic-style blocks (`text`, `thinking`, `tool_use`, `tool_result`). The
 * sidecar holds `model` and session-total `tokenUsage` — there is NO per-turn
 * usage in the transcript, so token-growth can't be computed for Factory (the
 * tool/loop signals still work). `<encoded-cwd>` is slash→dash. Tool-error
 * flag (`is_error`) is inferred (Anthropic convention), not source-confirmed.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { readJsonl } from '../jsonl.js'
import type { OtlpSpan } from '../otlp.js'
import { span } from '../otlp.js'
import type { HarnessTraceAdapter, LocateOptions, SessionRef } from '../types.js'
import { capText, userPromptSpan } from './conversation.js'

const SERVICE = 'factory'

interface FactoryBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
}

interface FactoryLine {
  type?: string
  id?: string
  cwd?: string
  timestamp?: string
  message?: { role?: string; content?: FactoryBlock[] }
}

interface FactorySettings {
  model?: string
  tokenUsage?: { inputTokens?: number; outputTokens?: number }
}

/** Join a message's `text` blocks (the human's prompt or the assistant's prose)
 *  into one capped string. A string body is taken verbatim. */
function textOf(content: FactoryBlock[] | undefined): string {
  return capText(
    (content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(''),
  )
}

export class FactoryAdapter implements HarnessTraceAdapter {
  readonly harness = 'factory'
  readonly aliases = ['factory-droids', 'droid'] as const

  private root(): string {
    return join(homedir(), '.factory', 'sessions')
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
      const cwd = dir.replace(/-/g, '/')
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
        refs.push({ harness: this.harness, sessionId: basename(f, '.jsonl'), path, cwd, mtimeMs: st.mtimeMs })
      }
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async parse(ref: SessionRef): Promise<OtlpSpan[]> {
    // Sidecar holds model + session-total tokens.
    let settings: FactorySettings = {}
    try {
      settings = JSON.parse(await readFile(ref.path.replace(/\.jsonl$/, '.settings.json'), 'utf8')) as FactorySettings
    } catch {
      // no sidecar → model/tokens unknown
    }

    const sourceTraceId = ref.sessionId
    const sourceRootId = `root:${sourceTraceId}`
    const spans: OtlpSpan[] = []
    const toolByUseId = new Map<string, OtlpSpan>()
    let firstTimestamp: string | undefined
    let lastTimestamp: string | undefined
    let sessionLine: Pick<FactoryLine, 'id' | 'timestamp'> | undefined
    let sawLine = false
    let step = 0
    let lastLlm = sourceRootId

    for await (const l of readJsonl<FactoryLine>(ref.path)) {
      if (!sawLine) {
        firstTimestamp = l.timestamp
        sawLine = true
      }
      lastTimestamp = l.timestamp
      if (!sessionLine && l.type === 'session_start') {
        sessionLine = { id: l.id, timestamp: l.timestamp }
      }
      if (l.type !== 'message' || !l.message) continue

      const ts = l.timestamp ?? new Date(0).toISOString()
      const role = l.message.role
      const text = textOf(l.message.content)
      if (role === 'user') {
        // The human's prompt text. (A user turn may instead carry only
        // tool_result blocks → no text → no user.prompt span.)
        if (text) {
          spans.push(
            userPromptSpan({
              traceId: sourceTraceId,
              spanId: `user:${l.id ?? step}`,
              parentSpanId: sourceRootId,
              startTime: ts,
              content: text,
              service: SERVICE,
              agent: SERVICE,
              step,
            }),
          )
          step += 1
        }
      } else {
        const llmId = `llm:${l.id ?? step}`
        spans.push(
          span({
            traceId: sourceTraceId,
            spanId: llmId,
            parentSpanId: sourceRootId,
            name: `message.${role ?? 'unknown'}`,
            kind: 'LLM',
            startTime: ts,
            service: SERVICE,
            agent: SERVICE,
            model: settings.model ?? null,
            step,
            content: text || null,
          }),
        )
        lastLlm = llmId
        step += 1
      }

      for (const b of l.message.content ?? []) {
        if (b.type === 'tool_use' && b.name) {
          const t = span({
            traceId: sourceTraceId,
            spanId: `tool:${b.id ?? `${l.id}:${step}`}`,
            parentSpanId: lastLlm,
            name: `tool.${b.name}`,
            kind: 'TOOL',
            startTime: ts,
            service: SERVICE,
            agent: SERVICE,
            tool: b.name,
            step,
            content: b.input != null ? JSON.stringify(b.input) : null,
          })
          spans.push(t)
          if (b.id) toolByUseId.set(b.id, t)
          step += 1
        } else if (b.type === 'tool_result' && b.tool_use_id) {
          const t = toolByUseId.get(b.tool_use_id)
          if (t) t.status = b.is_error === true ? { code: 'ERROR', message: 'tool reported error' } : { code: 'OK' }
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
      model: settings.model ?? null,
      extra: settings.tokenUsage
        ? {
            'session.input_tokens': settings.tokenUsage.inputTokens ?? 0,
            'session.output_tokens': settings.tokenUsage.outputTokens ?? 0,
          }
        : undefined,
    })
    return [root, ...spans]
  }
}
