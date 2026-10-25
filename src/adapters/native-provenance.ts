import type { HarnessSession } from '@tangle-network/harness-sessions'
import type { OtlpSpan } from '../otlp.js'

export function stampNativeProvenance(session: HarnessSession, spans: OtlpSpan[]): void {
  const prefix = session.harness === 'codex' ? 'traces.codex' : 'traces.claude'
  if (session.harness !== 'codex' && session.harness !== 'claude-code') return
  for (const item of spans) item.attributes[`${prefix}.source_trace_id`] = session.nativeSessionId
  const tools = new Map(spans.filter((item) => item.attributes['openinference.span.kind'] === 'TOOL')
    .map((item) => [item.attributes['gen_ai.tool.call.id'], item]))
  const counts = new Map<string, number>()
  for (const call of session.toolCalls) {
    const item = tools.get(call.id)
    if (!item) continue
    const key = call.messageId ?? ''
    const index = counts.get(key) ?? 0
    counts.set(key, index + 1)
    item.attributes[`${prefix}.source_span_id`] = session.harness === 'codex'
      ? `tool:${call.id}` : `${key}:tool:${index}`
  }
}

/** Stable source scope, distinct even when two transcripts reuse one agent ID. */
export function foldedChildIdentity(parentSessionId: string, sourceKey: string): Record<string, unknown> {
  return {
    'traces.span.subagent': true,
    'traces.span.subagent_session_id': `${parentSessionId}/subagents/${sourceKey}`,
  }
}
