/**
 * The two questions a LOOP trace exists to answer, and that a flat event list
 * cannot: **did round N+1 improve on round N**, and **which verdict caused
 * which retry**.
 *
 * Both are read from the contract's own vocabulary and nothing else:
 *
 * - `agent.loop.id` / `agent.loop.iteration` group and order the rounds.
 * - `agent.outcome` / `agent.outcome.score` carry the verdict. A round rarely
 *   grades itself — the grade lives on an EVALUATOR span underneath it — so the
 *   verdict is taken from the shallowest descendant that has one, which is the
 *   round's own verdict rather than one of its per-layer sub-verdicts.
 * - `links` carry causality. `parent_span_id` says round N+1 happened INSIDE
 *   round N, which is false; the link says round N's verdict CAUSED it, which
 *   is the edge a steering chain is made of.
 *
 * Nothing here throws on malformed input, and nothing is inferred where the
 * trace is silent: a loop with no scores reports `unscored`, not a flat trend.
 */

import {
  ATTR,
  firstNumberAttr,
  firstStringAttr,
  ITERATION_ATTR_KEYS,
  LINK_KIND_ATTR,
  type Outcome,
  OUTCOMES,
} from '@tangle-network/agent-trace-contract'
import type { OtlpSpan } from './otlp.js'
import { parseIsoToEpochMs } from './time.js'

/** Whether the rounds got better, stayed put, or got worse — and on what basis. */
export type LoopTrend = 'improved' | 'plateaued' | 'regressed' | 'mixed' | 'unscored'

/** What the trend was computed from, so a reader can tell a score series from
 *  a pass/fail series from nothing at all. */
export type LoopTrendBasis = 'score' | 'outcome' | 'none'

export interface LoopIteration {
  readonly iteration: number
  readonly spanId: string
  readonly name: string
  /** Terminal verdict for the round, from the round or its shallowest graded descendant. */
  readonly outcome: Outcome | null
  readonly score: number | null
  /** Span the verdict was read from; equals `spanId` when the round graded itself. */
  readonly verdictSpanId: string | null
  readonly startTime: string
  readonly durationMs: number | null
}

export interface LoopConvergence {
  readonly loopId: string
  readonly traceId: string
  readonly iterations: readonly LoopIteration[]
  readonly trend: LoopTrend
  readonly basis: LoopTrendBasis
  /** The trend in the trace's own numbers, e.g. "score 0.4 → 0.9 over 4 rounds". */
  readonly detail: string
}

export interface LoopConvergenceReport {
  readonly loops: readonly LoopConvergence[]
  /** Spans carrying `agent.loop.iteration` — 0 means the trace records no rounds. */
  readonly iterationSpans: number
}

/** One causal edge: a graded span, and the work it caused. */
export interface SteeringEdge {
  /** The span that CAUSED the work — a verdict, an earlier attempt. */
  readonly causeSpanId: string
  readonly causeName: string | null
  readonly causeOutcome: Outcome | null
  readonly causeScore: number | null
  /** The span the link was recorded on: the work that was caused. */
  readonly effectSpanId: string
  readonly effectName: string
  readonly effectIteration: number | null
  /** `agent.link.kind`, or `unspecified` when the producer recorded none. */
  readonly linkKind: string
  /** False when the cause is absent from this export, so the chain breaks here. */
  readonly resolved: boolean
}

export interface SteeringChainReport {
  readonly edges: readonly SteeringEdge[]
  readonly links: number
  readonly dangling: number
  readonly byKind: Readonly<Record<string, number>>
}

function attributes(span: OtlpSpan): Record<string, unknown> {
  return span.attributes
}

function outcomeOf(span: OtlpSpan): Outcome | null {
  const raw = firstStringAttr(attributes(span), [ATTR.outcome])
  return raw !== undefined && (OUTCOMES as readonly string[]).includes(raw) ? (raw as Outcome) : null
}

function scoreOf(span: OtlpSpan): number | null {
  return firstNumberAttr(attributes(span), [ATTR.score]) ?? null
}

