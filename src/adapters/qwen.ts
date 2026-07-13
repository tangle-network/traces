/**
 * Qwen Code adapter — `~/.qwen/projects/<dashed-cwd>/chats/<sessionId>.jsonl`.
 *
 * Schema confirmed from QwenLM/qwen-code source (chatRecordingService.ts):
 * flat Claude-Code-style `ChatRecord` per JSONL line — NOT the Gemini CLI
 * wrapper. `type` ∈ user|assistant|tool_result|system; `message` is a raw
 * `@google/genai` Content `{ role, parts[] }`; tokens use Gemini-API names
 * in `usageMetadata`; tool calls/results are `functionCall`/`functionResponse`
 * parts.
 *
 * Schema-from-source; parse unverified against local data (no `~/.qwen`
 * sessions on this machine).
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { collectJsonl } from '../jsonl.js'
import { capText, userPromptSpan } from './conversation.js'
import type { OtlpSpan } from '../otlp.js'
import { span } from '../otlp.js'
import type { HarnessTraceAdapter, LocateOptions, SessionRef } from '../types.js'

const SERVICE = 'qwen'

interface GenaiPart {
  text?: string
  functionCall?: { name?: string; args?: unknown }
  functionResponse?: { name?: string; response?: unknown }
}

interface QwenRecord {
  type?: string
  uuid?: string
  sessionId?: string
  timestamp?: string
  model?: string
  message?: { role?: string; parts?: GenaiPart[] }
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  toolCallResult?: { status?: string; error?: unknown }
}

function textOf(parts: GenaiPart[] | undefined): string {
  if (!parts) return ''
  return parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('')
}

export class QwenAdapter implements HarnessTraceAdapter {
  readonly harness = 'qwen'
  readonly aliases = ['qwen-code'] as const

  private root(): string {
    return join(homedir(), '.qwen', 'projects')
  }

  async locate(opts: LocateOptions = {}): Promise<SessionRef[]> {
    const root = this.root()
    let projectDirs: string[]
    try {
      projectDirs = await readdir(root)
    } catch {
      return []
    }
    const refs: SessionRef[] = []
    for (const pd of projectDirs) {
      const chatsDir = join(root, pd, 'chats')
      let files: string[]
      try {
        files = await readdir(chatsDir)
      } catch {
        continue
      }
      // dashed-cwd is lossy ([^a-zA-Z0-9]→-); not reversible to a real path.
      if (opts.cwd) continue
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const path = join(chatsDir, f)
        let st: Awaited<ReturnType<typeof stat>>
        try {
          st = await stat(path)
        } catch {
          continue
        }
        if (opts.sinceMs && st.mtimeMs < opts.sinceMs) continue
        refs.push({ harness: this.harness, sessionId: basename(f, '.jsonl'), path, cwd: null, mtimeMs: st.mtimeMs })
      }
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async parse(ref: SessionRef): Promise<OtlpSpan[]> {
    const records = await collectJsonl<QwenRecord>(ref.path)
    const traceId = records.find((r) => r.sessionId)?.sessionId ?? ref.sessionId
    const rootId = `root:${traceId}`

    const spans: OtlpSpan[] = [
      span({
        traceId,
        spanId: rootId,
        parentSpanId: null,
        name: 'session',
        kind: 'AGENT',
        startTime: records[0]?.timestamp ?? new Date(0).toISOString(),
        endTime: records.at(-1)?.timestamp,
        service: SERVICE,
        agent: SERVICE,
      }),
    ]

    // Tool calls have no stable id in genai parts — match results to the most
    // recent unresolved call of the same function name.
    const openToolsByName = new Map<string, OtlpSpan[]>()
    let step = 0
    let lastLlm = rootId

    for (const r of records) {
      const ts = r.timestamp ?? new Date(0).toISOString()
      const role = r.message?.role
      if (r.type === 'assistant' || role === 'model') {
        const llmId = `llm:${r.uuid ?? step}`
        spans.push(
          span({
            traceId,
            spanId: llmId,
            parentSpanId: rootId,
            name: 'llm.turn',
            kind: 'LLM',
            startTime: ts,
            service: SERVICE,
            agent: SERVICE,
            model: r.model ?? null,
            inputTokens: r.usageMetadata?.promptTokenCount ?? null,
            outputTokens: r.usageMetadata?.candidatesTokenCount ?? null,
            step,
            content: capText(textOf(r.message?.parts)) || null,
          }),
        )
        lastLlm = llmId
        step += 1

        for (const p of r.message?.parts ?? []) {
          if (!p.functionCall?.name) continue
          const name = p.functionCall.name
          const t = span({
            traceId,
            spanId: `tool:${name}:${step}`,
            parentSpanId: llmId,
            name: `tool.${name}`,
            kind: 'TOOL',
            startTime: ts,
            service: SERVICE,
            agent: SERVICE,
            tool: name,
            step,
            content: p.functionCall.args != null ? JSON.stringify(p.functionCall.args) : null,
          })
          spans.push(t)
          const q = openToolsByName.get(name) ?? []
          q.push(t)
          openToolsByName.set(name, q)
          step += 1
        }
      } else if (r.type === 'user') {
        // The human's prompt text. Gate on `type` only: tool_result records also
        // carry `message.role === 'user'` (functionResponse rides a user Content),
        // so a `role === 'user'` fallback would swallow them. A text-less user
        // turn (e.g. functionResponse-only) yields no user.prompt span.
        const prompt = capText(textOf(r.message?.parts))
        if (prompt) {
          spans.push(
            userPromptSpan({
              traceId,
              spanId: `user:${r.uuid ?? step}`,
              parentSpanId: rootId,
              startTime: ts,
              service: SERVICE,
              agent: SERVICE,
              step,
              content: prompt,
            }),
          )
          step += 1
        }
      } else if (r.type === 'tool_result') {
        const err = r.toolCallResult?.status === 'error' || r.toolCallResult?.error != null
        for (const p of r.message?.parts ?? []) {
          const name = p.functionResponse?.name
          if (!name) continue
          const t = openToolsByName.get(name)?.shift()
          if (t) {
            t.end_time = ts
            t.status = err ? { code: 'ERROR', message: 'tool result reported error' } : { code: 'OK' }
          }
        }
      }
    }
    return spans
  }
}
