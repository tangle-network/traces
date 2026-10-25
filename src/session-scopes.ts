/** Session scopes over normalized spans. Child projection never reads a native store. */
import { ATTR, indexSessionIdsByTrace } from './attributes.js'
import { buildSpanRunTree } from './run-span-tree.js'
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
    return includeSubagents ? canonicalNodeScopes(parent) : [parent]
  })
}

function text(span: OtlpSpan, key: string): string | undefined {
  const value = span.attributes[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function canonicalNodeScopes(parent: TraceGroup): TraceGroup[] {
  const tree = buildSpanRunTree(parent.spans, 'session-facts')
  if (tree.nodes.length <= 1) return [parent]
  const byId = new Map(parent.spans.map((span) => [span.span_id, span]))
  const nodeSession = new Map(tree.nodes.map((node) => {
    const anchor = byId.get(node.spanId)!
    const legacyChild = isSubagentSpan(anchor.attributes) ? text(anchor, 'traces.claude.source_trace_id') : undefined
    const id = text(anchor, 'traces.span.subagent_session_id')
      ?? (legacyChild !== parent.sessionId ? legacyChild : undefined)
      ?? (node.parentNodeId === null ? parent.sessionId : undefined)
      ?? null
    return [node.spanId, id]
  }))
  return tree.nodes.map((node) => {
    const sessionId = nodeSession.get(node.spanId)!
    const source = node.spanIds.map((id) => byId.get(id)!).filter(Boolean)
    // The normal sheet remains exactly unchanged for a harness parent whose children
    // were already marked as separate records; generic span nodes are exclusive too.
    if (node.parentNodeId === null && parent.spans.some((span) => isSubagentSpan(span.attributes))) return parent
    const ids = new Set(source.map((span) => span.span_id))
    const spans = source.map((span): OtlpSpan => {
      const attributes: Record<string, unknown> = { ...span.attributes, [ATTR.SESSION_ID]: sessionId }
      delete attributes['traces.span.subagent']
      const parentSessionId = node.parentNodeId === null ? undefined : nodeSession.get(node.parentNodeId)
      if (parentSessionId) attributes['traces.parent_session_id'] = parentSessionId
      return { ...span, attributes,
        parent_span_id: span.span_id === node.spanId ? null
          : span.parent_span_id && ids.has(span.parent_span_id) ? span.parent_span_id : node.spanId }
    })
    return { traceId: parent.traceId, sessionId, spans }
  })
}
