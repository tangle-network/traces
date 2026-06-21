/**
 * Shared conversation-capture primitives for the harness adapters.
 *
 * Every adapter records the human's prompt and the assistant's prose, not just
 * the execution skeleton (LLM token spans + tool calls). These helpers keep that
 * capture identical across harnesses: one text cap, one `user.prompt` span shape.
 */

import type { OtlpSpan } from '../otlp.js'
import { span } from '../otlp.js'

/** Max chars of conversation text kept per span — enough for prompt/response
 *  analysis, bounded for storage + redaction cost. */
export const CONTENT_CAP = 8000

/** Trim and cap a message's text at {@link CONTENT_CAP}. When the text is cut, a
 *  visible `… [+N chars]` marker is appended so analysts (and readers) know the
 *  content was truncated rather than silently lost. */
export function capText(raw: string): string {
  const t = raw.trim()
  if (t.length <= CONTENT_CAP) return t
  return `${t.slice(0, CONTENT_CAP)}… [+${t.length - CONTENT_CAP} chars]`
}

/**
 * Who produced a `user.prompt` turn. The trace records every "user" message,
 * but only some are a real human typing — the rest are the harness or another
 * agent feeding the model:
 *   - `human`          a person typed it
 *   - `subagent-spawn` a parent agent spawned a subagent with this prompt
 *   - `injected`       a synthetic harness prompt (benchmark task, memory, …)
 *   - `tool-result`    a tool result surfaced as a user turn (rare)
 * Analysts that measure human reactions must filter to `human` only.
 */
export type Actor = 'human' | 'subagent-spawn' | 'injected' | 'tool-result'

/** Span attribute key for {@link Actor}. New (additive) — not part of the
 *  `tangle.sessionId`/`tangle.ingest_source` wire contract. */
export const ACTOR_ATTR = 'tangle.actor'

export interface UserPromptInput {
  traceId: string
  spanId: string
  parentSpanId: string | null
  startTime: string
  /** The human's prompt text (extracted by the adapter; cap with capText). */
  content: string
  service?: string | null
  agent?: string | null
  step?: number
  /** Who produced this turn. Defaults to `human` when the adapter can't tell. */
  actor?: Actor
}

/** The canonical `user.prompt` span. Every adapter emits the human's turn the
 *  same way — a CHAIN span, because a user message is not an LLM call — so
 *  analysts see one consistent shape regardless of harness. The `actor`
 *  attribute lets analysts separate real human turns from agent-to-agent or
 *  injected prompts. */
export function userPromptSpan(o: UserPromptInput): OtlpSpan {
  return span({
    traceId: o.traceId,
    spanId: o.spanId,
    parentSpanId: o.parentSpanId,
    name: 'user.prompt',
    kind: 'CHAIN',
    startTime: o.startTime,
    service: o.service ?? null,
    agent: o.agent ?? null,
    step: o.step,
    content: o.content,
    extra: { [ACTOR_ATTR]: o.actor ?? 'human' },
  })
}
