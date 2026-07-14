/**
 * Sourcegraph Amp adapter — `${XDG_DATA_HOME:-~/.local/share}/amp/threads/T-*.json`.
 *
 * One JSON object per thread: `{ id, created, messages[], usageLedger }`.
 * Messages carry `role`, `usage` (camelCase on disk: `model`, `inputTokens`,
 * `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`) and
 * Anthropic-style `content[]` blocks (`text`, `tool_use`, `tool_result` with
 * `is_error`).
 *
 * Path/format/usage from the `tokscale` parser (high conf); content-block
 * field names medium-conf; parse unverified against local data.
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { isMissingPathError, readJsonFile } from '../json.js'
import type { OtlpSpan } from '../otlp.js'
import { span } from '../otlp.js'
import type { HarnessTraceAdapter, LocateOptions, SessionRef } from '../types.js'
import { CONTENT_CAP, capText, userPromptSpan } from './conversation.js'
import { recordToolOutput, toolIoAttributes } from './tool-io.js'

const SERVICE = 'amp'

/** Join a message's `text` blocks (the human's prompt or the assistant's prose)
 *  into one capped string. A string body is taken verbatim. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, CONTENT_CAP)
  return capText(
    (Array.isArray(content) ? (content as AmpBlock[]) : [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n'),
  )
}

interface AmpBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
  output?: unknown
}

interface AmpMessage {
  role?: string
  messageId?: number
  usage?: {
    model?: string
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
  }
  content?: AmpBlock[]
}

interface AmpThread {
  id?: string
  created?: number
  messages?: AmpMessage[]
}

export class AmpAdapter implements HarnessTraceAdapter {
  readonly harness = 'amp'

  private threadsRoot(): string {
    const base = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
    return join(base, 'amp', 'threads')
  }

  async locate(opts: LocateOptions = {}): Promise<SessionRef[]> {
    let files: string[]
    try {
      files = await readdir(this.threadsRoot())
    } catch (error) {
      if (isMissingPathError(error)) return []
      throw error
    }
    const refs: SessionRef[] = []
    for (const f of files) {
      if (!f.startsWith('T-') || !f.endsWith('.json')) continue
      const path = join(this.threadsRoot(), f)
      let st: Awaited<ReturnType<typeof stat>>
      try {
        st = await stat(path)
      } catch (error) {
        if (isMissingPathError(error)) continue
        throw error
      }
      if (opts.sinceMs && st.mtimeMs < opts.sinceMs) continue
      if (opts.cwd) continue // threads don't record cwd
      refs.push({ harness: this.harness, sessionId: basename(f, '.json'), path, cwd: null, mtimeMs: st.mtimeMs })
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async parse(ref: SessionRef): Promise<OtlpSpan[]> {
    const thread = await readJsonFile<AmpThread>(ref.path)
    const traceId = thread.id ?? ref.sessionId
    const rootId = `root:${traceId}`
    const start = new Date(thread.created ?? 0).toISOString()
    const messages = thread.messages ?? []

    const spans: OtlpSpan[] = [
      span({ traceId, spanId: rootId, parentSpanId: null, name: 'session', kind: 'AGENT', startTime: start, service: SERVICE, agent: SERVICE }),
    ]
    const toolByUseId = new Map<string, OtlpSpan>()
    let step = 0

    for (const m of messages) {
      const mid = m.messageId ?? step
      const llmId = `llm:${mid}`
      // The human's prompt text. (A user turn may instead/also carry tool_result
      // blocks; a tool-result-only turn yields no text → no user.prompt span.)
      if (m.role === 'user') {
        // A user turn is the human, not an LLM call → emit only a user.prompt
        // span (and skip it for a tool-result-only turn with no text).
        const prompt = textOf(m.content)
        if (prompt) {
          spans.push(
            userPromptSpan({
              traceId,
              spanId: `${llmId}:user`,
              parentSpanId: rootId,
              startTime: start,
              service: SERVICE,
              agent: SERVICE,
              step,
              content: prompt,
            }),
          )
          step += 1
        }
      } else {
        const u = m.usage
        spans.push(
          span({
            traceId,
            spanId: llmId,
            parentSpanId: rootId,
            name: `message.${m.role ?? 'unknown'}`,
            kind: 'LLM',
            startTime: start,
            service: SERVICE,
            agent: SERVICE,
            model: u?.model ?? null,
            inputTokens: u?.inputTokens ?? null,
            outputTokens: u?.outputTokens ?? null,
            cachedInputTokens: u?.cacheReadInputTokens ?? null,
            cacheWriteInputTokens: u?.cacheCreationInputTokens ?? null,
            step,
            content: textOf(m.content) || null,
          }),
        )
        step += 1
      }

      for (const b of m.content ?? []) {
        if (b.type === 'tool_use' && b.name) {
          const t = span({
            traceId,
            spanId: `tool:${b.id ?? `${mid}:${step}`}`,
            parentSpanId: llmId,
            name: `tool.${b.name}`,
            kind: 'TOOL',
            startTime: start,
            service: SERVICE,
            agent: SERVICE,
            tool: b.name,
            step,
            extra: toolIoAttributes({ input: b.input }),
          })
          spans.push(t)
          if (b.id) toolByUseId.set(b.id, t)
          step += 1
        } else if (b.type === 'tool_result' && b.tool_use_id) {
          const t = toolByUseId.get(b.tool_use_id)
          if (t) {
            t.status = b.is_error === true ? { code: 'ERROR', message: 'tool reported error' } : { code: 'OK' }
            recordToolOutput(t, b.content ?? b.output)
          }
        }
      }
    }
    return spans
  }
}
