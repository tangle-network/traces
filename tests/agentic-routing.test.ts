import { describe, expect, it } from 'vitest'
import { planTraceAgenticRoute, traceAgenticKinds } from '../src/agentic-routing.js'
import type { PipelineReport } from '../src/pipelines.js'
import type { ReactionReport } from '../src/reactions.js'

function pipelines(opts: { failures?: number; loops?: number } = {}): PipelineReport {
  return {
    failureClusters: {
      totalFailures: opts.failures ?? 0,
      totalRuns: 1,
      clusters: [],
    },
    stuckLoops: {
      findings: Array.from({ length: opts.loops ?? 0 }, (_, index) => ({
        toolName: `tool-${index}`,
        occurrences: 3,
      })),
    },
    toolUse: [],
  } as unknown as PipelineReport
}

function reactions(corrective = 0): ReactionReport {
  return {
    sessions: [],
    humanReactionTurns: corrective,
    signals: {
      correction: corrective,
      frustration: 0,
      jargon: 0,
      structure: 0,
      praise: 0,
    },
    correctiveToPositiveRatio: null,
    triggerPairs: [],
  }
}

describe('planTraceAgenticRoute', () => {
  it('keeps an explicit LLM request to one bounded baseline analyst when local signals are clean', () => {
    const route = planTraceAgenticRoute(pipelines(), reactions())

    expect(route.analystIds).toEqual(['failure-mode'])
    expect(route.reasons.map((reason) => reason.code)).toEqual(['requested-baseline'])
    expect(traceAgenticKinds(route).map((kind) => kind.id)).toEqual(['failure-mode'])
  })

  it('adds the edit designer only when failures or loops justify a proposed change', () => {
    const route = planTraceAgenticRoute(pipelines({ failures: 2, loops: 1 }), reactions())

    expect(route.analystIds).toEqual(['failure-mode', 'improvement'])
    expect(route.reasons.map((reason) => reason.code)).toEqual([
      'requested-baseline',
      'execution-failures',
      'repeated-tool-loops',
    ])
  })

  it('adds knowledge lenses only after corrective human feedback', () => {
    const route = planTraceAgenticRoute(pipelines(), reactions(2))

    expect(route.analystIds).toEqual([
      'failure-mode',
      'knowledge-gap',
      'knowledge-poisoning',
      'improvement',
    ])
    expect(route.reasons.at(-1)?.code).toBe('corrective-human-feedback')
  })
})
