/**
 * OpenAI Codex adapter — `~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl`.
 *
 * Line types: `session_meta` (id + cwd), `turn_context`, `event_msg`
 * (carries `token_count` with per-turn `last_token_usage`), and
 * `response_item` (the OpenAI Responses items: `message`, `reasoning`,
 * `function_call`, `function_call_output`).
 *
 * Token trajectory comes from the `token_count` deltas (Codex puts usage
 * on events, not on the message). Tools come from `function_call`, with
 * status backfilled from the matching `function_call_output`.
 *
 * Shared by the codex-acp wrapper via alias (same rollout format).
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { OtlpSpan } from '../otlp.js'
import { span } from '../otlp.js'
import type { HarnessTraceAdapter, LocateOptions, SessionRef } from '../types.js'

const SERVICE = 'codex'

interface CodexLine {
  timestamp?: string
  type?: string
  payload?: {
    type?: string
    id?: string
    cwd?: string
    cli_version?: string
    model?: string
    role?: string
    name?: string
    content?: unknown
    arguments?: string
    call_id?: string
    output?: unknown
    info?: { last_token_usage?: { input_tokens?: number; output_tokens?: number }; model_context_window?: number }
  }
}

function parseLines(raw: string): CodexLine[] {
  const out: CodexLine[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line) as CodexLine)
    } catch {
      // skip malformed
    }
  }
  return out
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text?: unknown }).text ?? '') : ''))
      .join('')
  }
  return ''
}

/** Max chars of conversation text kept per span — enough for analysis, bounded
 *  for storage + redaction cost. */
const CONTENT_CAP = 8000

/** A message's text (verbatim string body or joined text blocks), trimmed and capped. */
function textOf(content: unknown): string {
  return contentToString(content).trim().slice(0, CONTENT_CAP)
}

