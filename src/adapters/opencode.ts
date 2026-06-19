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
        }),
      )
      step += 1

      // Parts live under part/<messageID>/.
      const pdir = join(partRoot, mid)
      let partFiles: string[]
      try {
        partFiles = (await readdir(pdir)).filter((f) => f.endsWith('.json'))
      } catch {
        continue
      }
      for (const pf of partFiles) {
        let part: OcPart
        try {
          part = JSON.parse(await readFile(join(pdir, pf), 'utf8')) as OcPart
        } catch {
          continue
        }
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
