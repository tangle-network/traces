/**
 * BYO analyst config for:
 *
 *   traces improve --last 5 --config examples/improvement-config.mjs --dir .traces/improvement
 *   traces stream --mode agent --config examples/improvement-config.mjs
 */
import { makeFinding } from '@tangle-network/traces'

export default {
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
  analysts: [{
    id: 'example-profile-analyst',
    description: 'flags sessions that need a clearer recommendation writer',
    inputKind: 'trace-store',
    cost: { kind: 'deterministic' },
    version: '1.0.0',
    async analyze() {
      return [makeFinding({
        analyst_id: 'example-profile-analyst',
        area: 'communication',
        claim: 'recommendations should be rewritten as concrete action plus validation',
        severity: 'medium',
        evidence_refs: [{ kind: 'metric', uri: 'example.profile_rule' }],
        recommended_action: 'Route findings through a recommendation-writing profile before presenting them.',
        validation_plan: 'Rerun traces improve and confirm every recommendation has an action and a check.',
        confidence: 0.8,
      })]
    },
  }],
}
