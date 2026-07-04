import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PolicyEvidenceRecord } from '../src/evidence.js'
import {
  exportTraceEvidenceRows,
  exportTraceEvidenceText,
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
      { type: 'start', data: { created_at: Date.parse('2026-06-27T12:00:00.000Z') / 1000, sessionId: 'sandbox-r115' } },
      {
        type: 'raw',
        data: {
          timestamp: Date.parse('2026-06-27T12:00:01.000Z'),
          type: 'tool-invocation',
          toolName: 'bash',
          input: 'curl -H "Authorization: Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyzAB" https://example.com',
        },
      },
      { type: 'result', data: { ok: true, time: { updated: Date.parse('2026-06-27T12:00:02.000Z') } } },
      { type: 'done', data: { timestamp: '2026-06-27T12:00:03.000Z' } },
    ]
    const result = exportTraceEvidenceRows(events, {
      attributes: {
        'research.task_id': 'aec-001',
        'research.score': 1,
        'research.tags': ['aec', 'smoke'],
        'research.config': { arm: 'command-contract' },
      },
    })
    expect(result.format).toBe('sandbox-events')
    expect(result.redactionCount).toBeGreaterThanOrEqual(1)

    const output = serializeSpans(result.spans)
    expect(output).not.toContain('ghp_0123456789')
    const rows = parseRows(output)
    expect(rows).toHaveLength(5)
    rows.forEach(expectOpenInferenceRow)
    expect(rows[0]!.name).toBe('sandbox.events')
    expect(rows[0]!.start_time).toBe('2026-06-27T12:00:00.000Z')
    expect(rows[0]!.end_time).toBe('2026-06-27T12:00:03.000Z')
    expect(rows.some((row) => row.name === 'tool.bash')).toBe(true)
    for (const row of rows) {
      expect(row.attributes).toEqual(expect.objectContaining({
        'research.task_id': 'aec-001',
        'research.score': 1,
        'research.tags': ['aec', 'smoke'],
        'research.config': '{"arm":"command-contract"}',
      }))
    }
  })

  it('writes an exported file from JSONL input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-export-test-'))
    const input = join(dir, 'policy.jsonl')
    const output = join(dir, 'spans.jsonl')
    await writeFile(input, `${JSON.stringify(policyRecord)}\n`, 'utf8')

    const result = await writeTraceEvidenceExportFile(input, output, {
      attributes: { 'campaign.id': 'r116' },
    })
    expect(result.path).toBe(output)
    expect(result.format).toBe('policy-evidence')
    const [row] = parseRows(await readFile(output, 'utf8'))
    expectOpenInferenceRow(row!)
    expect(row!.attributes).toEqual(expect.objectContaining({ 'campaign.id': 'r116' }))
  })

  it('reads multi-row JSONL that starts with an object row', async () => {
    const second = {
      ...policyRecord,
      session: { ...policyRecord.session, sessionId: 'sess-r116' },
    }
    const result = exportTraceEvidenceText(`${JSON.stringify(policyRecord)}\n${JSON.stringify(second)}\n`)
    expect(result.format).toBe('policy-evidence')
    expect(result.spans).toHaveLength(2)
  })

  it('converts Tangle Intelligence span rows to OpenInference JSONL', () => {
    const rows = [
      {
        id: 'trace_uri:root',
        tenant_id: 'tenant_uri',
        trace_id: 'trace_uri',
        parent_span_id: null,
        name: 'claude_code.interaction',
        start_unix_nano: '1782427464458000000',
        end_unix_nano: '1782427477304556542',
        attributes: {
          'span.type': 'interaction',
          'service.name': 'claude-code',
          'session.id': 'session_uri',
          user_prompt: 'Use skill add-validation-rule and the mcp__linear__linear_graphql tool.',
          'symphony.issue.identifier': 'EO-50',
          'git.repository': 'lightblocks/symphony',
          'interaction.sequence': 16,
        },
        status_code: 'UNSET',
        status_message: null,
        redaction_version: '1.0.0+tangle.3',
        model: null,
        input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        run_id: null,
        scenario_id: null,
        generation: null,
        cell_id: null,
        session_id: 'session_uri',
        thread_id: null,
        received_at: '2026-06-25 22:44:52.146637',
      },
      {
        id: 'trace_uri:llm',
        tenant_id: 'tenant_uri',
        trace_id: 'trace_uri',
        parent_span_id: 'trace_uri:root',
        name: 'claude_code.llm_request',
        start_unix_nano: '1782427464470000000',
        end_unix_nano: '1782427477299858292',
        attributes: {
          'span.type': 'llm_request',
          'service.name': 'claude-code',
          model: 'claude-opus-4-8',
          input_tokens: 25,
          output_tokens: 739,
          'symphony.issue.identifier': 'EO-50',
        },
        status_code: 'UNSET',
        status_message: null,
        redaction_version: '1.0.0+tangle.3',
        model: 'claude-opus-4-8',
        input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        run_id: null,
        scenario_id: null,
        generation: null,
        cell_id: null,
        session_id: 'session_uri',
        thread_id: null,
        received_at: '2026-06-25 22:44:52.146637',
      },
    ]

    const result = exportTraceEvidenceRows(rows)
    expect(result.format).toBe('intelligence-spans')
    expect(result.spans).toHaveLength(2)

    const outputRows = parseRows(serializeSpans(result.spans))
    outputRows.forEach(expectOpenInferenceRow)
    expect(outputRows[0]!.kind).toBe('AGENT')
    expect(outputRows[0]!.resource).toEqual(expect.objectContaining({
      attributes: expect.objectContaining({
        'service.name': 'claude-code',
        'git.repository': 'lightblocks/symphony',
      }),
    }))
    expect(outputRows[0]!.attributes).toEqual(expect.objectContaining({
      'traces.source_format': 'intelligence-spans',
      'tangle.sessionId': 'session_uri',
      'symphony.issue.identifier': 'EO-50',
      content: expect.stringContaining('add-validation-rule'),
    }))
    expect(outputRows[1]!.kind).toBe('LLM')
    expect(outputRows[1]!.attributes).toEqual(expect.objectContaining({
      'llm.model_name': 'claude-opus-4-8',
      'llm.input_tokens': 25,
      'llm.output_tokens': 739,
    }))
  })
})
