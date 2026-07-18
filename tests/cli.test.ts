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
  it('routes an Intelligence span file through analyze, investigate, and improve', async () => {
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
    const reportText = await readFile(report, 'utf8')
    expect(reportText).toContain('intelligence-spans')
    expect(reportText).toContain('1 session(s), 2 spans')
    const outputRows = parseRows(await readFile(otlp, 'utf8'))
    expect(outputRows).toHaveLength(2)
    expect(outputRows[0]!.attributes).toEqual(expect.objectContaining({
      'traces.source_format': 'intelligence-spans',
      'content': 'Fix the Linear issue using the available tools.',
    }))
    expect(outputRows[1]!.parent_span_id).toBe('trace_cli:root')

    const investigation = join(dir, 'investigation.md')
    const investigated = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'investigate',
      input,
      '--format',
      'intelligence-spans',
      '--out',
      investigation,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })
    expect(investigated.stdout).toContain(`investigation report → ${investigation}`)
    expect(await readFile(investigation, 'utf8')).toContain('1 session(s), 2 spans')

    const improvement = join(dir, 'improvement')
    const improved = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'improve',
      input,
      '--format',
      'intelligence-spans',
      '--dir',
      improvement,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })
    expect(improved.stdout).toContain(`improvement artifacts → ${improvement}`)
    const result = JSON.parse(await readFile(join(improvement, 'result.json'), 'utf8')) as {
      spanCount: number
    }
    expect(result.spanCount).toBe(2)
    expect(await readFile(join(improvement, 'traces.otlp.jsonl'), 'utf8')).not.toBe('')
    expect(await readFile(join(improvement, 'report.md'), 'utf8')).toContain('1 session(s), 2 spans')
  })

  it('turns deterministic analyze signals into actionable findings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-actionable-'))
    const input = join(dir, 'spans.openinference.jsonl')
    const report = join(dir, 'report.md')
    await writeFile(input, serializeSpans([
      span({
        traceId: 'trace-actionable',
        spanId: 'assistant',
        name: 'llm.turn',
        kind: 'LLM',
        startTime: '2026-01-01T00:00:00.000Z',
        service: 'codex',
        step: 1,
        content: 'I am done without checking the result.',
        extra: { 'session.id': 'session-actionable' },
      }),
      span({
        traceId: 'trace-actionable',
        spanId: 'human',
        name: 'user.prompt',
        kind: 'CHAIN',
        startTime: '2026-01-01T00:00:01.000Z',
        service: 'codex',
        step: 2,
        content: 'no, that is wrong, verify it',
        extra: { 'session.id': 'session-actionable', 'tangle.actor': 'human' },
      }),
    ]), 'utf8')

    const analyzed = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'analyze',
      input,
      '--format',
      'openinference',
      '--out',
      report,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    expect(analyzed.stdout).toMatch(/\([1-9]\d* findings, 0 loops/)
    const reportText = await readFile(report, 'utf8')
    expect(reportText).toContain('1 corrective human reaction signal(s)')
    expect(reportText).toContain('**Fix:** Turn the top correction pattern into an agent profile rule')
    expect(reportText).toContain('**Check:** Rerun traces on fresh sessions')
    expect(reportText).not.toContain('_No analyst findings.')
  })

  it('loads an analyze config only when --config is explicit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-config-'))
    const input = join(dir, 'spans.openinference.jsonl')
    const defaultReport = join(dir, 'default-report.md')
    const configuredReport = join(dir, 'configured-report.md')
    const config = join(dir, 'traces.config.mjs')
    const cli = join(process.cwd(), 'src', 'cli.ts')
    const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs')
    await writeFile(input, serializeSpans([
      span({
        traceId: 'trace-config',
        spanId: 'root',
        name: 'session',
        kind: 'AGENT',
        startTime: '2026-01-01T00:00:00.000Z',
        service: 'codex',
        extra: { 'session.id': 'session-config' },
      }),
    ]), 'utf8')
    await writeFile(config, `export default { externalAnalyzers: [{ name: 'configured', async analyze() { return { analyzer: 'configured', ok: true, output: JSON.stringify({ findings: [{ area: 'external', severity: 'high', claim: 'explicit config executed' }] }) } } }] }\n`, 'utf8')

    const run = (report: string, extra: string[] = []) => execFileAsync(process.execPath, [
      '--import',
      tsx,
      cli,
      'analyze',
      input,
      '--format',
      'openinference',
      '--out',
      report,
      ...extra,
    ], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    await run(defaultReport)
    expect(await readFile(defaultReport, 'utf8')).not.toContain('explicit config executed')

    await run(configuredReport, ['--config', config])
    expect(await readFile(configuredReport, 'utf8')).toContain('explicit config executed')
  })

  it('keeps a trace with conflicting session identities in improvement output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-session-conflict-'))
    const input = join(dir, 'spans.openinference.jsonl')
    const improvement = join(dir, 'improvement')
    await writeFile(input, serializeSpans([
      span({
        traceId: 'trace-conflict',
        spanId: 'root',
        name: 'session',
        kind: 'AGENT',
        startTime: new Date(0).toISOString(),
        service: 'claude-code',
        extra: { 'tangle.sessionId': 'session-a' },
      }),
      span({
        traceId: 'trace-conflict',
        spanId: 'child',
        parentSpanId: 'root',
        name: 'message',
        kind: 'CHAIN',
        startTime: new Date(1).toISOString(),
        service: 'claude-code',
        extra: { 'session.id': 'session-b' },
      }),
    ]), 'utf8')

    await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'improve',
      input,
      '--format',
      'openinference',
      '--dir',
      improvement,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const result = JSON.parse(await readFile(join(improvement, 'result.json'), 'utf8')) as {
      spanCount: number
      sessionCount: number
      unassignedTraceCount: number
      adoption: {
        sessionIdentityConflicts: Array<{ traceId: string; sessionIds: string[] }>
      }
    }
    expect(result).toMatchObject({
      spanCount: 2,
      sessionCount: 0,
      unassignedTraceCount: 1,
      adoption: {
        sessionIdentityConflicts: [
          { traceId: 'trace-conflict', sessionIds: ['session-a', 'session-b'] },
        ],
      },
    })
    expect(parseRows(await readFile(join(improvement, 'traces.otlp.jsonl'), 'utf8'))).toHaveLength(2)
    expect(await readFile(join(improvement, 'report.md'), 'utf8')).toContain(
      'Conflicting session identity:** 1 trace(s): `trace-conflict` (`session-a`, `session-b`)',
    )
  })

  it('identifies an explicitly analyzed Codex child session in the report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-child-'))
    const session = join(dir, 'rollout-child.jsonl')
    const report = join(dir, 'report.md')
    const otlp = join(dir, 'spans.openinference.jsonl')
    const parentId = '019f24d6-b5ec-7173-acc1-f957de216ee5'
    const childId = '019f5aea-d6b4-7451-a3eb-60289875a357'
    await writeFile(session, [
      {
        timestamp: '2026-07-13T09:59:27.791Z',
        type: 'session_meta',
        payload: {
          id: childId,
          cwd: '/home/drew/code/agent-dev-container',
          parent_thread_id: parentId,
          thread_source: 'subagent',
          agent_role: 'worker',
        },
      },
      {
        timestamp: '2026-07-13T09:59:28.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: 'Own direct-streaming conversion for the remaining JSONL adapters.',
        },
      },
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')

    await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'analyze',
      '--harness',
      'codex',
      '--session',
      session,
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

    const text = await readFile(report, 'utf8')
    expect(text).toContain('| child |')
    expect(text).toContain(childId)
    expect(text).toContain(parentId)
    expect(text).toContain(session)
    expect(text).toContain('Own direct-streaming conversion')
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

  it('loads custom live analysts for stream replay from traces config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-live-config-'))
    const input = join(dir, 'spans.openinference.jsonl')
    const config = join(dir, 'traces.config.mjs')
    await writeFile(input, serializeSpans([
      span({
        traceId: 'trace_stream_config',
        spanId: 'root',
        name: 'session',
        kind: 'AGENT',
        startTime: '2026-01-01T00:00:00.000Z',
        service: 'synthetic',
      }),
    ]), 'utf8')
    await writeFile(config, `export default {
      liveAnalysts: [{
        id: 'cfg-live',
        analyze(context) {
          return [{
            schemaVersion: 1,
            kind: 'traces.live_finding',
            id: 'live.cfg-live',
            ruleId: 'cfg-live',
            fingerprint: 'cfg-live',
            severity: 'info',
            title: 'Config live analyst',
            claim: 'Loaded from config.',
            action: 'Keep streaming.',
            check: 'Finding appears in stream JSONL.',
            evidence: [{ kind: 'metric', label: 'spans', value: String(context.spans.length) }],
            session: context.session,
            observedAt: context.generatedAt,
          }]
        },
      }],
    }\n`, 'utf8')

    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'stream',
      input,
      '--format',
      'openinference',
      '--config',
      config,
      '--mode',
      'findings',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const rows = parseRows(stdout)
    expect(rows.map((row) => row.event)).toEqual(['session', 'analysis_batch', 'finding'])
    expect((rows.find((row) => row.event === 'finding')!.finding as Record<string, unknown>).ruleId).toBe('cfg-live')
  })
})
