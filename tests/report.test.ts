import { createHash } from 'node:crypto'
import type { AnalystRunResult } from '@tangle-network/agent-eval/analyst'
import { describe, expect, it } from 'vitest'
import type { PipelineReport } from '../src/pipelines.js'
import type { ReactionReport } from '../src/reactions.js'
import { renderPipelines, renderReport, summarizeDeterministicSignals } from '../src/report.js'

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
      '_No analyst findings. Deterministic checks found 12 full-session repeated-call group(s), 61 human reaction signal(s) and 4 tool-error run(s); see sections below._',
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

  it('shows the exact selected child session and its operator provenance', () => {
    const report = renderReport(emptyResult(), {
      harness: 'codex',
      sessionCount: 1,
      spanCount: 817,
      otlpPath: '/tmp/spans.openinference.jsonl',
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
})

describe('renderPipelines', () => {
  it('labels retries as a fraction of failed calls and prints raw counts', () => {
    const report = renderPipelines({
      stuckLoops: { findings: [], affectedRunRatio: 0, totalRuns: 1 },
      toolUse: [{
        runId: 'run-report-test',
        totalCalls: 358,
        byTool: { bash: { calls: 358, errors: 53, duplicates: 36, avgLatencyMs: 5 } },
        duplicateRate: 36 / 358,
        errorRate: 53 / 358,
        retryRate: 52 / 53,
      }],
    })

    expect(report).toContain('36/358 repeated exactly')
    expect(report).toContain('53/358 failed')
    expect(report).toContain('52/53 failed calls followed by another same-tool call (98%)')
    expect(report).not.toContain('98% retry')
    expect(report).not.toContain('failed calls retried')
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
