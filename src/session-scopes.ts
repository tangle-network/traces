/** Session scopes over normalized spans. Child projection never reads a native store. */
import { deriveHexId } from '@tangle-network/agent-trace-contract'
import { ATTR, indexSessionIdsByTrace } from './attributes.js'
import { isSubagentSpan } from './adapters/provenance.js'
import type { OtlpSpan } from './otlp.js'

export interface TraceGroup {
  readonly traceId: string
  readonly sessionId: string | null
  readonly spans: OtlpSpan[]
}

/** Group traces unchanged by default; optionally expose folded children as exclusive scopes. */
export function groupByTrace(spans: readonly OtlpSpan[], includeSubagents = false): TraceGroup[] {
  const { sessionByTrace } = indexSessionIdsByTrace(spans)
  const byTrace = new Map<string, OtlpSpan[]>()
  for (const span of spans) {
    const group = byTrace.get(span.trace_id)
    if (group) group.push(span)
    else byTrace.set(span.trace_id, [span])
  }
  return [...byTrace].flatMap(([traceId, traceSpans]) => {
    const parent = { traceId, sessionId: sessionByTrace.get(traceId) ?? null, spans: traceSpans }
    return includeSubagents ? [parent, ...foldedChildScopes(parent)] : [parent]
  })
}

function text(span: OtlpSpan, key: string): string | undefined {
  const value = span.attributes[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function foldedChildScopes(parent: TraceGroup): TraceGroup[] {
  const children = new Map<string, OtlpSpan[]>()
  for (const span of parent.spans) {
    if (!isSubagentSpan(span.attributes)) continue
    const id = text(span, 'traces.span.subagent_session_id')
      ?? text(span, 'traces.claude.source_trace_id')
    // An old export that lacks child identity cannot support a separate node's facts.
    if (!id || id === parent.sessionId) continue
    const group = children.get(id) ?? []
    group.push(span)
    children.set(id, group)
  }
  const owner = new Map(parent.spans.map((span) => [span.span_id,
    isSubagentSpan(span.attributes)
      ? text(span, 'traces.span.subagent_session_id') ?? text(span, 'traces.claude.source_trace_id')
      : parent.sessionId]))
  return [...children].map(([sessionId, source]) => {
    const traceId = deriveHexId(`traces.session.scope:${sessionId}`, 16)
    const ids = new Set(source.map((span) => span.span_id))
    const anchor = source.find((span) => span.attributes['openinference.span.kind'] === 'AGENT'
      && (!span.parent_span_id || !ids.has(span.parent_span_id)))
    const spans = source.map((span): OtlpSpan => {
      const attributes: Record<string, unknown> = { ...span.attributes, [ATTR.SESSION_ID]: sessionId }
      delete attributes['traces.span.subagent']
      const external = span.parent_span_id && !ids.has(span.parent_span_id)
      const recordedParent = text(span, 'traces.span.parent_session_id')
        ?? (external ? owner.get(span.parent_span_id!) : undefined)
      if (recordedParent && recordedParent !== sessionId) attributes['traces.parent_session_id'] = recordedParent
      return {
        ...span, trace_id: traceId, attributes,
        parent_span_id: span === anchor ? null : external && anchor ? anchor.span_id : span.parent_span_id,
      }
    })
    return { traceId, sessionId, spans }
  })
}
