import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  exportTraceEvidenceRows,
  exportTraceEvidenceFile,
  exportTraceEvidenceText,
  writeTraceEvidenceExportFile,
} from '../src/file-export.js'
import { serializeSpans } from '../src/otlp.js'
import { runPipelines } from '../src/pipelines.js'

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

describe('trace evidence export', () => {
  it('keeps a complete OpenInference row as written', () => {
    const complete = {
      trace_id: 'trace-1',
      span_id: 'span-1',
      parent_span_id: '',
      name: 'tool.failed',
      kind: 'CHAIN',
      start_time: '2026-01-01T00:00:00.000Z',
      end_time: '2026-01-01T00:00:01.000Z',
      status: { code: 'ERROR', message: 'failed' },
      resource: { attributes: {} },
      scope: { name: 'test' },
      attributes: { 'openinference.span.kind': 'CHAIN' },
    }

    expect(exportTraceEvidenceRows([complete]).spans[0]?.status).toEqual({
      code: 'ERROR',
      message: 'failed',
    })
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
    const tool = rows.find((row) => row.name === 'tool.bash')
    expect(tool?.attributes).toEqual(expect.objectContaining({
      'tool.args_captured': true,
      'input.value': expect.stringContaining('[REDACTED:'),
    }))
    for (const row of rows) {
      expect(row.attributes).toEqual(expect.objectContaining({
        'tangle.sessionId': 'sandbox-r115',
        'research.task_id': 'aec-001',
        'research.score': 1,
        'research.tags': ['aec', 'smoke'],
        'research.config': '{"arm":"command-contract"}',
      }))
    }
  })

  it('does not invent tool arguments from unrelated nested input fields', () => {
    const result = exportTraceEvidenceRows([{
      type: 'tool-invocation',
      toolName: 'bash',
      data: {
        metadata: { config: { input: 'not tool arguments' } },
      },
    }], { format: 'sandbox-events' })
    const tool = result.spans.find((item) => item.attributes['tool.name'] === 'bash')

    expect(tool?.attributes['tool.args_captured']).toBe(false)
    expect(tool?.attributes['input.value']).toBeUndefined()
  })

  it('keeps explicit event session identity separate from trace identity', () => {
    const session = exportTraceEvidenceText(JSON.stringify({
      session_id: 'session-r116',
      trace_id: 'trace-r116',
      events: [{ type: 'start', timestamp: '2026-06-27T12:00:00.000Z' }],
    }), { format: 'sandbox-events' })
    expect(session.spans.every((item) => item.trace_id === 'trace-r116')).toBe(true)
    expect(session.spans.every((item) => item.attributes['tangle.sessionId'] === 'session-r116')).toBe(true)

    const traceOnly = exportTraceEvidenceText(JSON.stringify({
      trace_id: 'trace-only',
      events: [{ type: 'start', timestamp: '2026-06-27T12:00:00.000Z' }],
    }), { format: 'sandbox-events' })
    expect(traceOnly.spans.every((item) => item.trace_id === 'trace-only')).toBe(true)
    expect(traceOnly.spans.every((item) => item.attributes['tangle.sessionId'] === undefined)).toBe(true)
  })

  it('stamps wrapper environment identity onto every span and lifts it into the OTLP resource', () => {
    const result = exportTraceEvidenceText(JSON.stringify({
      session_id: 'session-env-1',
      image: 'ghcr.io/tangle-network/sandbox:base',
      imageDigest: 'sha256:' + 'c'.repeat(64),
      sandboxId: 'sbx-env-1',
      cwd: '/workspace/repo',
      events: [
        { type: 'start', timestamp: '2026-08-04T00:00:00.000Z' },
        { type: 'tool-invocation', toolName: 'bash', input: 'ls', timestamp: '2026-08-04T00:00:01.000Z' },
      ],
    }), { format: 'sandbox-events' })
    for (const item of result.spans) {
      expect(item.attributes).toEqual(expect.objectContaining({
        'container.image.name': 'ghcr.io/tangle-network/sandbox:base',
        'container.image.digest': 'sha256:' + 'c'.repeat(64),
        'tangle.sandbox.id': 'sbx-env-1',
        'tangle.environment.cwd': '/workspace/repo',
      }))
    }
    const rows = parseRows(serializeSpans(result.spans))
    for (const row of rows) {
      const resource = row.resource as { attributes: Record<string, unknown> }
      expect(resource.attributes).toEqual(expect.objectContaining({
        'container.image.name': 'ghcr.io/tangle-network/sandbox:base',
        'container.image.digest': 'sha256:' + 'c'.repeat(64),
        'tangle.sandbox.id': 'sbx-env-1',
        'tangle.environment.cwd': '/workspace/repo',
      }))
    }
  })

  it('carries LLM event model and token usage onto the span, and never invents zeros', () => {
    const result = exportTraceEvidenceRows([
      {
        type: 'llm.completion',
        data: {
          timestamp: '2026-08-04T00:00:00.000Z',
          model: 'glm-5.2',
          usage: { prompt_tokens: 1200, completion_tokens: 340 },
        },
      },
      { type: 'llm.completion', data: { timestamp: '2026-08-04T00:00:01.000Z' } },
    ], { format: 'sandbox-events' })
    const llmSpans = result.spans.filter((item) => item.attributes['openinference.span.kind'] === 'LLM')
    expect(llmSpans).toHaveLength(2)
    expect(llmSpans[0]!.attributes).toEqual(expect.objectContaining({
      'llm.model_name': 'glm-5.2',
      'llm.token_count.prompt': 1200,
      'llm.token_count.completion': 340,
    }))
    expect(llmSpans[1]!.attributes['llm.token_count.prompt']).toBeUndefined()
    expect(llmSpans[1]!.attributes['llm.token_count.completion']).toBeUndefined()
  })

  it('falls back to the runtime.ready event for environment identity and omits it when absent', () => {
    const fromReady = exportTraceEvidenceRows([
      {
        type: 'runtime.ready',
        data: {
          timestamp: '2026-08-04T00:00:00.000Z',
          image: 'ghcr.io/tangle-network/sandbox:ready',
          sandboxId: 'sbx-ready-1',
          workspaceRoot: '/workspace/from-ready',
        },
      },
      { type: 'done', data: { timestamp: '2026-08-04T00:00:01.000Z' } },
    ], { format: 'sandbox-events' })
    for (const item of fromReady.spans) {
      expect(item.attributes).toEqual(expect.objectContaining({
        'container.image.name': 'ghcr.io/tangle-network/sandbox:ready',
        'tangle.sandbox.id': 'sbx-ready-1',
        'tangle.environment.cwd': '/workspace/from-ready',
      }))
      expect(item.attributes['container.image.digest']).toBeUndefined()
    }

    const uncaptured = exportTraceEvidenceRows([
      { type: 'start', data: { timestamp: '2026-08-04T00:00:00.000Z' } },
    ], { format: 'sandbox-events' })
    for (const item of uncaptured.spans) {
      expect(item.attributes['container.image.name']).toBeUndefined()
      expect(item.attributes['container.image.digest']).toBeUndefined()
      expect(item.attributes['tangle.sandbox.id']).toBeUndefined()
      expect(item.attributes['tangle.environment.cwd']).toBeUndefined()
    }
  })

  it('writes an exported file from JSONL input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-export-test-'))
    const input = join(dir, 'spans.jsonl')
    const output = join(dir, 'spans.openinference.jsonl')
    await writeFile(input, `${JSON.stringify(completeOpenInferenceRow())}\n`, 'utf8')

    const result = await writeTraceEvidenceExportFile(input, output, {
      attributes: { 'campaign.id': 'r116' },
    })
    expect(result.path).toBe(output)
    expect(result.format).toBe('openinference')
    const [row] = parseRows(await readFile(output, 'utf8'))
    expectOpenInferenceRow(row!)
    expect(row!.attributes).toEqual(expect.objectContaining({ 'campaign.id': 'r116' }))
  })

  it('reads multi-row JSONL that starts with an object row', async () => {
    const first = completeOpenInferenceRow({ trace_id: 'trace-r115' })
    const second = completeOpenInferenceRow({ trace_id: 'trace-r116' })
    const result = exportTraceEvidenceText(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)
    expect(result.format).toBe('openinference')
    expect(result.spans).toHaveLength(2)
  })

  it('streams multi-row JSONL files through the same strict conversion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-stream-export-test-'))
    const input = join(dir, 'spans.jsonl')
    const first = completeOpenInferenceRow({ trace_id: 'trace-r115' })
    const second = completeOpenInferenceRow({ trace_id: 'trace-streamed' })
    const source = `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`
    await writeFile(input, source, 'utf8')

    const result = await exportTraceEvidenceFile(input)

    expect(result).toEqual(exportTraceEvidenceText(source))
    expect(result.format).toBe('openinference')
    expect(result.spans.map((item) => item.trace_id)).toEqual(['trace-r115', 'trace-streamed'])
  })

  it('normalizes complete tool input without inventing arguments from partial fields', async () => {
    const base = {
      trace_id: 'trace-uri',
      parent_span_id: 'root',
      start_time: '2026-06-25T22:44:24.458Z',
      end_time: '2026-06-25T22:44:25.458Z',
      status: { code: 'OK', message: '' },
      resource: { attributes: { 'service.name': 'claude-code' } },
      scope: { name: 'tangle-traces', version: '' },
    }
    const result = exportTraceEvidenceRows([
      {
        ...base,
        span_id: 'tool',
        name: 'claude_code.tool_call',
        kind: 'TOOL',
        attributes: {
          'openinference.span.kind': 'TOOL',
          'span.type': 'tool',
          'tool.name': 'Bash',
          full_command: 'pnpm test --filter api',
        },
      },
      {
        ...base,
        span_id: 'declared-execution',
        parent_span_id: 'tool',
        name: 'claude_code.tool.execution',
        kind: 'TOOL',
        attributes: {
          'openinference.span.kind': 'TOOL',
          'span.type': 'tool.execution',
        },
      },
      {
        ...base,
        span_id: 'undeclared-execution',
        parent_span_id: 'tool',
        name: 'claude_code.tool.execution',
        attributes: {
          'span.type': 'tool.execution',
        },
      },
    ], { format: 'openinference' })

    expect(result.spans[0]!.attributes).toEqual(expect.objectContaining({
      'openinference.span.kind': 'TOOL',
      'input.value': 'pnpm test --filter api',
      'tool.args_captured': true,
    }))
    // A kind the producer DECLARED survives the round trip. Demoting it to
    // CHAIN made `tool-usage` available on the source file and unavailable on
    // our own re-export of it — the same trace answering two different
    // questions depending on which copy you read.
    expect(result.spans[1]!.attributes).toEqual(expect.objectContaining({
      'openinference.span.kind': 'TOOL',
    }))
    expect(result.spans[1]!.attributes['traces.raw_attribute.openinference.span.kind']).toBeUndefined()
    // The demotion still fires where it was always aimed: an execution child
    // that declares no contract kind. Counting it as a second call would double
    // every tool total in the file.
    expect(result.spans[2]!.attributes).toEqual(expect.objectContaining({
      'openinference.span.kind': 'CHAIN',
    }))

    const partialReads = exportTraceEvidenceRows([0, 1, 2].map((offset) => ({
      ...base,
      span_id: `read-${offset}`,
      name: 'claude_code.tool_call',
      kind: 'TOOL',
      start_time: `2026-06-25T22:44:2${offset}.000Z`,
      end_time: `2026-06-25T22:44:2${offset}.100Z`,
      attributes: {
        'openinference.span.kind': 'TOOL',
        'span.type': 'tool',
        'tool.name': 'Read',
        file_path: '/tmp/a',
        offset,
      },
    })), { format: 'openinference' })
    expect(partialReads.spans.every((item) => item.attributes.file_path === '/tmp/a')).toBe(true)
    expect(partialReads.spans.every((item) => item.attributes.offset !== undefined)).toBe(true)
    expect(partialReads.spans.every((item) => item.attributes['input.value'] === undefined)).toBe(true)
    expect(partialReads.spans.every((item) => item.attributes['tool.args_captured'] === false)).toBe(true)
    expect((await runPipelines(partialReads.spans)).stuckLoops.findings).toHaveLength(0)
  })
})

