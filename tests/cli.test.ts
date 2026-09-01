import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { serializeSpans, span, type SessionWorkflowSummary } from '../src/index.js'

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
      '--otlp-out',
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
  }, 15_000)

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
    await writeFile(config, `export default { externalAnalyzers: [{ name: 'configured', async analyze() { return { analyzer: 'configured', kind: 'report', ok: true, output: 'explicit config executed' } } }] }\n`, 'utf8')

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
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'child-task',
          started_at: Date.parse('2026-07-13T09:59:27.900Z') / 1_000,
        },
      },
      {
        timestamp: '2026-07-13T09:59:28.100Z',
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
      '--otlp-out',
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

  it('exports Codex readable IDs as conforming OTLP IDs through analyze', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-otlp-codex-'))
    const session = join(dir, 'rollout-readable-codex.jsonl')
    const report = join(dir, 'report.md')
    const otlp = join(dir, 'spans.openinference.jsonl')
    const sessionId = 'codex/readable cli session'
    const callId = 'call/readable cli tool'
    await writeFile(session, [
      {
        timestamp: '2026-07-13T09:59:27.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: dir },
      },
      {
        timestamp: '2026-07-13T09:59:28.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: callId,
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        },
      },
      {
        timestamp: '2026-07-13T09:59:29.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: callId,
          output: 'README contents',
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
      '--otlp-out',
      otlp,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const rows = parseRows(await readFile(otlp, 'utf8'))
    const spanIds = new Set(rows.map((row) => row.span_id as string))
    expect(rows.every((row) => /^[0-9a-f]{32}$/.test(row.trace_id as string))).toBe(true)
    expect(rows.every((row) => /^[0-9a-f]{16}$/.test(row.span_id as string))).toBe(true)
    expect(rows.every((row) => {
      const parent = row.parent_span_id as string
      return parent === '' || (/^[0-9a-f]{16}$/.test(parent) && spanIds.has(parent))
    })).toBe(true)
    expect(rows.some((row) => {
      const attributes = row.attributes as Record<string, unknown>
      return attributes['traces.codex.source_trace_id'] === sessionId
        && attributes['traces.codex.source_span_id'] === `tool:${callId}`
    })).toBe(true)

    const validation = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'validate',
      otlp,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })
    expect(validation.stdout).not.toContain('non-hex-id')
  })

  it('resolves a listed Codex session ID instead of treating it as a file path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-session-id-'))
    const codexHome = join(dir, 'codex')
    const sessionId = '019f-session-id'
    const sessions = join(codexHome, 'sessions', '2026', '07', '23')
    const session = join(sessions, `rollout-2026-07-23T00-00-00-${sessionId}.jsonl`)
    const index = join(dir, 'index.json')
    await mkdir(sessions, { recursive: true })
    await writeFile(session, [
      {
        timestamp: '2026-07-23T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: dir },
      },
      {
        timestamp: '2026-07-23T00:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'Inspect this session by ID.' },
      },
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')

    await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'index',
      '--harness',
      'codex',
      '--session',
      sessionId,
      '--out',
      index,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_HOME: codexHome, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const output = JSON.parse(await readFile(index, 'utf8')) as {
      sessions: Array<{ session: { sessionId: string; path: string } }>
    }
    expect(output.sessions).toHaveLength(1)
    expect(output.sessions[0]).toMatchObject({
      session: { sessionId, path: session },
    })
  })

  it('selects the Codex session named by CODEX_THREAD_ID instead of the most recent child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-current-'))
    const codexHome = join(dir, 'codex')
    const sessions = join(codexHome, 'sessions', '2026', '07', '29')
    const parentId = '019fabd3-6738-7491-a8c0-957ca2bc9876'
    const childId = '019fae74-a099-7b13-befd-003a6ba7f09a'
    const parent = join(sessions, `rollout-2026-07-29T00-00-00-${parentId}.jsonl`)
    const child = join(sessions, `rollout-2026-07-29T00-01-00-${childId}.jsonl`)
    const index = join(dir, 'index.json')
    await mkdir(sessions, { recursive: true })
    await writeFile(parent, [
      { timestamp: '2026-07-29T00:00:00.000Z', type: 'session_meta', payload: { id: parentId, cwd: dir } },
      { timestamp: '2026-07-29T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: 'Parent pursuit.' } },
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')
    await writeFile(child, [
      {
        timestamp: '2026-07-29T00:01:00.000Z',
        type: 'session_meta',
        payload: { id: childId, cwd: dir, parent_thread_id: parentId, thread_source: 'subagent' },
      },
      { timestamp: '2026-07-29T00:01:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: 'Child task.' } },
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')

    await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'index',
      '--harness',
      'codex',
      '--current',
      '--out',
      index,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_THREAD_ID: parentId,
        NO_COLOR: '1',
        FORCE_COLOR: '',
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const output = JSON.parse(await readFile(index, 'utf8')) as {
      sessions: Array<{ session: { sessionId: string; path: string } }>
    }
    expect(output.sessions).toHaveLength(1)
    expect(output.sessions[0]).toMatchObject({ session: { sessionId: parentId, path: parent } })
  })

  it('limits an explicit Claude Code session to its latest task turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-claude-latest-'))
    const session = join(dir, 'claude-session.jsonl')
    const index = join(dir, 'index.json')
    await writeFile(session, [
      {
        type: 'user',
        uuid: 'turn-old',
        sessionId: 'claude-session',
        timestamp: '2026-07-29T00:00:00.000Z',
        message: { role: 'user', content: 'OLD TASK' },
      },
      {
        type: 'assistant',
        uuid: 'answer-old',
        sessionId: 'claude-session',
        timestamp: '2026-07-29T00:00:01.000Z',
        message: { id: 'message-old', role: 'assistant', content: 'OLD ANSWER' },
      },
      {
        type: 'user',
        uuid: 'turn-new',
        sessionId: 'claude-session',
        timestamp: '2026-07-29T00:01:00.000Z',
        message: { role: 'user', content: 'NEW TASK' },
      },
      {
        type: 'assistant',
        uuid: 'answer-new',
        sessionId: 'claude-session',
        timestamp: '2026-07-29T00:01:01.000Z',
        message: { id: 'message-new', role: 'assistant', content: 'NEW ANSWER' },
      },
      {
        type: 'user',
        uuid: 'task-notification',
        sessionId: 'claude-session',
        timestamp: '2026-07-29T00:01:02.000Z',
        userType: 'external',
        message: {
          role: 'user',
          content: '<task-notification>worker complete</task-notification>',
        },
      },
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')

    await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'index',
      '--harness',
      'claude-code',
      '--session',
      session,
      '--latest-turn',
      '--out',
      index,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const output = JSON.parse(await readFile(index, 'utf8')) as {
      selection: { latestTurn?: boolean }
      totals: { sessions: number; spans: number }
    }
    expect(output.selection.latestTurn).toBe(true)
    expect(output.totals).toMatchObject({ sessions: 1, spans: 4 })
  })

  it('expands the active Codex session through recursively spawned child files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-workflow-'))
    const codexHome = join(dir, 'codex')
    const sessions = join(codexHome, 'sessions', '2026', '07', '29')
    const rootId = '019fabd3-6738-7491-a8c0-957ca2bc9876'
    const childId = '019fae74-a099-7b13-befd-003a6ba7f09a'
    const nestedId = '019fafc3-1e3b-7442-b88f-83327ff36284'
    const historicalMissingId = '019fafc3-70fd-7383-944f-042f6e4f6a45'
    const root = join(sessions, `rollout-2026-07-29T00-00-00-${rootId}.jsonl`)
    const child = join(sessions, `rollout-2026-07-29T00-01-00-${childId}.jsonl`)
    const nested = join(sessions, `rollout-2026-07-29T00-02-00-${nestedId}.jsonl`)
    const index = join(dir, 'workflow-index.json')
    await mkdir(sessions, { recursive: true })
    const spawn = (id: string, callId: string, second = 1) => [
      {
        timestamp: `2026-07-29T00:00:0${second}.000Z`,
        type: 'response_item',
        payload: { type: 'function_call', call_id: callId, name: 'spawn_agent', arguments: '{"message":"work"}' },
      },
      {
        timestamp: `2026-07-29T00:00:0${second + 1}.000Z`,
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ agent_id: id }) },
      },
    ]
    await writeFile(root, [
      { timestamp: '2026-07-29T00:00:00.000Z', type: 'session_meta', payload: { id: rootId, cwd: dir } },
      { timestamp: '2026-07-29T00:00:00.100Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'old-turn' } },
      ...spawn(historicalMissingId, 'spawn-historical'),
      { timestamp: '2026-07-29T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'current-turn' } },
      ...spawn(childId, 'spawn-child', 4),
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')
    await writeFile(child, [
      {
        timestamp: '2026-07-28T23:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: childId,
          cwd: dir,
          parent_thread_id: rootId,
          thread_source: 'subagent',
          agent_nickname: 'worker',
          source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1 } } },
        },
      },
      { timestamp: '2026-07-28T23:00:00.100Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn' } },
      ...spawn(nestedId, 'spawn-nested'),
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')
    await writeFile(nested, [
      {
        timestamp: '2026-07-28T22:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: nestedId,
          cwd: dir,
          parent_thread_id: childId,
          thread_source: 'subagent',
          agent_nickname: 'worker',
          source: { subagent: { thread_spawn: { parent_thread_id: childId, depth: 2 } } },
        },
      },
      { timestamp: '2026-07-28T22:00:00.100Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'nested-turn' } },
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')

    await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'index',
      '--harness',
      'codex',
      '--current',
      '--latest-turn',
      '--workflow',
      '--max-workflow-sessions',
      '10',
      '--out',
      index,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_THREAD_ID: rootId,
        NO_COLOR: '1',
        FORCE_COLOR: '',
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const output = JSON.parse(await readFile(index, 'utf8')) as {
      selection: { workflow: SessionWorkflowSummary }
      sessions: Array<{
        session: {
          sessionId: string
          role: string
          parentSessionId?: string
          childSessionIds: string[]
          depth?: number
          agentNickname?: string
        }
      }>
    }
    expect(output.selection.workflow).toEqual({
      seedSessionIds: [rootId],
      complete: true,
      issues: [],
    })
    expect(output.sessions.map((row) => row.session.sessionId)).toEqual([rootId, childId, nestedId])
    expect(output.sessions.map((row) => row.session.role)).toEqual(['operator', 'child', 'child'])
    expect(output.sessions[1]!.session).toMatchObject({
      parentSessionId: rootId,
      childSessionIds: [nestedId],
      depth: 1,
      agentNickname: 'worker',
    })
    expect(output.sessions[2]!.session).toMatchObject({
      parentSessionId: childId,
      childSessionIds: [],
      depth: 2,
      agentNickname: 'worker',
    })
  })

  it('resolves the parent turn from Codex nested SubAgentActivity events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-nested-activity-'))
    const codexHome = join(dir, 'codex')
    const sessions = join(codexHome, 'sessions', '2026', '07', '29')
    const parentId = '019fabd3-6738-7491-a8c0-957ca2bc9876'
    const childId = '019fae74-a099-7b13-befd-003a6ba7f09a'
    const parent = join(sessions, `rollout-2026-07-29T00-00-00-${parentId}.jsonl`)
    const child = join(sessions, `rollout-2026-07-29T00-01-00-${childId}.jsonl`)
    const index = join(dir, 'nested-workflow-index.json')
    await mkdir(sessions, { recursive: true })
    await writeFile(parent, [
      {
        timestamp: '2026-07-29T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: parentId, cwd: dir },
      },
      {
        timestamp: '2026-07-29T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'old-parent-turn' },
      },
      {
        timestamp: '2026-07-29T00:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'current-parent-turn' },
      },
      {
        timestamp: '2026-07-29T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'current-parent-turn',
          internal_chat_message_metadata_passthrough: { turn_id: 'stale-parent-turn' },
          item: {
            type: 'SubAgentActivity',
            id: 'activity-child',
            kind: 'interacted',
            agent_thread_id: childId,
            agent_path: '/root/worker',
            started_at_ms: Date.parse('2026-07-29T00:00:02.500Z'),
            completed_at_ms: Date.parse('2026-07-29T00:00:03.000Z'),
          },
        },
      },
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')
    await writeFile(child, [
      {
        timestamp: '2026-07-29T00:00:02.500Z',
        type: 'session_meta',
        payload: {
          id: childId,
          cwd: dir,
          parent_thread_id: parentId,
          thread_source: 'subagent',
          source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
        },
      },
      {
        timestamp: '2026-07-29T00:00:02.600Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'child-turn' },
      },
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')

    await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'index',
      '--harness',
      'codex',
      '--current',
      '--latest-turn',
      '--workflow',
      '--max-workflow-sessions',
      '10',
      '--out',
      index,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_THREAD_ID: childId,
        NO_COLOR: '1',
        FORCE_COLOR: '',
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const output = JSON.parse(await readFile(index, 'utf8')) as {
      selection: { workflow: SessionWorkflowSummary }
      sessions: Array<{
        session: {
          sessionId: string
          taskScope?: string
          turnId?: string
          parentSessionId?: string
          childSessionIds: string[]
        }
      }>
    }
    expect(output.selection.workflow).toEqual({
      seedSessionIds: [childId],
      complete: true,
      issues: [],
    })
    expect(output.sessions.map((row) => row.session.sessionId)).toEqual([parentId, childId])
    expect(output.sessions[0]!.session).toMatchObject({
      taskScope: 'turn',
      turnId: 'current-parent-turn',
      childSessionIds: [childId],
    })
    expect(output.sessions[1]!.session).toMatchObject({
      taskScope: 'latest',
      parentSessionId: parentId,
    })
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

  it('reports a supervision tree from --supervisor-run-dir, and rolls up a directory of runs', async () => {
    // The rest of this CLI reports what happened inside ONE harness session. A supervision
    // tree is the other axis — who spawned whom, was anyone steered mid-task, how much of the
    // wall clock had no worker running. Every metric comes from
    // @tangle-network/agent-eval/supervisor-run; this path only selects and prints.
    const root = await mkdtemp(join(tmpdir(), 'traces-supervisor-'))
    const runDir = join(root, 'runs', 'inst-1', 'ARM')
    const sup = join(runDir, 'ws', '.loops', 'supervisor', 'sup-1')
    await mkdir(join(sup, 'workers'), { recursive: true })
    const at = (sec: number) => new Date(Date.parse('2026-07-23T00:00:00.000Z') + sec * 1000).toISOString()
    await writeFile(join(sup, 'journal.jsonl'), [
      JSON.stringify({ kind: 'spawned', id: 'sup-1', label: 'root', at: at(0) }),
      JSON.stringify({ kind: 'spawned', id: 'sup-1:w0', parent: 'sup-1', label: 'w-0', at: at(10) }),
      JSON.stringify({ kind: 'settled', id: 'sup-1:w0', status: 'done', at: at(100), spent: { tokens: { input: 5, output: 1 }, usd: 0.01 } }),
    ].join('\n'))
    await writeFile(join(sup, 'state.json'), JSON.stringify({
      status: 'completed', startedAt: at(0), completedAt: at(200), result: { delivered: true, spentUsd: 0.02 },
    }))
    await writeFile(join(sup, 'workers', 'w-0.ndjson'), [
      JSON.stringify({ kind: 'started', workerId: 'sup-1:w0', label: 'w-0', at: at(10), cwd: '/tmp/clone-w-0' }),
      JSON.stringify({ kind: 'message', requestId: 'steer-1', label: 'w-0', direction: 'down', message: 'narrow the fix', delivered: true, at: at(20) }),
      JSON.stringify({ kind: 'finished', label: 'w-0', passed: true, patchBytes: 42, evidence: 'verify PASSED\n', at: at(100) }),
    ].join('\n'))
    await writeFile(
      join(sup, 'workers', 'w-0.inbox.ndjson'),
      `${JSON.stringify({ id: 'steer-1', message: 'narrow the fix' })}\n`,
    )

    const run = (args: string[]) => execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    })

    const single = await run(['analyze', '--supervisor-run-dir', runDir])
    expect(single.stdout).toContain('# Run report — inst-1 [ARM]')
    expect(single.stdout).toContain('steers=1 queued / 1 delivered')
    expect(single.stdout).toContain('| Workers spawned | 1 |')
    // UNAVAILABLE is not ZERO: nothing here wrote a judge verdict.
    expect(single.stdout).toContain('unavailable —')

    const rollup = await run(['analyze', '--supervisor-run-dir', root])
    expect(rollup.stdout).toContain(`Supervisor rollup — ${root}`)
    expect(rollup.stdout).toContain('Steers across all cells: 1')
    expect(rollup.stdout).toContain('| inst-1 | ARM |')

    const out = join(root, 'supervisor.md')
    const written = await run(['analyze', '--supervisor-run-dir', runDir, '--out', out])
    expect(written.stdout).toContain(`supervisor report → ${out}`)
    expect(await readFile(out, 'utf8')).toContain('# Run report — inst-1 [ARM]')

    // A path with no supervision journal analyzes cleanly into an all-unavailable
    // report. Printing it would read as "the supervisor did nothing" instead of
    // "wrong directory", so the command fails with the layout it expected.
    const empty = join(root, 'not-a-run')
    await mkdir(empty, { recursive: true })
    await expect(run(['analyze', '--supervisor-run-dir', empty])).rejects.toThrow(
      /no supervisor run found at .*not-a-run/,
    )
  }, 120_000)
})

