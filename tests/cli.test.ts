import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { serializeSpans, span } from '../src/index.js'

const execFileAsync = promisify(execFile)

function parseRows(jsonl: string): Record<string, unknown>[] {
  return jsonl.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('traces CLI', () => {
  it('analyzes an Intelligence span file through the positional analyze path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-test-'))
    const input = join(dir, 'intelligence-spans.jsonl')
    const report = join(dir, 'report.md')
    const otlp = join(dir, 'spans.openinference.jsonl')
    const rows = [
      {
        id: 'trace_cli:root',
        trace_id: 'trace_cli',
        parent_span_id: null,
        name: 'claude_code.interaction',
        start_unix_nano: '1782427464458000000',
        end_unix_nano: '1782427465458000000',
        attributes: {
          'span.type': 'interaction',
          'service.name': 'claude-code',
          'session.id': 'session_cli',
          user_prompt: 'Fix the Linear issue using the available tools.',
        },
        status_code: 'UNSET',
        redaction_version: '1.0.0+tangle.3',
        session_id: 'session_cli',
      },
      {
        id: 'trace_cli:llm',
        trace_id: 'trace_cli',
        parent_span_id: 'trace_cli:root',
        name: 'claude_code.llm_request',
        start_unix_nano: '1782427464470000000',
        end_unix_nano: '1782427467470000000',
        attributes: {
          'span.type': 'llm_request',
          'service.name': 'claude-code',
          model: 'claude-opus-4-8',
          input_tokens: 25,
          output_tokens: 739,
        },
        status_code: 'OK',
        redaction_version: '1.0.0+tangle.3',
        session_id: 'session_cli',
      },
    ]
    await writeFile(input, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'analyze',
      input,
      '--format',
      'intelligence-spans',
      '--out',
      report,
      '--otlp',
      otlp,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    expect(stdout).toContain(`report → ${report}`)
    expect(await readFile(report, 'utf8')).toContain('intelligence-spans')
    const outputRows = parseRows(await readFile(otlp, 'utf8'))
    expect(outputRows).toHaveLength(2)
    expect(outputRows[0]!.attributes).toEqual(expect.objectContaining({
      'traces.source_format': 'intelligence-spans',
      'content': 'Fix the Linear issue using the available tools.',
    }))
    expect(outputRows[1]!.parent_span_id).toBe('trace_cli:root')
  })

  it('replays a trace file as stream JSONL with semantic findings for visualizers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-stream-'))
    const input = join(dir, 'spans.openinference.jsonl')
    const spans = [
      span({
        traceId: 'trace_stream',
        spanId: 'root',
        name: 'session',
        kind: 'AGENT',
        startTime: '2026-01-01T00:00:00.000Z',
        service: 'synthetic',
      }),
      ...[1, 2, 3].map((i) =>
        span({
          traceId: 'trace_stream',
          spanId: `test-${i}`,
          parentSpanId: 'root',
          name: 'tool.bash',
          kind: 'TOOL',
          startTime: `2026-01-01T00:00:0${i}.000Z`,
          service: 'synthetic',
          tool: 'bash',
          content: 'pnpm test',
          status: 'ERROR',
          step: i,
        })),
      span({
        traceId: 'trace_stream',
        spanId: 'claim',
        parentSpanId: 'root',
        name: 'assistant.message',
        kind: 'LLM',
        startTime: '2026-01-01T00:00:04.000Z',
        service: 'synthetic',
        content: 'Complete. Tests pass.',
        step: 4,
      }),
    ]
    await writeFile(input, serializeSpans(spans), 'utf8')

    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'stream',
      input,
      '--format',
      'openinference',
      '--no-spans',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const rows = parseRows(stdout)
    expect(rows.map((row) => row.event)).toEqual(['session', 'analysis_batch', 'finding', 'finding', 'finding'])
    const rules = rows
      .filter((row) => row.event === 'finding')
      .map((row) => (row.finding as Record<string, unknown>).ruleId)
      .sort()
    expect(rules).toEqual([
      'completion-claim-without-verification',
      'same-failing-command',
      'verification-without-change',
    ])
  })
})
