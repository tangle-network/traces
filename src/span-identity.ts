import { canonicalJson } from './adapters/tool-io.js'
import type { OtlpSpan } from './otlp.js'

/** An OTLP span id is scoped to its trace, including when several producers replay it. */
export const spanKey = (traceId: string, spanId: string): string => JSON.stringify([traceId, spanId])

/** Kit callers can pass overlapping refs or repeated exporter batches. Repeated
 * deliveries count once. Different bodies with the same identity cannot be joined. */
export function distinctSpans(spans: readonly OtlpSpan[]): readonly OtlpSpan[] {
  const seen = new Map<string, OtlpSpan>()
  for (const span of spans) {
    const key = spanKey(span.trace_id, span.span_id)
    const prior = seen.get(key)
    if (!prior) seen.set(key, span)
    else if (prior !== span && canonicalJson(prior) !== canonicalJson(span)) {
      throw new Error(`conflicting bodies for span ${span.span_id} in trace ${span.trace_id}`)
    }
  }
  return seen.size === spans.length ? spans : [...seen.values()]
}
