import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PolicyEvidenceRecord } from '../src/evidence.js'
import {
  exportTraceEvidenceRows,
  writeTraceEvidenceExportFile,
} from '../src/file-export.js'
import { serializeSpans } from '../src/otlp.js'

function parseRows(jsonl: string): Record<string, unknown>[] {
  return jsonl.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

function expectOpenInferenceRow(row: Record<string, unknown>): void {
  expect(row.trace_id).toEqual(expect.any(String))
  expect(row.span_id).toEqual(expect.any(String))
  expect(row.name).toEqual(expect.any(String))
  expect(row.start_time).toEqual(expect.any(String))
  expect(row.end_time).toEqual(expect.any(String))
  expect(row.status).toEqual(expect.objectContaining({ code: expect.any(String) }))
  expect(row.resource).toEqual(expect.objectContaining({ attributes: expect.any(Object) }))
  expect(row.scope).toEqual(expect.objectContaining({ name: expect.any(String) }))
  expect(row.attributes).toEqual(expect.any(Object))
}

const policyRecord: PolicyEvidenceRecord = {
  schemaVersion: 1,
  kind: 'traces.policy_evidence.session',
  generatedAt: '2026-06-27T12:00:00.000Z',
  session: {
    harness: 'codex',
    sessionId: 'sess-r115',
    path: '/runs/2026-06-27/session.jsonl',
    cwd: '/work/agent-lab',
    mtimeMs: Date.parse('2026-06-27T12:00:00.000Z'),
  },
  repo: {
    subjectKey: 'github.com/tangle-network/agent-lab',
    repository: 'github.com/tangle-network/agent-lab',
    branch: 'runs/r115',
    commit: 'abc123',
    cwd: '/work/agent-lab',
  },
  metrics: {
    spanCount: 9,
    llmTurnCount: 2,
    toolCallCount: 3,
    erroredToolCallCount: 1,
    inputTokens: 1200,
    outputTokens: 300,
    models: ['gpt-5.4-mini'],
    tools: [{ name: 'bash', calls: 3, errors: 1 }],
    firstSpanAt: '2026-06-27T11:59:00.000Z',
    lastSpanAt: '2026-06-27T12:00:30.000Z',
  },
  signals: {
    stuckLoopCount: 1,
    affectedRunRatio: 1,
    stuckLoops: [{ toolName: 'bash', occurrences: 3 }],
    stuckLoopsOmitted: 0,
    toolErrorRate: 1 / 3,
  },
  provenance: {
    source: 'traces',
    evidenceKind: 'session-summary',
    otlpPath: '/runs/2026-06-27/spans.jsonl',
    notCampaignCell: true,
    note: 'compact evidence row',
  },
}

describe('trace evidence export', () => {
  it('converts compact policy evidence rows to HALO-readable OpenInference JSONL', () => {
    const result = exportTraceEvidenceRows([policyRecord])
    expect(result.format).toBe('policy-evidence')
    expect(result.spans).toHaveLength(1)

    const [row] = parseRows(serializeSpans(result.spans))
    expectOpenInferenceRow(row!)
    expect(row!.kind).toBe('AGENT')
    expect(row!.name).toBe('policy_evidence.session')
    expect(row!.resource).toEqual(expect.objectContaining({
      attributes: expect.objectContaining({
        'service.name': 'codex',
        'tangle.subject.key': 'github.com/tangle-network/agent-lab',
      }),
    }))
    expect(row!.attributes).toEqual(expect.objectContaining({
      'traces.source_format': 'policy-evidence',
      'traces.metrics.tool_call_count': 3,
      'traces.signals.stuck_loop_count': 1,
    }))
  })

  it('converts Sandbox/OpenCode event arrays to HALO-readable OpenInference JSONL with redaction', () => {
    const events = [
      { type: 'start', timestamp: '2026-06-27T12:00:00.000Z', sessionId: 'sandbox-r115' },
      {
        type: 'raw',
        timestamp: '2026-06-27T12:00:01.000Z',
        data: {
          type: 'tool-invocation',
          toolName: 'bash',
          input: 'curl -H "Authorization: Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyzAB" https://example.com',
        },
      },
      { type: 'result', timestamp: '2026-06-27T12:00:02.000Z', data: { ok: true } },
      { type: 'done', timestamp: '2026-06-27T12:00:03.000Z' },
    ]
    const result = exportTraceEvidenceRows(events)
    expect(result.format).toBe('sandbox-events')
    expect(result.redactionCount).toBeGreaterThanOrEqual(1)

    const output = serializeSpans(result.spans)
    expect(output).not.toContain('ghp_0123456789')
    const rows = parseRows(output)
    expect(rows).toHaveLength(5)
    rows.forEach(expectOpenInferenceRow)
    expect(rows[0]!.name).toBe('sandbox.events')
    expect(rows.some((row) => row.name === 'tool.bash')).toBe(true)
  })

  it('writes an exported file from JSONL input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-export-test-'))
    const input = join(dir, 'policy.jsonl')
    const output = join(dir, 'spans.jsonl')
    await writeFile(input, `${JSON.stringify(policyRecord)}\n`, 'utf8')

    const result = await writeTraceEvidenceExportFile(input, output)
    expect(result.path).toBe(output)
    expect(result.format).toBe('policy-evidence')
    const [row] = parseRows(await readFile(output, 'utf8'))
    expectOpenInferenceRow(row!)
  })
})
