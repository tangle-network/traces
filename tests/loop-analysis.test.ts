import { describe, expect, it } from 'vitest'
import { ATTR, deriveHexId } from '@tangle-network/agent-trace-contract'
import { analyzeLoopConvergence, analyzeSteeringChain } from '../src/loop-analysis.js'
import type { OtlpSpan } from '../src/otlp.js'

const TRACE = deriveHexId('loop-analysis', 16)

function span(init: {
  id: string
  parent?: string | null
  name?: string
  attributes?: Record<string, unknown>
  links?: OtlpSpan['links']
  start?: string
  end?: string
}): OtlpSpan {
  return {
    trace_id: TRACE,
    span_id: deriveHexId(init.id, 8),
    parent_span_id: init.parent === undefined ? null : init.parent === null ? null : deriveHexId(init.parent, 8),
    name: init.name ?? init.id,
    start_time: init.start ?? '2026-01-01T00:00:00.000Z',
    end_time: init.end ?? '2026-01-01T00:00:01.000Z',
    status: { code: 'OK' },
    attributes: { [ATTR.spanKind]: 'CHAIN', ...init.attributes },
    ...(init.links ? { links: init.links } : {}),
  }
}

/** N rounds under one loop, each graded by an EVALUATOR child. */
function loop(scores: readonly (number | null)[], outcomes?: readonly string[]): OtlpSpan[] {
  const spans: OtlpSpan[] = []
  scores.forEach((score, index) => {
    spans.push(span({
      id: `round-${index}`,
      name: `round ${index + 1}`,
      attributes: { [ATTR.loopId]: 'loop-a', [ATTR.iteration]: index + 1 },
    }))
    const verdict: Record<string, unknown> = { [ATTR.spanKind]: 'EVALUATOR' }
    if (score !== null) verdict[ATTR.score] = score
    if (outcomes?.[index]) verdict[ATTR.outcome] = outcomes[index]
    if (score !== null || outcomes?.[index]) {
      spans.push(span({ id: `verdict-${index}`, parent: `round-${index}`, name: 'verification', attributes: verdict }))
    }
  })
  return spans
}

describe('analyzeLoopConvergence', () => {
  it('reads the verdict from the round\'s evaluator child and calls a rising score improved', () => {
    const report = analyzeLoopConvergence(loop([0.2, 0.5, 0.9], ['fail', 'fail', 'pass']))

    expect(report.iterationSpans).toBe(3)
    expect(report.loops).toHaveLength(1)
    const [only] = report.loops
    expect(only!.loopId).toBe('loop-a')
    expect(only!.trend).toBe('improved')
    expect(only!.basis).toBe('score')
    expect(only!.detail).toContain('score 0.2 → 0.9 across 3 graded round(s)')
    expect(only!.iterations.map((round) => [round.iteration, round.outcome, round.score])).toEqual([
      [1, 'fail', 0.2],
      [2, 'fail', 0.5],
      [3, 'pass', 0.9],
    ])
    expect(only!.iterations[0]!.verdictSpanId).toBe(deriveHexId('verdict-0', 8))
  })

  it('calls an unchanged score plateaued and a falling one regressed', () => {
    expect(analyzeLoopConvergence(loop([0.5, 0.5, 0.5])).loops[0]!.trend).toBe('plateaued')
    expect(analyzeLoopConvergence(loop([0.9, 0.4])).loops[0]!.trend).toBe('regressed')
  })

  it('separates "never moved" from "peaked then fell back"', () => {
    const mixed = analyzeLoopConvergence(loop([0.4, 0.9, 0.4])).loops[0]!
    expect(mixed.trend).toBe('mixed')
    expect(mixed.detail).toContain('best 0.9 at round 2')
  })

  it('falls back to the pass/fail series when no round carries a score', () => {
    const report = analyzeLoopConvergence(loop([null, null], ['fail', 'pass'])).loops[0]!
    expect(report.basis).toBe('outcome')
    expect(report.trend).toBe('improved')
    expect(report.detail).toContain('outcome fail → pass')
  })

  it('reports unscored rather than inventing a flat trend when nothing graded the rounds', () => {
    const report = analyzeLoopConvergence(loop([null, null])).loops[0]!
    expect(report.trend).toBe('unscored')
    expect(report.basis).toBe('none')
    expect(report.detail).toContain('neither agent.outcome nor agent.outcome.score')
  })

  it('orders rounds by iteration, not by the time a resumed round was written', () => {
    const spans = [
      span({ id: 'r2', attributes: { [ATTR.loopId]: 'l', [ATTR.iteration]: 2 }, start: '2026-01-01T00:00:00.000Z' }),
      span({ id: 'r1', attributes: { [ATTR.loopId]: 'l', [ATTR.iteration]: 1 }, start: '2026-01-01T09:00:00.000Z' }),
    ]
    expect(analyzeLoopConvergence(spans).loops[0]!.iterations.map((round) => round.iteration)).toEqual([1, 2])
  })

  it('says so plainly when the trace records no rounds at all', () => {
    const report = analyzeLoopConvergence([span({ id: 'lonely' })])
    expect(report.loops).toEqual([])
    expect(report.iterationSpans).toBe(0)
  })

  it('does not read a nested loop\'s grade as the outer round\'s', () => {
    const spans = [
      span({ id: 'outer', attributes: { [ATTR.loopId]: 'outer', [ATTR.iteration]: 1 } }),
      span({ id: 'inner', parent: 'outer', attributes: { [ATTR.loopId]: 'inner', [ATTR.iteration]: 1 } }),
      span({ id: 'inner-verdict', parent: 'inner', attributes: { [ATTR.outcome]: 'pass', [ATTR.score]: 1 } }),
    ]
    const outer = analyzeLoopConvergence(spans).loops.find((entry) => entry.loopId === 'outer')!
    expect(outer.iterations[0]!.outcome).toBeNull()
    expect(outer.iterations[0]!.score).toBeNull()
  })
})

describe('analyzeSteeringChain', () => {
  it('reads the edge backwards from the caused round to the verdict that caused it', () => {
    const spans = [
      ...loop([0.2, 0.8], ['fail', 'pass']),
    ]
    spans[2] = {
      ...spans[2]!,
      links: [{
        trace_id: TRACE,
        span_id: deriveHexId('verdict-0', 8),
        attributes: { 'agent.link.kind': 'steered_by' },
      }],
    }
    const report = analyzeSteeringChain(spans)

    expect(report.links).toBe(1)
    expect(report.dangling).toBe(0)
    expect(report.byKind).toEqual({ steered_by: 1 })
    expect(report.edges[0]).toEqual({
      causeSpanId: deriveHexId('verdict-0', 8),
      causeName: 'verification',
      causeOutcome: 'fail',
      causeScore: 0.2,
      effectSpanId: deriveHexId('round-1', 8),
      effectName: 'round 2',
      effectIteration: 2,
      linkKind: 'steered_by',
      resolved: true,
    })
  })

  it('keeps a link whose target is absent and marks the chain broken there', () => {
    const spans = [span({ id: 'r', links: [{ trace_id: TRACE, span_id: deriveHexId('gone', 8) }] })]
    const report = analyzeSteeringChain(spans)

    expect(report.dangling).toBe(1)
    expect(report.byKind).toEqual({ unspecified: 1 })
    expect(report.edges[0]!.resolved).toBe(false)
    expect(report.edges[0]!.causeName).toBeNull()
  })

  it('reports nothing to follow, rather than an empty success, when no links exist', () => {
    const report = analyzeSteeringChain(loop([0.5]))
    expect(report).toEqual({ edges: [], links: 0, dangling: 0, byKind: {} })
  })
})
