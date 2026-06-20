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
}

/** The canonical `user.prompt` span. Every adapter emits the human's turn the
 *  same way — a CHAIN span, because a user message is not an LLM call — so
 *  analysts see one consistent shape regardless of harness. */
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
  })
}
