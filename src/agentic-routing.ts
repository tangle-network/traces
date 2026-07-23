import {
  DEFAULT_TRACE_ANALYST_KINDS,
  type TraceAnalystKindSpec,
} from '@tangle-network/agent-eval/analyst'
import type { PipelineReport } from './pipelines.js'
import type { ReactionReport } from './reactions.js'

export type TraceAgenticRouteReasonCode =
  | 'requested-baseline'
  | 'execution-failures'
  | 'repeated-tool-loops'
  | 'corrective-human-feedback'

export interface TraceAgenticRouteReason {
  readonly code: TraceAgenticRouteReasonCode
  readonly detail: string
}

/** A deterministic selection record for the agent-eval trace analysts. */
export interface TraceAgenticRoute {
  readonly schemaVersion: 1
  readonly kind: 'traces.agentic_route'
  /** Agent ids in execution order. Later agents receive earlier findings. */
  readonly analystIds: readonly string[]
  /** Why each extra analyst earned model spend. */
  readonly reasons: readonly TraceAgenticRouteReason[]
}

/**
 * Select the smallest useful agent-eval trace-analysis suite.
 *
 * A caller explicitly requesting LLM analysis always gets one failure-mode
 * pass. The remaining lenses require a local signal first, and the edit
 * designer runs only when there is something concrete to improve.
 */
export function planTraceAgenticRoute(
  pipelines: PipelineReport,
  reactions: ReactionReport,
): TraceAgenticRoute {
  const reasons: TraceAgenticRouteReason[] = [{
    code: 'requested-baseline',
    detail: 'LLM trace analysis was explicitly requested; start with one bounded failure-mode pass.',
  }]
  const ids = new Set<string>(['failure-mode'])
  const hasFailures = pipelines.failureClusters.totalFailures > 0
  const hasLoops = pipelines.stuckLoops.findings.length > 0
  const corrective =
    reactions.signals.correction +
    reactions.signals.frustration +
    reactions.signals.jargon +
    reactions.signals.structure

  if (hasFailures) {
    reasons.push({
      code: 'execution-failures',
      detail: `${pipelines.failureClusters.totalFailures} execution failure(s) require a concrete edit proposal.`,
    })
  }
  if (hasLoops) {
    reasons.push({
      code: 'repeated-tool-loops',
      detail: `${pipelines.stuckLoops.findings.length} repeated tool-call loop(s) require a concrete edit proposal.`,
    })
  }
  if (corrective > 0) {
    ids.add('knowledge-gap')
    ids.add('knowledge-poisoning')
    reasons.push({
      code: 'corrective-human-feedback',
      detail: `${corrective} corrective human reaction signal(s) warrant gap and contradiction analysis.`,
    })
  }
  if (hasFailures || hasLoops || corrective > 0) ids.add('improvement')

  return {
    schemaVersion: 1,
    kind: 'traces.agentic_route',
    analystIds: DEFAULT_TRACE_ANALYST_KINDS
      .map((spec) => spec.id)
      .filter((id) => ids.has(id)),
    reasons,
  }
}

/** Resolve a route into the maintained agent-eval kind specifications. */
export function traceAgenticKinds(route: TraceAgenticRoute): readonly TraceAnalystKindSpec[] {
  const selected = new Set(route.analystIds)
  return DEFAULT_TRACE_ANALYST_KINDS.filter((spec) => selected.has(spec.id))
}
