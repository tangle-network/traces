/**
 * BYO analyst config for:
 *
 *   traces improve --last 5 --config examples/improvement-config.mjs --dir .traces/improvement
 *   traces stream --mode agent --config examples/improvement-config.mjs
 */
import { buildDefaultAnalystRegistry, makeFinding } from '@tangle-network/traces'

const registry = buildDefaultAnalystRegistry()

registry.register({
  id: 'example-error-summary',
  description: 'Reports the most frequent error signature in the selected traces.',
  inputKind: 'trace-store',
  cost: { kind: 'deterministic' },
  version: '1.0.0',
  async analyze(store) {
    const overview = await store.getOverview({ has_errors: true })
    const cluster = overview.error_clusters[0]
    if (!cluster) return []
    return [makeFinding({
      analyst_id: 'example-error-summary',
      area: 'tool-use',
      subject: cluster.signature,
      claim: `${cluster.span_count} failed span(s) share the error: ${cluster.status_message_sample}`,
      severity: cluster.span_count >= 3 ? 'high' : 'medium',
      evidence_refs: [{
        kind: 'span',
        uri: `trace://${encodeURIComponent(cluster.exemplar_trace_ids[0])}/span/${encodeURIComponent(cluster.exemplar_span_ids[0])}`,
        excerpt: cluster.status_message_sample,
      }],
      recommended_action: `Fix or change the retry policy for ${cluster.tool_name ?? cluster.span_name ?? 'the failing operation'}.`,
      validation_plan: 'Rerun the same task and confirm this error signature is absent.',
      confidence: 1,
      id_basis: cluster.signature,
    })]
  },
})

export default {
  registry,
  liveAnalysts: [{
    id: 'example-live-claim-check',
    analyze(context) {
      if (!context.actions.some((action) => action.kind === 'claim')) return []
      return [{
        schemaVersion: 1,
        kind: 'traces.live_finding',
        id: `live.example-live-claim-check.${context.session.sessionId}`,
        ruleId: 'example-live-claim-check',
        fingerprint: `example-live-claim-check.${context.session.sessionId}`,
        severity: 'info',
        title: 'Custom live analyst saw a completion claim',
        claim: 'The trace contains a claim-like assistant message.',
        action: 'Keep this custom rule narrow; require evidence before alerting.',
        check: 'Confirm the next stream event includes any required verification signal.',
        evidence: [{ kind: 'metric', label: 'actions', value: String(context.actions.length) }],
        session: context.session,
        observedAt: context.generatedAt,
      }]
    },
  }],
}
