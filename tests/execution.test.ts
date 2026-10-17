import { describe, expect, it } from 'vitest'
import { summarizeSpanExecution } from '../src/execution.js'
import { span } from '../src/otlp.js'

function measuredSpans() {
  return [
    span({
      traceId: 'run-1',
      spanId: 'root',
      name: 'session',
      kind: 'AGENT',
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:01.000Z',
      inputTokens: 1_000,
      outputTokens: 500,
      costUsd: 0.3,
    }),
    span({
      traceId: 'run-1',
      spanId: 'llm',
      parentSpanId: 'root',
      name: 'llm.turn',
      kind: 'LLM',
      startTime: '2026-01-01T00:00:00.100Z',
      endTime: '2026-01-01T00:00:00.500Z',
      model: 'gpt-test',
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cachedInputTokens: 50,
      cacheWriteInputTokens: 10,
      costUsd: 0.02,
    }),
    span({
      traceId: 'run-1',
      spanId: 'tool',
      parentSpanId: 'llm',
      name: 'tool.bash',
      kind: 'TOOL',
      startTime: '2026-01-01T00:00:00.500Z',
      endTime: '2026-01-01T00:00:00.600Z',
      tool: 'bash',
      status: 'ERROR',
      statusMessage: 'failed',
    }),
  ]
}

function measuredExecution() {
  return summarizeSpanExecution(measuredSpans())
}

describe('execution accounting', () => {
  it('keeps direct model usage separate from overlapping orchestration totals', () => {
    const report = measuredExecution()

    expect(report.execution.durationMs).toMatchObject({ n: 1, p50: 1_000, p95: 1_000 })
    expect(report.execution.tokenUsage.totals).toEqual({
      input: 100,
      output: 20,
      reasoning: 5,
      cached: 50,
      cacheWrite: 10,
    })
    expect(report.execution.aggregateUsage.tokenUsage.totals).toEqual({
      input: 1_000,
      output: 500,
      reasoning: 0,
      cached: 0,
      cacheWrite: 0,
    })
    expect(report.execution.modelCalls).toEqual({ runs: 1, events: 1, reportingRuns: 1 })
    expect(report.execution.executionErrors).toMatchObject({
      runs: 1,
      fraction: 1,
      events: 1,
      reportingRuns: 1,
      errorSpanEvents: 1,
      errorSpanReportingRuns: 1,
    })
    expect(report.costProvenance).toEqual({
      observed: { n: 1, totalUsd: 0.02 },
      estimated: { n: 0, totalUsd: 0 },
      uncaptured: { n: 0 },
      knownFraction: 1,
      lowerBound: { n: 0, floorUsd: 0 },
    })
  })
})