function completeOpenInferenceRow(overrides: Record<string, unknown> = {}) {
  return {
    trace_id: 'trace-hostile',
    span_id: 'span-hostile',
    parent_span_id: '',
    name: 'hostile.span',
    kind: 'CHAIN',
    start_time: '2026-01-01T00:00:00.000Z',
    end_time: '2026-01-01T00:00:01.000Z',
    status: { code: 'OK', message: '' },
    resource: { attributes: {} },
    scope: { name: 'test' },
    attributes: { 'openinference.span.kind': 'CHAIN' },
    ...overrides,
  }
}

describe('strict exported span validation', () => {
  it('rejects duplicate trace and span identities', () => {
    const row = completeOpenInferenceRow()

    expect(() => exportTraceEvidenceRows([row, { ...row }], {
      format: 'openinference',
    })).toThrow('duplicate span identity (trace-hostile, span-hostile)')
  })

  it('rejects malformed and non-finite timestamps', () => {
    expect(() => exportTraceEvidenceRows([
      completeOpenInferenceRow({ start_time: 'not-a-date' }),
    ], { format: 'openinference' })).toThrow(/span-hostile has no readable start_time/)
    expect(() => exportTraceEvidenceRows([
      completeOpenInferenceRow({ start_time: '999999999999999999999999' }),
    ], { format: 'openinference' })).toThrow(/span-hostile has no readable start_time/)
  })

  it('keeps an interval whose end precedes its start, and re-exports it unrepaired', () => {
    // Refusing the whole file for one bad timestamp threw away every other span
    // in it. The span is kept, its interval is withheld for analysis, and the
    // EXPORT carries the producer's own end_time — writing the clamp instead
    // would make the copy validate clean where the original did not.
    const result = exportTraceEvidenceRows([
      completeOpenInferenceRow({
        start_time: '2026-01-01T00:00:02.000Z',
        end_time: '2026-01-01T00:00:01.000Z',
      }),
    ], { format: 'openinference' })

    expect(result.spans).toHaveLength(1)
    expect(result.spans[0]!.start_time).toBe('2026-01-01T00:00:02.000Z')
    expect(result.spans[0]!.end_time).toBe('2026-01-01T00:00:02.000Z')
    expect(result.spans[0]!.attributes['traces.duration_unmeasurable']).toBe(true)
    expect(result.spans[0]!.attributes['traces.raw_attribute.end_time']).toBe('2026-01-01T00:00:01.000Z')

    const [written] = parseRows(serializeSpans(result.spans))
    expect(written!.end_time).toBe('2026-01-01T00:00:01.000Z')
  })

  it('rejects missing required fields instead of inventing them', () => {
    const row = completeOpenInferenceRow()
    delete (row as { name?: string }).name

    expect(() => exportTraceEvidenceRows([row], {
      format: 'openinference',
    })).toThrow(/complete OpenInference span rows/)
  })

  it('rejects duplicate identities split across JSONL rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-duplicate-export-'))
    const input = join(dir, 'duplicate.jsonl')
    const row = completeOpenInferenceRow()
    await writeFile(input, `${JSON.stringify(row)}\n${JSON.stringify(row)}\n`, 'utf8')

    await expect(exportTraceEvidenceFile(input, {
      format: 'openinference',
    })).rejects.toThrow('duplicate span identity (trace-hostile, span-hostile)')
  })
})
