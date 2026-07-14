/**
 * OpenCode adapter — `~/.local/share/opencode/storage/`.
 *
 * Split storage: `message/<sessionID>/<messageID>.json` carries role +
 * `tokens` + `modelID` + `time`; `part/<messageID>/<partID>.json` carries
 * the turn's parts (`text`, `reasoning`, `tool`, `step-*`). Tool parts
 * hold `tool`, `callID`, and `state.{status,error}` — `status === 'error'`
 * marks a failed call.
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isMissingJsonSource, isMissingPathError, listJsonFiles, readJsonFile } from '../json.js'
import type { OtlpSpan } from '../otlp.js'
import { span } from '../otlp.js'
import type { HarnessTraceAdapter, LocateOptions, SessionRef } from '../types.js'
import { capText, userPromptSpan } from './conversation.js'
import { toolIoAttributes } from './tool-io.js'

const SERVICE = 'opencode'

interface OcMessage {
  id?: string
  role?: string
  modelID?: string
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  time?: { created?: number; completed?: number }
}

interface OcPart {
  type?: string
  tool?: string
  callID?: string
  text?: string
  state?: { status?: string; error?: string; input?: unknown; output?: unknown }
}

function isoOf(ms: number | undefined): string {
  return new Date(ms ?? 0).toISOString()
}

/** Join a turn's `text` parts (the human's prompt or the assistant's prose)
 *  into one capped string. Tool/reasoning/step parts are skipped. */
function textOf(parts: readonly OcPart[]): string {
  return capText(
    parts
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n'),
  )
}

export class OpencodeAdapter implements HarnessTraceAdapter {
  readonly harness = 'opencode'

  private storage(): string {
    const base = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
    return join(base, 'opencode', 'storage')
  }

  async locate(opts: LocateOptions = {}): Promise<SessionRef[]> {
    const msgRoot = join(this.storage(), 'message')
    let sessionDirs: string[]
    try {
      sessionDirs = await readdir(msgRoot)
    } catch (error) {
      if (isMissingPathError(error)) return []
      throw error
    }
    const refs: SessionRef[] = []
    for (const sid of sessionDirs) {
      const dir = join(msgRoot, sid)
      let st: Awaited<ReturnType<typeof stat>>
      try {
        st = await stat(dir)
      } catch (error) {
        if (isMissingPathError(error)) continue
        throw error
      }
      if (!st.isDirectory()) continue
      if (opts.sinceMs && st.mtimeMs < opts.sinceMs) continue
      // cwd isn't reliably recoverable from message storage; left null.
      if (opts.cwd) continue
      refs.push({ harness: this.harness, sessionId: sid, path: dir, cwd: null, mtimeMs: st.mtimeMs })
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async parse(ref: SessionRef): Promise<OtlpSpan[]> {
    const traceId = ref.sessionId
    const rootId = `root:${traceId}`
    const partRoot = join(this.storage(), 'part')

    const msgFiles = await listJsonFiles(ref.path)

    const messages: OcMessage[] = []
    for (const f of msgFiles) {
      messages.push(await readJsonFile<OcMessage>(join(ref.path, f)))
    }
    messages.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))

    const spans: OtlpSpan[] = [
      span({
        traceId,
        spanId: rootId,
        parentSpanId: null,
        name: 'session',
        kind: 'AGENT',
        startTime: isoOf(messages[0]?.time?.created),
        endTime: isoOf(messages.at(-1)?.time?.completed ?? messages.at(-1)?.time?.created),
        service: SERVICE,
        agent: SERVICE,
      }),
    ]

    let step = 0
    for (const msg of messages) {
      const mid = msg.id ?? `m${step}`
      const llmId = `llm:${mid}`

      // Parts live under part/<messageID>/. Read them up front so the turn's
      // text can ride on the LLM span (assistant prose) or a user.prompt span.
      const pdir = join(partRoot, mid)
      const parts: OcPart[] = []
      let partFiles: string[] = []
      try {
        partFiles = await listJsonFiles(pdir)
      } catch (error) {
        if (!isMissingJsonSource(error)) throw error
      }
      for (const pf of partFiles) {
        parts.push(await readJsonFile<OcPart>(join(pdir, pf)))
      }

      const turnText = textOf(parts)
      const isUser = msg.role === 'user'
      if (isUser) {
        // A tool-result-only user turn has no prompt span.
        if (turnText) {
          spans.push(
            userPromptSpan({
              traceId,
              spanId: `${llmId}:user`,
              parentSpanId: rootId,
              startTime: isoOf(msg.time?.created),
              service: SERVICE,
              agent: SERVICE,
              step,
              content: turnText,
            }),
          )
          step += 1
        }
      } else {
        spans.push(
          span({
            traceId,
            spanId: llmId,
            parentSpanId: rootId,
            name: `message.${msg.role ?? 'unknown'}`,
            kind: 'LLM',
            startTime: isoOf(msg.time?.created),
            endTime: isoOf(msg.time?.completed ?? msg.time?.created),
            service: SERVICE,
            agent: SERVICE,
            model: msg.modelID ?? null,
            inputTokens: msg.tokens?.input ?? null,
            outputTokens: msg.tokens?.output ?? null,
            reasoningTokens: msg.tokens?.reasoning ?? null,
            cachedInputTokens: msg.tokens?.cache?.read ?? null,
            cacheWriteInputTokens: msg.tokens?.cache?.write ?? null,
            step,
            content: turnText || null,
          }),
        )
        step += 1
      }

      for (const part of parts) {
        if (part.type !== 'tool' || !part.tool) continue
        const err = part.state?.status === 'error'
        spans.push(
          span({
            traceId,
            spanId: `tool:${part.callID ?? `${mid}:${step}`}`,
            parentSpanId: isUser ? rootId : llmId,
            name: `tool.${part.tool}`,
            kind: 'TOOL',
            startTime: isoOf(msg.time?.created),
            endTime: isoOf(msg.time?.completed ?? msg.time?.created),
            status: err ? 'ERROR' : 'OK',
            statusMessage: err ? (part.state?.error ?? '').slice(0, 500) : undefined,
            service: SERVICE,
            agent: SERVICE,
            tool: part.tool,
            step,
            extra: toolIoAttributes({
              input: part.state?.input,
              output: part.state?.output ?? part.state?.error,
            }),
          }),
        )
        step += 1
      }
    }
    return spans
  }
}
