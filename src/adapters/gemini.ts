/**
 * Gemini CLI family — `<home>/tmp/<projectHash>/chats/session-*.json`.
 *
 * One JSON object per chat: `{ sessionId, projectHash, messages[] }`.
 * Each message carries `model`, `tokens.{input,output}`, `content`, and
 * `toolCalls[]` with `{ name, args, status, result }`.
 *
 * Gemini CLI only — Qwen Code forked and diverged (flat Claude-style
 * JSONL under `~/.qwen/projects/`); it has its own adapter.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OtlpSpan } from '../otlp.js'
import { span } from '../otlp.js'
import { capText, userPromptSpan } from './conversation.js'
import type { HarnessTraceAdapter, LocateOptions, SessionRef } from '../types.js'

interface GeminiToolCall {
  id?: string
  name?: string
  args?: unknown
  status?: string
}

interface GeminiMessage {
  id?: string
  type?: string
  model?: string
  content?: unknown
  timestamp?: string | number
  tokens?: { input?: number; output?: number }
  toolCalls?: GeminiToolCall[]
}

interface GeminiSession {
  sessionId?: string
  projectHash?: string
  startTime?: string
  messages?: GeminiMessage[]
}

function iso(ts: string | number | undefined, fallback: string): string {
  if (typeof ts === 'number') return new Date(ts).toISOString()
  if (typeof ts === 'string' && ts.length > 0) return ts
  return fallback
}

function toolStatusError(status: string | undefined): boolean {
  return status != null && /error|fail|cancel/i.test(status)
}

/** A Gemini message body is a plain string (the prompt or the model's prose);
 *  some events carry a structured body, which we stringify. Either way capped. */
function textOf(content: unknown): string {
  const s = typeof content === 'string' ? content : JSON.stringify(content ?? '')
  return capText(s)
}

interface GeminiFamilyConfig {
  harness: string
  service: string
  /** Directory under $HOME holding `tmp/<hash>/chats/` (e.g. '.gemini', '.qwen'). */
  homeDirName: string
  aliases?: readonly string[]
}

/** Shared base for Gemini CLI and its forks (Qwen Code). */
export class GeminiFamilyAdapter implements HarnessTraceAdapter {
  readonly harness: string
  readonly aliases?: readonly string[]
  private readonly service: string
  private readonly homeDirName: string

  constructor(cfg: GeminiFamilyConfig) {
    this.harness = cfg.harness
    this.aliases = cfg.aliases
    this.service = cfg.service
    this.homeDirName = cfg.homeDirName
  }

  private chatsRoot(): string {
    return join(homedir(), this.homeDirName, 'tmp')
  }

  /** `<home>/projects.json` maps `{ <absolute-cwd>: <projectName> }`. The session
   *  dir name (`tmp/<projectHash>/`) is that projectName for registered projects,
   *  so inverting the map recovers cwd. (Unregistered/older dirs are opaque cwd
   *  digests and stay null.) Loaded once per locate(). */
  private async loadProjectCwds(): Promise<Map<string, string>> {
    const nameToPath = new Map<string, string>()
    try {
      const raw = await readFile(join(homedir(), this.homeDirName, 'projects.json'), 'utf8')
      const projects = (JSON.parse(raw) as { projects?: Record<string, string> }).projects ?? {}
      for (const [path, name] of Object.entries(projects)) nameToPath.set(name, path)
    } catch {
      // no registry — cwd stays null (unchanged behavior)
    }
    return nameToPath
  }

  async locate(opts: LocateOptions = {}): Promise<SessionRef[]> {
    const root = this.chatsRoot()
    let projectDirs: string[]
    try {
      projectDirs = await readdir(root)
    } catch {
      return []
    }
    const projectCwds = await this.loadProjectCwds()
    const refs: SessionRef[] = []
    for (const pd of projectDirs) {
      const cwd = projectCwds.get(pd) ?? null
      const chatsDir = join(root, pd, 'chats')
      let files: string[]
      try {
        files = await readdir(chatsDir)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.startsWith('session-') || !f.endsWith('.json')) continue
        const path = join(chatsDir, f)
        let st: Awaited<ReturnType<typeof stat>>
        try {
          st = await stat(path)
        } catch {
          continue
        }
        if (opts.sinceMs && st.mtimeMs < opts.sinceMs) continue
        if (opts.cwd && (!cwd || !cwd.startsWith(opts.cwd))) continue
        refs.push({ harness: this.harness, sessionId: f.replace(/\.json$/, ''), path, cwd, mtimeMs: st.mtimeMs })
      }
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async parse(ref: SessionRef): Promise<OtlpSpan[]> {
    let session: GeminiSession
    try {
      session = JSON.parse(await readFile(ref.path, 'utf8')) as GeminiSession
    } catch {
      return []
    }
    const traceId = session.sessionId ?? ref.sessionId
    const messages = session.messages ?? []
    const rootId = `root:${traceId}`
    const start = iso(session.startTime ?? messages[0]?.timestamp, new Date(0).toISOString())

    const spans: OtlpSpan[] = [
      span({
        traceId,
        spanId: rootId,
        parentSpanId: null,
        name: 'session',
        kind: 'AGENT',
        startTime: start,
        endTime: iso(messages.at(-1)?.timestamp, start),
        service: this.service,
        agent: this.service,
      }),
    ]

    let step = 0
    for (const m of messages) {
      const mid = m.id ?? `m${step}`
      const ts = iso(m.timestamp, start)
      const llmId = `llm:${mid}`
      // The human's prompt text — emit a CHAIN span only when non-empty.
      if (m.type === 'user') {
        const prompt = textOf(m.content)
        if (prompt) {
          spans.push(
            userPromptSpan({
              traceId,
              spanId: `${llmId}:user`,
              parentSpanId: rootId,
              startTime: ts,
              content: prompt,
              service: this.service,
              agent: this.service,
              step,
            }),
          )
          step += 1
        }
      }
      spans.push(
        span({
          traceId,
          spanId: llmId,
          parentSpanId: rootId,
          name: `message.${m.type ?? 'unknown'}`,
          kind: 'LLM',
          startTime: ts,
          service: this.service,
          agent: this.service,
          model: m.model ?? null,
          inputTokens: m.tokens?.input ?? null,
          outputTokens: m.tokens?.output ?? null,
          step,
          content: textOf(m.content) || null,
        }),
      )
      step += 1

      for (const tc of m.toolCalls ?? []) {
        const err = toolStatusError(tc.status)
        spans.push(
          span({
            traceId,
            spanId: `tool:${tc.id ?? `${mid}:${step}`}`,
            parentSpanId: llmId,
            name: `tool.${tc.name ?? 'tool'}`,
            kind: 'TOOL',
            startTime: ts,
            status: err ? 'ERROR' : 'OK',
            statusMessage: err ? `status=${tc.status}` : undefined,
            service: this.service,
            agent: this.service,
            tool: tc.name ?? 'tool',
            step,
            content: tc.args != null ? JSON.stringify(tc.args) : null,
          }),
        )
        step += 1
      }
    }
    return spans
  }
}

export class GeminiAdapter extends GeminiFamilyAdapter {
  constructor() {
    super({ harness: 'gemini', service: 'gemini', homeDirName: '.gemini', aliases: ['gemini-cli'] })
  }
}
