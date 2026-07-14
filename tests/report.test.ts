import { createHash } from 'node:crypto'
import type { AnalystRunResult } from '@tangle-network/agent-eval/analyst'
import { summarizeExecution } from '@tangle-network/agent-eval/contract'
import { describe, expect, it } from 'vitest'
import type { PipelineReport } from '../src/pipelines.js'
import type { ReactionReport } from '../src/reactions.js'
import { renderPipelines, renderReport, summarizeDeterministicSignals } from '../src/report.js'

const EMPTY_EXECUTION = summarizeExecution({ runs: [] })

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
      execution: EMPTY_EXECUTION,
      deterministic: {
        stuckLoops: 12,
        reactionSignals: 61,
        failedRuns: 4,
        totalSignals: 77,
      },
    })

    expect(report).toContain('5 session(s), 17470 spans')
    expect(report).toContain('**0 findings; 77 raw deterministic signals**')
    expect(report).toContain(
      '_No analyst findings. Deterministic checks found 12 stuck loop(s), 61 human reaction signal(s) and 4 failed run(s); see sections below._',
    )
    expect(report).not.toContain('No findings')
  })

  it('keeps the clean-run message when no analyst findings or deterministic signals exist', () => {
    const report = renderReport(emptyResult(), {
      harness: 'codex',
      sessionCount: 1,
      spanCount: 10,
      otlpPath: '/tmp/spans.openinference.jsonl',
      execution: EMPTY_EXECUTION,
      deterministic: {
        stuckLoops: 0,
        reactionSignals: 0,
        failedRuns: 0,
        totalSignals: 0,
      },
    })

    expect(report).toContain('1 session(s), 10 spans')
    expect(report).toContain('**0 findings**')
    expect(report).toContain('No supported behavioral findings in the captured fields.')
  })

  it('shows the exact selected child session and its operator provenance', () => {
    const report = renderReport(emptyResult(), {
      harness: 'codex',
      sessionCount: 1,
      spanCount: 817,
      otlpPath: '/tmp/spans.openinference.jsonl',
      execution: EMPTY_EXECUTION,
      sources: [{
        sessionId: '019f5aea-d6b4-7451-a3eb-60289875a357',
        parentSessionId: '019f24d6-b5ec-7173-acc1-f957de216ee5',
        role: 'child',
        integrity: 'complete',
        path: '/home/drew/.codex/sessions/2026/07/13/rollout-child.jsonl',
        subject: 'Own direct-streaming conversion for the remaining JSONL adapters.',
      }],
    })

    expect(report).toContain('## Selected sessions')
    expect(report).toContain('019f5aea-d6b4-7451-a3eb-60289875a357')
    expect(report).toContain('019f24d6-b5ec-7173-acc1-f957de216ee5')
    expect(report).toContain('Own direct-streaming conversion')
    expect(report).toContain('/home/drew/.codex/sessions/2026/07/13/rollout-child.jsonl')
    expect(report).toContain('| child |')
    expect(report).toContain('Counts below describe only the selected files, not their parent operator sessions.')
  })

  it('shows degraded source provenance without exposing malformed content', () => {
    const rawSecret = 'secret-malformed-record'
    const sha256 = createHash('sha256').update(rawSecret).digest('hex')
    const sourcePath = '/home/drew/.codex/sessions/operator.jsonl'
    const report = renderReport(emptyResult(), {
      harness: 'codex',
      sessionCount: 1,
      spanCount: 76_400,
      otlpPath: '/tmp/operator.openinference.jsonl',
      execution: EMPTY_EXECUTION,
      sources: [{
        sessionId: '019f24d6-b5ec-7173-acc1-f957de216ee5',
        role: 'operator',
        integrity: 'degraded_not_lossless',
        corruptionCount: 130,
        corruptionDigest: `sha256:${'1'.repeat(64)}`,
        path: sourcePath,
        subject: 'Operator task',
        corruptions: [{
          receiptVersion: 1,
          kind: 'jsonl_corruption',
          status: 'degraded_not_lossless',
          harness: 'codex',
          sessionId: '019f24d6-b5ec-7173-acc1-f957de216ee5',
          sourcePath,
          lineNumber: 8558,
          byteOffset: 22_424_907,
          byteLength: Buffer.byteLength(rawSecret),
          sha256,
          rawBytes: 'local_source_only',
        }],
      }],
    })

    expect(report).toContain('degraded, not lossless (130 corrupt records)')
    expect(report).toContain('## Source corruption receipts')
    expect(report).toContain(`130 receipts, digest \`sha256:${'1'.repeat(64)}\``)
    expect(report).toContain('| 8558 | 22424907 |')
    expect(report).toContain('129 additional receipts omitted from this report')
    expect(report).toContain('all receipts remain in `source.corruption.receipt` child spans')
    expect(report).toContain(sha256)
    expect(report).toContain('exact bytes are retrievable only while the local source file still contains that byte range')
    expect(report).not.toContain(rawSecret)
  })

  it('bounds selected-session evidence without dropping the total', () => {
    const report = renderReport(emptyResult(), {
      harness: 'openinference',
      sessionCount: 25,
      spanCount: 25,
      otlpPath: '/tmp/spans.openinference.jsonl',
      execution: EMPTY_EXECUTION,
      sources: Array.from({ length: 25 }, (_, index) => ({
        sessionId: `session-${index}`,
        role: 'unknown' as const,
        integrity: 'complete' as const,
        path: '/tmp/spans.jsonl',
        subject: '',
      })),
    })

    expect(report).toContain('25 session(s), 25 spans')
    expect(report).toContain('5 additional sessions omitted')
    expect(report).toContain('session-19')
    expect(report).not.toContain('session-20')
  })

  it('keeps traces without session identity out of the session count', () => {
    const report = renderReport(emptyResult(), {
      harness: 'openinference',
      sessionCount: 2,
      unassignedTraceCount: 13,
      spanCount: 2880,
      otlpPath: '/tmp/spans.jsonl',
      execution: EMPTY_EXECUTION,
    })

    expect(report).toContain(
      '2 identified session(s) + 13 traces without a single stable session identity, 2880 spans',
    )
    expect(report).toContain('Their spans were analyzed but were not relabeled as sessions.')
  })
})