function iterationOf(span: OtlpSpan): number | null {
  const value = firstNumberAttr(attributes(span), ITERATION_ATTR_KEYS)
  return value !== undefined && Number.isFinite(value) ? value : null
}

function durationOf(span: OtlpSpan): number | null {
  try {
    const ms = parseIsoToEpochMs(span.end_time) - parseIsoToEpochMs(span.start_time)
    return Number.isFinite(ms) && ms >= 0 ? ms : null
  } catch {
    return null
  }
}

/**
 * The verdict for a round: its own if it carries one, else the SHALLOWEST
 * graded descendant's. Shallowest, because a verification span's own children
 * are per-layer sub-verdicts — taking one of those would report a single
 * layer's result as the round's.
 */
function verdictFor(
  span: OtlpSpan,
  childrenOf: ReadonlyMap<string, readonly OtlpSpan[]>,
): { outcome: Outcome | null; score: number | null; spanId: string | null } {
  const own = outcomeOf(span)
  const ownScore = scoreOf(span)
  if (own !== null || ownScore !== null) return { outcome: own, score: ownScore, spanId: span.span_id }

  const queue: OtlpSpan[] = [...(childrenOf.get(span.span_id) ?? [])]
  const seen = new Set<string>([span.span_id])
  while (queue.length > 0) {
    const current = queue.shift()!
    if (seen.has(current.span_id)) continue
    seen.add(current.span_id)
    const outcome = outcomeOf(current)
    const score = scoreOf(current)
    if (outcome !== null || score !== null) return { outcome, score, spanId: current.span_id }
    // Do not descend past a round: a nested loop grades itself.
    if (iterationOf(current) !== null) continue
    queue.push(...(childrenOf.get(current.span_id) ?? []))
  }
  return { outcome: null, score: null, spanId: null }
}

function childIndex(spans: readonly OtlpSpan[]): Map<string, OtlpSpan[]> {
  const children = new Map<string, OtlpSpan[]>()
  for (const span of spans) {
    if (span.parent_span_id === null) continue
    const bucket = children.get(span.parent_span_id) ?? []
    bucket.push(span)
    children.set(span.parent_span_id, bucket)
  }
  return children
}

const OUTCOME_RANK: Record<Outcome, number> = { error: 0, fail: 1, pass: 2 }

/**
 * `mixed` is a distinct answer from `plateaued`: a loop that scored 0.4, 0.9,
 * 0.4 ends where it started, and calling that "no change" hides that the agent
 * HAD the answer and then lost it — a different problem with a different fix.
 */
function compare(series: readonly number[]): LoopTrend {
  const first = series[0]!
  const last = series[series.length - 1]!
  if (last > first) return 'improved'
  if (last < first) return 'regressed'
  return Math.max(...series) > first || Math.min(...series) < first ? 'mixed' : 'plateaued'
}

function trendOf(iterations: readonly LoopIteration[]): {
  trend: LoopTrend
  basis: LoopTrendBasis
  detail: string
} {
  const scored = iterations.filter((entry) => entry.score !== null)
  if (scored.length >= 2) {
    const series = scored.map((entry) => entry.score!)
    const best = Math.max(...series)
    return {
      trend: compare(series),
      basis: 'score',
      detail:
        `score ${series[0]} → ${series[series.length - 1]} across ${series.length} graded round(s) ` +
        `(round ${scored[0]!.iteration} → ${scored[scored.length - 1]!.iteration}); ` +
        `best ${best} at round ${scored[series.indexOf(best)]!.iteration}`,
    }
  }

  const graded = iterations.filter((entry) => entry.outcome !== null)
  if (graded.length >= 2) {
    return {
      trend: compare(graded.map((entry) => OUTCOME_RANK[entry.outcome!])),
      basis: 'outcome',
      detail:
        `outcome ${graded.map((entry) => entry.outcome).join(' → ')} across rounds ` +
        `${graded.map((entry) => entry.iteration).join(', ')}`,
    }
  }

  return {
    trend: 'unscored',
    basis: 'none',
    detail:
      `${iterations.length} round(s) recorded, ${scored.length + graded.length} graded: the trace carries ` +
      `neither ${ATTR.outcome} nor ${ATTR.score} on enough rounds to compare them`,
  }
}

