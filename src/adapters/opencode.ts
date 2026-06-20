/**
 * OpenCode adapter — `~/.local/share/opencode/storage/`.
 *
 * Split storage: `message/<sessionID>/<messageID>.json` carries role +
 * `tokens` + `modelID` + `time`; `part/<messageID>/<partID>.json` carries
 * the turn's parts (`text`, `reasoning`, `tool`, `step-*`). Tool parts
 * hold `tool`, `callID`, and `state.{status,error}` — `status === 'error'`
 * marks a failed call.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OtlpSpan } from '../otlp.js'
import { span } from '../otlp.js'
import type { HarnessTraceAdapter, LocateOptions, SessionRef } from '../types.js'

const SERVICE = 'opencode'

interface OcMessage {
  id?: string
  role?: string
  modelID?: string
  tokens?: { input?: number; output?: number }
  time?: { created?: number; completed?: number }
}

interface OcPart {
  type?: string
  tool?: string
  callID?: string
  text?: string
  state?: { status?: string; error?: string; input?: unknown }
}

function isoOf(ms: number | undefined): string {
  return new Date(ms ?? 0).toISOString()
}

/** Max chars of conversation text kept per span — enough for analysis, bounded
 *  for storage + redaction cost. */
const CONTENT_CAP = 8000

/** Join a turn's `text` parts (the human's prompt or the assistant's prose)
 *  into one capped string. Tool/reasoning/step parts are skipped. */
function textOf(parts: readonly OcPart[]): string {
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim()
    .slice(0, CONTENT_CAP)
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
    } catch {
      return []
    }
    const refs: SessionRef[] = []
    for (const sid of sessionDirs) {
      const dir = join(msgRoot, sid)
      let st: Awaited<ReturnType<typeof stat>>
      try {
        st = await stat(dir)
      } catch {
        continue
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

    let msgFiles: string[]
    try {
      msgFiles = (await readdir(ref.path)).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }

    const messages: { msg: OcMessage; file: string }[] = []
    for (const f of msgFiles) {
      try {
        messages.push({ msg: JSON.parse(await readFile(join(ref.path, f), 'utf8')) as OcMessage, file: f })
      } catch {
        // skip
      }
    }
    messages.sort((a, b) => (a.msg.time?.created ?? 0) - (b.msg.time?.created ?? 0))

    const spans: OtlpSpan[] = [
      span({
        traceId,
        spanId: rootId,
        parentSpanId: null,
        name: 'session',
        kind: 'AGENT',
        startTime: isoOf(messages[0]?.msg.time?.created),
        endTime: isoOf(messages.at(-1)?.msg.time?.completed ?? messages.at(-1)?.msg.time?.created),
        service: SERVICE,
        agent: SERVICE,
      }),
    ]

    let step = 0
    for (const { msg } of messages) {
      const mid = msg.id ?? `m${step}`
      const llmId = `llm:${mid}`

      // Parts live under part/<messageID>/. Read them up front so the turn's
      // text can ride on the LLM span (assistant prose) or a user.prompt span.
      const pdir = join(partRoot, mid)
      const parts: OcPart[] = []
      try {
        const partFiles = (await readdir(pdir)).filter((f) => f.endsWith('.json'))
        for (const pf of partFiles) {
          try {
            parts.push(JSON.parse(await readFile(join(pdir, pf), 'utf8')) as OcPart)
          } catch {
            // skip
          }
        }
      } catch {
        // No parts dir → still emit the message span.
      }

      const turnText = textOf(parts)
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
          step,
          content: turnText || null,
        }),
      )
      step += 1

      // The human's prompt text. (A tool-result-only user turn yields no text →
      // no user.prompt span.)
      if (msg.role === 'user' && turnText) {
        spans.push(
          span({
            traceId,
            spanId: `${llmId}:user`,
            parentSpanId: rootId,
            name: 'user.prompt',
            kind: 'CHAIN',
            startTime: isoOf(msg.time?.created),
            service: SERVICE,
            agent: SERVICE,
            step,
            content: turnText,
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
            parentSpanId: llmId,
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
            content: part.state?.input != null ? JSON.stringify(part.state.input) : null,
          }),
        )
        step += 1
      }
    }
    return spans
  }
}
