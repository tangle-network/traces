import { describe, expect, it } from 'vitest'
import { summarizeOtlpExecution, summarizeSpanExecution } from '../src/execution.js'
import { serializeSpans, span } from '../src/otlp.js'
import { renderExecution } from '../src/report.js'

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
  it('matches the JSONL path without serializing parsed spans inside the adapter', () => {
    expect(summarizeSpanExecution(measuredSpans())).toEqual(
      summarizeOtlpExecution(serializeSpans(measuredSpans())),
    )
  })

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
    expect(report.execution.failures).toEqual({
      runs: 1,
      fraction: 1,
      reportedErrorEvents: 1,
      reportingRuns: 1,
    })
    expect(report.costProvenance).toEqual({
      observed: { n: 1, totalUsd: 0.02 },
      estimated: { n: 0, totalUsd: 0 },
      uncaptured: { n: 0 },
      knownFraction: 1,
    })
  })

  it('renders complete measured facts without inventing task quality', () => {
    const markdown = renderExecution(measuredExecution())

    expect(markdown).toContain('**Runs:** 1')
    expect(markdown).toContain('**Failed runs:** 1/1 (100.00%)')
    expect(markdown).toContain('**Task quality:** not measured')
    expect(markdown).toContain('| Input | 100 | 1 |')
    expect(markdown).toContain('| Reasoning (output subset) | 5 | 1 |')
    expect(markdown).toContain('| Cache read | 50 | 1 |')
    expect(markdown).toContain('| Observed | 1 | $0.020000 |')
    expect(markdown).toContain('### Orchestration-reported usage')
    expect(markdown).toContain('| Input | 1,000 | 1 |')
    expect(markdown).toContain('Aggregate cost: $0.300000')
  })
})
