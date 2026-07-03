/**
 * BYO analyst/proposal config for:
 *
 *   traces improve --last 5 --config examples/improvement-config.mjs --dir .traces/improvement
 */
import { makeFinding } from '@tangle-network/traces'

export default {
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
  improvementAdapter: {
    async propose(input) {
      return input.recommendations.slice(0, 3).map((recommendation, index) => ({
        id: `example-proposal-${index + 1}`,
        title: recommendation.title,
        description: recommendation.action,
        recommendationIds: [recommendation.id],
        validationCommand: 'traces improve --last 5',
        evidenceRefs: recommendation.evidenceRefs,
      }))
    },
  },
}