describe('traces analyze --llm failure surfacing', () => {
  it('exits non-zero and surfaces the bridge stderr when every agentic analyst dies at startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-llm-fail-'))
    const input = join(dir, 'spans.openinference.jsonl')
    const report = join(dir, 'report.md')
    const fakeBridge = join(dir, 'failing-bridge.sh')
    const bridgeReason =
      "DSPY-BRIDGE-FAILURE: ValueError: analyze input must contain exactly ['controlAdapter', 'instructions', 'limits', 'modelProxy', 'operation', 'question', 'toolCallback', 'toolSpecs']"
    await writeFile(input, serializeSpans([
      span({
        traceId: 'trace-llm-fail',
        spanId: 'root',
        name: 'session',
        kind: 'AGENT',
        startTime: '2026-01-01T00:00:00.000Z',
        service: 'claude-code',
        extra: { 'session.id': 'session-llm-fail' },
      }),
      span({
        traceId: 'trace-llm-fail',
        spanId: 'assistant',
        parentSpanId: 'root',
        name: 'llm.turn',
        kind: 'LLM',
        startTime: '2026-01-01T00:00:01.000Z',
        service: 'claude-code',
        step: 1,
        content: 'Working on the task.',
        extra: { 'session.id': 'session-llm-fail' },
      }),
    ]), 'utf8')
    // Stands in for `python -m agent_eval_rpc.dspy_rlm_bridge`: dies at startup
    // with the failure line on stderr, before any model call.
    await writeFile(fakeBridge, `#!/bin/sh\necho "${bridgeReason}" >&2\nexit 1\n`, { mode: 0o755 })

    const run = execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'analyze',
      input,
      '--format',
      'openinference',
      '--llm',
      '--budget',
      '1',
      '--out',
      report,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '',
        TANGLE_API_KEY: 'test-key-never-sent-upstream',
        OPENAI_API_KEY: '',
        OPENAI_BASE_URL: '',
        TRACES_PYTHON: fakeBridge,
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    })

    const failure = await run.then(
      () => {
        throw new Error('analyze --llm exited 0 although every agentic analyst failed')
      },
      (error: Error & { code?: number; stdout?: string; stderr?: string }) => error,
    )
    expect(failure.code).toBe(1)
    // (a) the FAIL line carries the underlying bridge stderr.
    expect(failure.stderr).toMatch(/\[analyst\] FAIL failure-mode — Error: .*DSPY-BRIDGE-FAILURE: ValueError/)
    // (b) the run ends with an unmissable total-failure banner.
    expect(failure.stderr).toContain('LLM analysis produced nothing')
    expect(failure.stderr).toContain('agent-eval-rpc[dspy]==')
    // The deterministic report is still written, and its analyst table names the reason.
    const reportText = await readFile(report, 'utf8')
    expect(reportText).toContain('| Analyst | Status | Findings | Latency | Detail |')
    expect(reportText).toContain('DSPY-BRIDGE-FAILURE: ValueError: analyze input must contain exactly')
  }, 60_000)
})

