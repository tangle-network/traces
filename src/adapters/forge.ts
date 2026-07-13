/**
 * Forge adapter (antinomyhq/forge) — `/dump` JSON exports.
 *
 * Forge's primary store is SQLite (`~/.forge/.forge.db`, `conversations.context`
 * column). Reading it live needs a native sqlite dep, so v1 parses the
 * dependency-free `/dump` artifact instead: `<cwd>/YYYY-MM-DD_HH-MM-SS-dump.json`,
 * a single flattened `Context{ conversation_id, messages[] }`.
 *
 * Flattened message entry (from forge Rust serde, high conf): `{ text: {role,
 * content, tool_calls?[], model?}, usage }` or `{ tool: {name, call_id?,
 * output:{is_error, values}}, usage }`. Tokens are `TokenCount` = `{actual:N}`
 * or `{approx:N}`. Parse unverified against local data.
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { isMissingPathError, readJsonFile } from '../json.js'
import type { OtlpSpan } from '../otlp.js'
import { span } from '../otlp.js'
import { capText, userPromptSpan } from './conversation.js'
import { recordToolOutput, toolIoAttributes } from './tool-io.js'
import type { HarnessTraceAdapter, LocateOptions, SessionRef } from '../types.js'

const SERVICE = 'forge'

interface TokenCount {
  actual?: number
  approx?: number
}
interface ForgeToolCall {
  name?: string
  call_id?: string
  arguments?: unknown
}
interface ForgeText {
  role?: string
  content?: string
  tool_calls?: ForgeToolCall[]
  model?: string
}
interface ForgeToolResult {
  name?: string
  call_id?: string
  output?: { is_error?: boolean; values?: unknown }
}
interface ForgeEntry {
  text?: ForgeText
  tool?: ForgeToolResult
  usage?: { prompt_tokens?: TokenCount; completion_tokens?: TokenCount }
  message?: ForgeEntry // DB variant nests under `message`; tolerate both.
}
interface ForgeDump {
  conversation_id?: string
  messages?: ForgeEntry[]
  context?: { conversation_id?: string; messages?: ForgeEntry[] }
}

function tokens(t: TokenCount | undefined): number | null {
  if (!t) return null
  return t.actual ?? t.approx ?? null
}

/** Forge bodies are plain strings; trim and cap. */
function textOf(content: string | undefined): string {
  return capText(content ?? '')
}

export class ForgeAdapter implements HarnessTraceAdapter {
  readonly harness = 'forge'
  readonly aliases = ['forgecode'] as const

  /** Directories scanned for `*-dump.json` exports. */
  private dumpDirs(): string[] {
    return [process.cwd(), join(homedir(), '.forge')]
  }

  async locate(opts: LocateOptions = {}): Promise<SessionRef[]> {
    const refs: SessionRef[] = []
    const dirs = opts.cwd ? [opts.cwd] : this.dumpDirs()
    for (const dir of dirs) {
      let files: string[]
      try {
        files = await readdir(dir)
      } catch (error) {
        if (isMissingPathError(error)) continue
        throw error
      }
      for (const f of files) {
        if (!f.endsWith('-dump.json')) continue
        const path = join(dir, f)
        let st: Awaited<ReturnType<typeof stat>>
        try {
          st = await stat(path)
        } catch (error) {
          if (isMissingPathError(error)) continue
          throw error
        }
        if (opts.sinceMs && st.mtimeMs < opts.sinceMs) continue
        refs.push({ harness: this.harness, sessionId: basename(f, '.json'), path, cwd: dir, mtimeMs: st.mtimeMs })
      }
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async parse(ref: SessionRef): Promise<OtlpSpan[]> {
    const dump = await readJsonFile<ForgeDump>(ref.path)
    const ctx = dump.context ?? dump
    const traceId = ctx.conversation_id ?? ref.sessionId
    const rootId = `root:${traceId}`
    const messages = ctx.messages ?? []

    const spans: OtlpSpan[] = [
      span({ traceId, spanId: rootId, parentSpanId: null, name: 'session', kind: 'AGENT', startTime: new Date(0).toISOString(), service: SERVICE, agent: SERVICE }),
    ]
    const toolByCallId = new Map<string, OtlpSpan>()
    let step = 0
    let lastLlm = rootId

    for (const raw of messages) {
      const entry = raw.message ?? raw // unwrap DB nesting
      const ts = new Date(0).toISOString()
      if (entry.text && entry.text.role === 'user') {
        // The human's prompt text. Emit a CHAIN span only when non-empty
        // (a tool-result-only turn rides as `entry.tool`, not here).
        const prompt = textOf(entry.text.content)
        if (prompt) {
          spans.push(
            userPromptSpan({
              traceId,
              spanId: `user:${step}`,
              parentSpanId: rootId,
              startTime: ts,
              content: prompt,
              service: SERVICE,
              agent: SERVICE,
              step,
            }),
          )
          step += 1
        }
      } else if (entry.text) {
        const llmId = `llm:${step}`
        spans.push(
          span({
            traceId,
            spanId: llmId,
            parentSpanId: rootId,
            name: `message.${entry.text.role ?? 'unknown'}`,
            kind: 'LLM',
            startTime: ts,
            service: SERVICE,
            agent: SERVICE,
            model: entry.text.model ?? null,
            inputTokens: tokens(raw.usage?.prompt_tokens),
            outputTokens: tokens(raw.usage?.completion_tokens),
            step,
            content: textOf(entry.text.content) || null,
          }),
        )
        lastLlm = llmId
        step += 1
        for (const tc of entry.text.tool_calls ?? []) {
          const id = tc.call_id ?? `${step}`
          const t = span({
            traceId,
            spanId: `tool:${id}`,
            parentSpanId: llmId,
            name: `tool.${tc.name ?? 'tool'}`,
            kind: 'TOOL',
            startTime: ts,
            service: SERVICE,
            agent: SERVICE,
            tool: tc.name ?? 'tool',
            step,
            extra: toolIoAttributes({ input: tc.arguments }),
          })
          spans.push(t)
          toolByCallId.set(id, t)
          step += 1
        }
      } else if (entry.tool) {
        const t = toolByCallId.get(entry.tool.call_id ?? '')
        if (t) {
          t.status = entry.tool.output?.is_error ? { code: 'ERROR', message: 'tool reported error' } : { code: 'OK' }
          recordToolOutput(t, entry.tool.output?.values ?? entry.tool.output)
        }
      }
    }
    return spans
  }
}
