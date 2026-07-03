import type { AnalystRunResult } from '@tangle-network/agent-eval/analyst'
import { describe, expect, it } from 'vitest'
import type { PipelineReport } from '../src/pipelines.js'
import type { ReactionReport } from '../src/reactions.js'
import { renderReport, summarizeDeterministicSignals } from '../src/report.js'

function emptyResult(): AnalystRunResult {
  return {
    run_id: 'run-report-test',
    correlation_id: 'corr-report-test',
    started_at: '2026-07-03T00:00:00.000Z',
    ended_at: '2026-07-03T00:00:01.000Z',
    findings: [],
    per_analyst: [
      { analyst_id: 'efficiency-behavioral', status: 'ok', findings_count: 0, latency_ms: 347, cost_usd: 0 },
    ],
    total_cost_usd: 0,
  }
}

describe('renderReport', () => {
  it('does not claim a clean run when deterministic checks found issues', () => {
    const report = renderReport(emptyResult(), {
      harness: 'claude-code',
      sessionCount: 5,
      spanCount: 17470,
      otlpPath: '/tmp/spans.openinference.jsonl',
      deterministic: {
        stuckLoops: 12,
        reactionSignals: 61,
        toolErrorRuns: 4,
        totalSignals: 77,
      },
    })

    expect(report).toContain('5 session(s), 17470 spans')
    expect(report).toContain('**0 analyst findings + 77 deterministic signals**')
    expect(report).toContain(
      '_No analyst findings. Deterministic checks found 12 stuck loop(s), 61 human reaction signal(s) and 4 tool-error run(s); see sections below._',
    )
    expect(report).not.toContain('No findings')
  })

  it('keeps the clean-run message when no analyst findings or deterministic signals exist', () => {
    const report = renderReport(emptyResult(), {
      harness: 'codex',
      sessionCount: 1,
      spanCount: 10,
      otlpPath: '/tmp/spans.openinference.jsonl',
      deterministic: {
        stuckLoops: 0,
        reactionSignals: 0,
        toolErrorRuns: 0,
        totalSignals: 0,
      },
    })

    expect(report).toContain('1 session(s), 10 spans')
    expect(report).toContain('**0 findings**')
    expect(report).toContain('no behavioral inefficiencies or failure modes detected')
  })
})

describe('summarizeDeterministicSignals', () => {
  it('summarizes deterministic loop, reaction, and tool-error signals for the report headline', () => {
    const pipelines = {
      stuckLoops: { findings: [{ toolName: 'Read' }, { toolName: 'ToolSearch' }] },
      toolUse: [{ errorRate: 0.1 }, { errorRate: 0 }, { errorRate: 0.2 }],
    } as PipelineReport
    const reactions = {
      signals: { correction: 3, frustration: 2, jargon: 1, structure: 0, praise: 1 },
    } as ReactionReport

    expect(summarizeDeterministicSignals(pipelines, reactions)).toEqual({
      stuckLoops: 2,
      reactionSignals: 7,
      toolErrorRuns: 2,
      totalSignals: 11,
    })
  })
})
