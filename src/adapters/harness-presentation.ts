/** Project native session evidence and recorded conversation into the span shape Traces reads. */
import { applyLlmSpanOtlpAttributes } from '@tangle-network/agent-eval/trace-attributes'
import { contractSpan, deriveHexId, type ContractSpan } from '@tangle-network/agent-trace-contract'
import type { HarnessSession } from '@tangle-network/harness-sessions'
import { statusCode } from '../otlp-input.js'
import type { OtlpSpan } from '../otlp.js'
import { bridgeNativeSessionAttributes, NATIVE_INHERITED_SPAN_ATTR } from './provenance.js'

export function asTracesSpan(item: ContractSpan): OtlpSpan {
  const attributes: Record<string, unknown> = { ...item.attributes }
  bridgeNativeSessionAttributes(attributes)
  if (item.kind === 'LLM') {
    applyLlmSpanOtlpAttributes(attributes, {
      model: typeof attributes['gen_ai.request.model'] === 'string' ? attributes['gen_ai.request.model'] : undefined,
      inputTokens: typeof attributes['gen_ai.usage.input_tokens'] === 'number' ? attributes['gen_ai.usage.input_tokens'] : undefined,
      outputTokens: typeof attributes['gen_ai.usage.output_tokens'] === 'number' ? attributes['gen_ai.usage.output_tokens'] : undefined,
      reasoningTokens: typeof attributes['gen_ai.usage.reasoning_tokens'] === 'number' ? attributes['gen_ai.usage.reasoning_tokens'] : undefined,
      cachedTokens: typeof attributes['gen_ai.usage.cache_read.input_tokens'] === 'number' ? attributes['gen_ai.usage.cache_read.input_tokens'] : undefined,
      cacheWriteTokens: typeof attributes['gen_ai.usage.cache_creation.input_tokens'] === 'number' ? attributes['gen_ai.usage.cache_creation.input_tokens'] : undefined,
    })
  }
  if (item.kind === 'TOOL' && typeof attributes['gen_ai.tool.name'] === 'string') {
    attributes['tool.name'] = attributes['gen_ai.tool.name']
  }
  return {
    trace_id: item.trace_id,
    span_id: item.span_id,
    parent_span_id: item.parent_span_id,
    name: item.name,
    start_time: item.start_time,
    end_time: item.end_time,
    status: { code: statusCode(item.status.code), ...(item.status.message ? { message: item.status.message } : {}) },
    attributes,
    ...(item.links ? { links: [...item.links] } : {}),
  }
}

export function messageText(message: HarnessSession['messages'][number]): string {
  return message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

export function presentationSpans(session: HarnessSession, root: OtlpSpan): OtlpSpan[] {
  const spans = new Map<string, OtlpSpan>()
  for (const message of session.messages) {
    if (message.role === 'tool' || !message.at) continue
    const text = messageText(message)
    if (!text) continue
    // A system message is context the harness put in front of the model; its size is the uncut text's.
    const context = message.role === 'system' ? { 'traces.context.source': message.source ?? 'system', 'traces.context.bytes': Buffer.byteLength(text), 'traces.context.lines': text.split('\n').length } : {}
    const item = contractSpan({
      traceId: root.trace_id,
      spanId: deriveHexId(`${session.harness}:${session.nativeSessionId}:message:${message.id}`, 8),
      parentSpanId: root.span_id,
      name: message.role === 'user' ? 'user.prompt' : `message.${message.role}`,
      kind: 'CHAIN',
      startTime: message.at,
      endTime: message.at,
      attributes: {
        'service.name': session.harness, 'tangle.actor': message.actor, content: text.slice(0, 8000),
        ...context, ...(message.inherited ? { [NATIVE_INHERITED_SPAN_ATTR]: true } : {}),
      },
    })
    // Claude can re-emit a message with the same native ID after a resumed
    // subagent turn. The later copy can carry stronger actor attribution.
    spans.set(item.span_id, asTracesSpan(item))
  }
  return [...spans.values()]
}