/**
 * Round-over-round convergence, per loop.
 *
 * Rounds are ordered by `agent.loop.iteration`, not by time: a resumed or
 * re-run round is written later than the round it replaces, and time order
 * would report the replacement as a new round.
 */
export function analyzeLoopConvergence(spans: readonly OtlpSpan[]): LoopConvergenceReport {
  const children = childIndex(spans)
  const byLoop = new Map<string, { traceId: string; iterations: LoopIteration[] }>()
  let iterationSpans = 0

  for (const span of spans) {
    const iteration = iterationOf(span)
    if (iteration === null) continue
    iterationSpans += 1
    // A loop with no id still has rounds; the trace is the only honest grouping
    // key left, and inventing a shared id across traces would merge two runs.
    const loopId = firstStringAttr(attributes(span), [ATTR.loopId]) ?? `(unnamed loop in ${span.trace_id})`
    const key = `${span.trace_id}\x00${loopId}`
    const verdict = verdictFor(span, children)
    const bucket = byLoop.get(key) ?? { traceId: span.trace_id, iterations: [] }
    bucket.iterations.push({
      iteration,
      spanId: span.span_id,
      name: span.name,
      outcome: verdict.outcome,
      score: verdict.score,
      verdictSpanId: verdict.spanId,
      startTime: span.start_time,
      durationMs: durationOf(span),
    })
    byLoop.set(key, bucket)
  }

  const loops: LoopConvergence[] = []
  for (const [key, bucket] of byLoop) {
    const iterations = [...bucket.iterations].sort(
      (left, right) => left.iteration - right.iteration || left.startTime.localeCompare(right.startTime),
    )
    loops.push({
      loopId: key.slice(key.indexOf('\x00') + 1),
      traceId: bucket.traceId,
      iterations,
      ...trendOf(iterations),
    })
  }
  loops.sort((left, right) => right.iterations.length - left.iterations.length || left.loopId.localeCompare(right.loopId))
  return { loops, iterationSpans }
}

/**
 * The steering chain: which graded span caused which subsequent unit of work.
 *
 * A link is recorded on the EFFECT and points at the CAUSE, so the edge is read
 * backwards from the span that carries it. A link whose target is absent from
 * the export is kept and marked unresolved — dropping it would report a shorter
 * chain than the producer recorded, which is the opposite of the truth.
 */
export function analyzeSteeringChain(spans: readonly OtlpSpan[]): SteeringChainReport {
  const byId = new Map<string, OtlpSpan>()
  for (const span of spans) if (!byId.has(span.span_id)) byId.set(span.span_id, span)

  const edges: SteeringEdge[] = []
  const byKind: Record<string, number> = {}
  let links = 0
  let dangling = 0

  for (const span of spans) {
    for (const link of span.links ?? []) {
      links += 1
      const kindValue = link.attributes?.[LINK_KIND_ATTR]
      const linkKind = typeof kindValue === 'string' && kindValue.length > 0 ? kindValue : 'unspecified'
      byKind[linkKind] = (byKind[linkKind] ?? 0) + 1
      const cause = byId.get(link.span_id)
      if (cause === undefined) dangling += 1
      edges.push({
        causeSpanId: link.span_id,
        causeName: cause?.name ?? null,
        causeOutcome: cause ? outcomeOf(cause) : null,
        causeScore: cause ? scoreOf(cause) : null,
        effectSpanId: span.span_id,
        effectName: span.name,
        effectIteration: iterationOf(span),
        linkKind,
        resolved: cause !== undefined,
      })
    }
  }

  edges.sort(
    (left, right) =>
      (left.effectIteration ?? Number.MAX_SAFE_INTEGER) - (right.effectIteration ?? Number.MAX_SAFE_INTEGER) ||
      left.effectSpanId.localeCompare(right.effectSpanId),
  )
  return { edges, links, dangling, byKind }
}
