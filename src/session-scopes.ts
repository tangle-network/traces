/** Session scopes over normalized spans. Child projection never reads a native store. */
import { distinctSpans } from './span-identity.js'
import { ATTR, indexSessionIdsByTrace } from './attributes.js'
import { buildSpanRunTree } from './run-span-tree.js'
import { isSubagentSpan } from './adapters/provenance.js'
import type { OtlpSpan } from './otlp.js'
import type { UnreadSessionFact } from './session-facts.js'

export interface TraceGroup {
  readonly traceId: string
  readonly sessionId: string | null
  readonly spans: OtlpSpan[]
}

/** Explain an unavailable session when a window or a composite run still has other scopes to read. */
export function unreadTraceGroup(group: TraceGroup, windowed: boolean): UnreadSessionFact {
  const unread = group.spans.find((span) => typeof span.attributes[ATTR.CORRUPTION_COUNT] === 'number')
  const detail = unread ? `${unread.attributes[ATTR.CORRUPTION_COUNT]} unread record(s)` : 'no record spans'
  return {
    sessionId: group.sessionId, traceId: group.traceId, source: null,
    reason: `no record could be read (${detail})` +
      (windowed ? ', so whether the session holds a record inside the window is unknown' : ''),
  }
}

/** Group traces unchanged by default; optionally expose folded children as exclusive scopes. */
export function groupByTrace(spans: readonly OtlpSpan[], includeSubagents = false): TraceGroup[] {
  const unique = distinctSpans(spans)
  const { sessionByTrace } = indexSessionIdsByTrace(unique)
  const byTrace = new Map<string, OtlpSpan[]>()
  for (const span of unique) {
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
  if (tree.readError) throw Object.assign(new Error(`cannot attribute facts for trace ${parent.traceId}: ${tree.readError}`), { code: 'no-outcome' })
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