/** function_call_output is an error when it clearly reports a non-zero exit / failure. */
function outputIsError(output: unknown): { error: boolean; message: string } {
  const s = typeof output === 'string' ? output : JSON.stringify(output ?? '')
  const error = /"success"\s*:\s*false|exit(?:_| )code["\s:]+[1-9]|\bcommand failed\b|\bENOENT\b|\berror:/i.test(s)
  return { error, message: error ? s.slice(0, 500) : '' }
}

async function* walkRollouts(root: string): AsyncGenerator<string> {
  let years: string[]
  try {
    years = await readdir(root)
  } catch {
    return
  }
  for (const y of years) {
    const yp = join(root, y)
    let months: string[]
    try {
      months = await readdir(yp)
    } catch {
      continue
    }
    for (const m of months) {
      const mp = join(yp, m)
      let days: string[]
      try {
        days = await readdir(mp)
      } catch {
        continue
      }
      for (const d of days) {
        const dp = join(mp, d)
        let files: string[]
        try {
          files = await readdir(dp)
        } catch {
          continue
        }
        for (const f of files) {
          if (f.startsWith('rollout-') && f.endsWith('.jsonl')) yield join(dp, f)
        }
      }
    }
  }
}

export class CodexAdapter implements HarnessTraceAdapter {
  readonly harness = 'codex'
  readonly aliases = ['codex-acp'] as const

  private root(): string {
    return process.env.CODEX_HOME
      ? join(process.env.CODEX_HOME, 'sessions')
      : join(homedir(), '.codex', 'sessions')
  }

  async locate(opts: LocateOptions = {}): Promise<SessionRef[]> {
    const refs: SessionRef[] = []
    for await (const path of walkRollouts(this.root())) {
      let st: Awaited<ReturnType<typeof stat>>
      try {
        st = await stat(path)
      } catch {
        continue
      }
      if (opts.sinceMs && st.mtimeMs < opts.sinceMs) continue
      // cwd lives in the first line's session_meta; read only the head.
      const head = (await readFile(path, 'utf8').catch(() => '')).split('\n', 1)[0] ?? ''
      let cwd: string | null = null
      let id = basename(path).replace(/^rollout-[\dT-]+-/, '').replace(/\.jsonl$/, '')
      try {
        const meta = JSON.parse(head) as CodexLine
        if (meta.payload?.cwd) cwd = meta.payload.cwd
        if (meta.payload?.id) id = meta.payload.id
      } catch {
        // keep filename-derived id
      }
      if (opts.cwd && (!cwd || !cwd.startsWith(opts.cwd))) continue
      refs.push({ harness: this.harness, sessionId: id, path, cwd, mtimeMs: st.mtimeMs })
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async parse(ref: SessionRef): Promise<OtlpSpan[]> {
    const lines = parseLines(await readFile(ref.path, 'utf8'))
    const meta = lines.find((l) => l.type === 'session_meta')
    const traceId = meta?.payload?.id ?? ref.sessionId
    const model = lines.find((l) => l.type === 'turn_context')?.payload?.model ?? null

    const rootId = `root:${traceId}`
    const spans: OtlpSpan[] = [
      span({
        traceId,
        spanId: rootId,
        parentSpanId: null,
        name: 'session',
        kind: 'AGENT',
        startTime: meta?.timestamp ?? lines[0]?.timestamp ?? new Date(0).toISOString(),
        endTime: lines.at(-1)?.timestamp,
        service: SERVICE,
        agent: SERVICE,
        model,
      }),
    ]

    const toolByCallId = new Map<string, OtlpSpan>()
    let step = 0
    let lastLlm = rootId

    for (const l of lines) {
      const ts = l.timestamp ?? new Date(0).toISOString()
      if (l.type === 'event_msg' && l.payload?.type === 'token_count') {
        const u = l.payload.info?.last_token_usage
        if (u && (u.input_tokens || u.output_tokens)) {
          const id = `llm:${step}`
          spans.push(
            span({
              traceId,
              spanId: id,
              parentSpanId: rootId,
              name: 'llm.turn',
              kind: 'LLM',
              startTime: ts,
              service: SERVICE,
              agent: SERVICE,
              model,
              inputTokens: u.input_tokens ?? null,
              outputTokens: u.output_tokens ?? null,
              step,
            }),
          )
          lastLlm = id
          step += 1
        }
      } else if (l.type === 'response_item' && l.payload?.type === 'function_call') {
        const name = l.payload.name ?? 'tool'
        const callId = l.payload.call_id ?? `${step}`
        const toolSpan = span({
          traceId,
          spanId: `tool:${callId}`,
          parentSpanId: lastLlm,
          name: `tool.${name}`,
          kind: 'TOOL',
          startTime: ts,
          service: SERVICE,
          agent: SERVICE,
          tool: name,
          step,
          content: l.payload.arguments ?? null,
        })
        spans.push(toolSpan)
        toolByCallId.set(callId, toolSpan)
        step += 1
      } else if (l.type === 'response_item' && l.payload?.type === 'function_call_output') {
        const t = toolByCallId.get(l.payload.call_id ?? '')
        if (t) {
          const { error, message } = outputIsError(l.payload.output)
          t.end_time = ts
          t.status = error ? { code: 'ERROR', message } : { code: 'OK' }
        }
      } else if (l.type === 'response_item' && l.payload?.type === 'message' && l.payload.role === 'user') {
        // The human's prompt text. Codex drops the user turn from token events,
        // so capture it here as its own CHAIN span (no text → no span).
        const prompt = textOf(l.payload.content)
        if (prompt) {
          spans.push(
            span({
              traceId,
              spanId: `msg:${step}:user`,
              parentSpanId: rootId,
              name: 'user.prompt',
              kind: 'CHAIN',
              startTime: ts,
              service: SERVICE,
              agent: SERVICE,
              step,
              content: prompt,
            }),
          )
          step += 1
        }
      } else if (l.type === 'response_item' && l.payload?.type === 'message') {
        const text = textOf(l.payload.content)
        if (text) {
          spans.push(
            span({
              traceId,
              spanId: `msg:${step}`,
              parentSpanId: rootId,
              name: `message.${l.payload.role ?? 'unknown'}`,
              kind: 'CHAIN',
              startTime: ts,
              service: SERVICE,
              agent: SERVICE,
              step,
              content: text,
            }),
          )
          step += 1
        }
      }
    }
    return spans
  }
}