describe('renderPipelines', () => {
  it('labels retries as a fraction of failed calls and prints raw counts', () => {
    const report = renderPipelines({
      stuckLoops: { findings: [], affectedRunRatio: 0, totalRuns: 1 },
      failureClusters: { clusters: [], totalFailures: 0, totalRuns: 1 },
      toolUse: [{
        runId: 'run-report-test',
        totalCalls: 358,
        callsWithCapturedArgs: 300,
        byTool: {
          bash: {
            calls: 358,
            callsWithCapturedArgs: 300,
            errors: 53,
            duplicates: 36,
            avgLatencyMs: 5,
          },
        },
        duplicateRate: 36 / 358,
        errorRate: 53 / 358,
        retryRate: 52 / 53,
      }],
    })

    expect(report).toContain('300/358 arguments captured')
    expect(report).toContain('36/300 captured calls repeated exactly')
    expect(report).toContain('53/358 failed')
    expect(report).toContain('52/53 failed calls followed by another same-tool call (98%)')
    expect(report).toContain('| `bash` | 358 | 300/358 | 36/300 | 53/358 | 5.0ms |')
    expect(report).not.toContain('98% retry')
    expect(report).not.toContain('failed calls retried')
  })

  it('aggregates tool metrics instead of printing one line per trace', () => {
    const report = renderPipelines({
      stuckLoops: { findings: [], affectedRunRatio: 0, totalRuns: 3 },
      failureClusters: { clusters: [], totalFailures: 0, totalRuns: 3 },
      toolUse: [
        {
          runId: 'a',
          totalCalls: 10,
          callsWithCapturedArgs: 8,
          byTool: {
            bash: {
              calls: 10,
              callsWithCapturedArgs: 8,
              errors: 2,
              duplicates: 3,
              avgLatencyMs: 5,
            },
          },
          duplicateRate: 0.3,
          errorRate: 0.2,
          retryRate: 0.5,
        },
        {
          runId: 'b',
          totalCalls: 5,
          callsWithCapturedArgs: 5,
          byTool: {
            read: {
              calls: 5,
              callsWithCapturedArgs: 5,
              errors: 0,
              duplicates: 1,
              avgLatencyMs: 2,
            },
          },
          duplicateRate: 0.2,
          errorRate: 0,
          retryRate: 0,
        },
        {
          runId: 'c',
          totalCalls: 0,
          callsWithCapturedArgs: 0,
          byTool: {},
          duplicateRate: 0,
          errorRate: 0,
          retryRate: 0,
        },
      ],
    })

    expect(report).toContain('15 calls across 2/3 traces')
    expect(report).toContain('13/15 arguments captured')
    expect(report).toContain('4/13 captured calls repeated exactly')
    expect(report).toContain('2/15 failed; 1/2 failed calls followed by another same-tool call (50%)')
    expect(report).toContain('| `bash` | 10 | 8/10 | 3/8 | 2/10 | 5.0ms |')
    expect(report).toContain('| `read` | 5 | 5/5 | 1/5 | 0/5 | 2.0ms |')
    expect(report.match(/\*\*Tool use:\*\*/g)).toHaveLength(1)
  })
})

describe('summarizeDeterministicSignals', () => {
  it('summarizes deterministic loop, reaction, and failed-run signals for the report headline', () => {
    const pipelines = {
      stuckLoops: {
        findings: [
          { runId: 'r1', toolName: 'Read', argHash: 'a', occurrences: 3, spanIds: [], windowMs: 10 },
          { runId: 'r2', toolName: 'ToolSearch', argHash: 'b', occurrences: 3, spanIds: [], windowMs: 10 },
        ],
        affectedRunRatio: 2 / 3,
        totalRuns: 3,
      },
      failureClusters: { clusters: [], totalFailures: 2, totalRuns: 3 },
      toolUse: [],
    } satisfies PipelineReport
    const reactions = {
      signals: { correction: 3, frustration: 2, jargon: 1, structure: 0, praise: 1 },
    } as ReactionReport

    expect(summarizeDeterministicSignals(pipelines, reactions)).toEqual({
      stuckLoops: 2,
      reactionSignals: 7,
      failedRuns: 2,
      totalSignals: 11,
    })
  })
})
