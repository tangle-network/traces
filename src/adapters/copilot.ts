/**
 * GitHub Copilot CLI adapter — `${COPILOT_HOME:-~/.copilot}/session-state/<id>/events.jsonl`.
 *
 * Event envelope per line: `{ id, timestamp, parentId, type, data }`. Relevant
 * types: `assistant.message` (`outputTokens`, `toolRequests[]`),
 * `tool.execution_start` (`toolCallId`, `toolName`, `arguments`),
 * `tool.execution_complete` (`toolCallId`, `success`, `error{message}`, `model`),
 * `assistant.usage` (ephemeral: `model`, `inputTokens`, `outputTokens`).
 *
 * Sub-agents interleave in the same stream — tool calls/results are joined by
 * `toolCallId`, never adjacency. Lines may contain stray newlines/separators;
 * parse line-tolerant. Schema from GitHub docs (high conf); parse unverified
 * against local data.
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isMissingPathError } from '../json.js'
import { readJsonl } from '../jsonl.js'
import type { OtlpSpan } from '../otlp.js'
import { span } from '../otlp.js'
import type { HarnessTraceAdapter, LocateOptions, SessionRef } from '../types.js'
import { recordToolOutput, toolIoAttributes } from './tool-io.js'

const SERVICE = 'github-copilot'

interface CopilotEvent {
  id?: string
  timestamp?: string
  type?: string
  data?: {
    content?: string
    messageId?: string
    outputTokens?: number
    inputTokens?: number
    model?: string
    toolCallId?: string
    toolName?: string
    arguments?: unknown
    success?: boolean
    error?: { message?: string }
    output?: unknown
    result?: unknown
  }
}

export class CopilotAdapter implements HarnessTraceAdapter {
  readonly harness = 'github-copilot'
  readonly aliases = ['copilot'] as const

  private root(): string {
    return join(process.env.COPILOT_HOME ?? join(homedir(), '.copilot'), 'session-state')
  }

  async locate(opts: LocateOptions = {}): Promise<SessionRef[]> {
    let dirs: string[]
    try {
      dirs = await readdir(this.root())
    } catch (error) {
      if (isMissingPathError(error)) return []
      throw error
    }
    const refs: SessionRef[] = []
    for (const id of dirs) {
      const path = join(this.root(), id, 'events.jsonl')
      let st: Awaited<ReturnType<typeof stat>>
      try {
        st = await stat(path)
      } catch (error) {
        if (isMissingPathError(error)) continue
        throw error
      }
      if (!st.isFile()) continue
      if (opts.sinceMs && st.mtimeMs < opts.sinceMs) continue
      if (opts.cwd) continue
      refs.push({ harness: this.harness, sessionId: id, path, cwd: null, mtimeMs: st.mtimeMs })
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async parse(ref: SessionRef): Promise<OtlpSpan[]> {
    const traceId = ref.sessionId
    const rootId = `root:${traceId}`
    const spans: OtlpSpan[] = []
    const toolByCallId = new Map<string, OtlpSpan>()
    let firstTimestamp: string | undefined
    let lastTimestamp: string | undefined
    let sawEvent = false
    let step = 0
    let lastLlm = rootId
    let pendingInputTokens: number | null = null

    for await (const ev of readJsonl<CopilotEvent>(ref.path)) {
      if (!sawEvent) {
        firstTimestamp = ev.timestamp
        sawEvent = true
      }
      lastTimestamp = ev.timestamp

      const ts = ev.timestamp ?? new Date(0).toISOString()
      const d = ev.data ?? {}
      if (ev.type === 'assistant.usage') {
        // Ephemeral usage — carry input tokens onto the next/just-seen LLM span.
        pendingInputTokens = d.inputTokens ?? null
        continue
      }
      if (ev.type === 'assistant.message') {
        const llmId = `llm:${d.messageId ?? ev.id ?? step}`
        spans.push(
          span({
            traceId,
            spanId: llmId,
            parentSpanId: rootId,
            name: 'message.assistant',
            kind: 'LLM',
            startTime: ts,
            service: SERVICE,
            agent: SERVICE,
            model: d.model ?? null,
            inputTokens: pendingInputTokens,
            outputTokens: d.outputTokens ?? null,
            step,
            content: typeof d.content === 'string' ? d.content.slice(0, 8000) : null,
          }),
        )
        lastLlm = llmId
        pendingInputTokens = null
        step += 1
      } else if (ev.type === 'tool.execution_start' && d.toolCallId) {
        const name = d.toolName ?? 'tool'
        const t = span({
          traceId,
          spanId: `tool:${d.toolCallId}`,
          parentSpanId: lastLlm,
          name: `tool.${name}`,
          kind: 'TOOL',
          startTime: ts,
          service: SERVICE,
          agent: SERVICE,
          tool: name,
          step,
          extra: toolIoAttributes({ input: d.arguments }),
        })
        spans.push(t)
        toolByCallId.set(d.toolCallId, t)
        step += 1
      } else if (ev.type === 'tool.execution_complete' && d.toolCallId) {
        const t = toolByCallId.get(d.toolCallId)
        if (t) {
          t.end_time = ts
          const err = d.success === false
          t.status = err ? { code: 'ERROR', message: (d.error?.message ?? '').slice(0, 500) } : { code: 'OK' }
          recordToolOutput(t, d.output ?? d.result ?? d.error?.message)
        }
      }
    }

    const root = span({
      traceId,
      spanId: rootId,
      parentSpanId: null,
      name: 'session',
      kind: 'AGENT',
      startTime: firstTimestamp ?? new Date(0).toISOString(),
      endTime: lastTimestamp,
      service: SERVICE,
      agent: SERVICE,
    })
    return [root, ...spans]
  }
}