describe('traces bundle + bundle-view', () => {
  it('assembles the full view, then projects the writer view over the same session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'traces-cli-bundle-'))
    const leaked = 'The retry budget was the wrong lever and the queue depth decides tail latency here.'
    const transcript = join(root, 'session.jsonl')
    await writeFile(
      transcript,
      [
        {
          type: 'user',
          uuid: 'u1',
          sessionId: 'cli-bundle',
          timestamp: '2026-01-01T00:00:00Z',
          message: { role: 'user', content: leaked },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          sessionId: 'cli-bundle',
          timestamp: '2026-01-01T00:00:01Z',
          message: { id: 'm1', role: 'assistant', content: 'understood' },
        },
      ].map((row) => JSON.stringify(row)).join('\n'),
      'utf8',
    )

    const run = (args: string[]) =>
      execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
        cwd: process.cwd(),
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      })

    const bundleDir = join(root, 'bundle')
    const bundled = await run([
      'bundle', '--harness', 'claude-code', '--session', transcript, '--out', bundleDir,
    ])
    expect(bundled.stdout).toContain('session bundle (full view) →')

    const viewDir = join(root, 'view')
    const projected = await run([
      'bundle-view', bundleDir, '--view', 'evidence-only', '--out', viewDir,
    ])
    expect(projected.stdout).toContain('evidence-only view →')
    expect(projected.stdout).toContain('0 session-text match(es)')

    const manifest = JSON.parse(await readFile(join(viewDir, 'manifest.json'), 'utf8')) as {
      view: string
      excluded: { path: string; rule: string }[]
    }
    expect(manifest.view).toBe('evidence-only')
    expect(manifest.excluded.map((entry) => entry.path)).toContain('session/transcript.jsonl')
    await expect(readFile(join(viewDir, 'session', 'transcript.jsonl'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(viewDir, 'derived', 'report.md'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(bundleDir, 'derived', 'report.md'), 'utf8')).toContain(leaked)
    expect(await readFile(join(viewDir, 'derived', 'evidence.jsonl'), 'utf8')).not.toContain(leaked)

    // --view belongs to bundle-view alone, so nobody can ask `bundle` for a
    // projection and silently receive the full record.
    await expect(run(['bundle', '--session', transcript, '--view', 'evidence-only', '--out', join(root, 'x')]))
      .rejects.toThrow(/--view is not supported by bundle/)
  }, 180_000)
})
