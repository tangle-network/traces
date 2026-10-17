import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { deriveHexId } from '@tangle-network/agent-trace-contract'
import { describe, expect, it } from 'vitest'
import { serializeSpans, span } from '../src/index.js'

const execFileAsync = promisify(execFile)

function parseRows(jsonl: string): Record<string, unknown>[] {
  return jsonl.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('traces CLI', () => {
  it('routes a span file through analyze and improve', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-test-'))
    const input = join(dir, 'spans.otlp.jsonl')
    const report = join(dir, 'report.md')
    await writeFile(input, serializeSpans([
      span({
        traceId: 'trace-cli',
        spanId: 'root',
        name: 'claude_code.interaction',
        kind: 'AGENT',
        startTime: '2026-06-25T22:44:24.458Z',
        endTime: '2026-06-25T22:44:25.458Z',
        service: 'claude-code',
        content: 'Fix the Linear issue using the available tools.',
        extra: { 'session.id': 'session-cli' },
      }),
      span({
        traceId: 'trace-cli',
        spanId: 'llm',
        parentSpanId: 'root',
        name: 'claude_code.llm_request',
        kind: 'LLM',
        startTime: '2026-06-25T22:44:24.470Z',
        endTime: '2026-06-25T22:44:27.470Z',
        service: 'claude-code',
        model: 'claude-opus-4-8',
        inputTokens: 25,
        outputTokens: 739,
        extra: { 'session.id': 'session-cli' },
      }),
    ]), 'utf8')
    const run = (args: string[]) => execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const { stdout } = await run(['analyze', input, '--out', report])
    expect(stdout).toContain(`report → ${report}`)
    const reportText = await readFile(report, 'utf8')
    expect(reportText).toContain('1 session(s), 2 spans')
    // The external-engine footer went with the engines (1.0).
    expect(reportText).not.toContain('--analyzer')

    const improvement = join(dir, 'improvement')
    const improved = await run(['improve', input, '--dir', improvement])
    expect(improved.stdout).toContain(`improvement artifacts → ${improvement}`)
    const result = JSON.parse(await readFile(join(improvement, 'result.json'), 'utf8')) as {
      spanCount: number
    }
    expect(result.spanCount).toBe(2)
    expect(await readFile(join(improvement, 'traces.otlp.jsonl'), 'utf8')).not.toBe('')
    expect(await readFile(join(improvement, 'report.md'), 'utf8')).toContain('1 session(s), 2 spans')
    // Two cold CLI subprocesses, each allowed 30s of its own. A 15s outer
    // budget was shorter than the inner ones and failed on a loaded machine
    // while every subprocess was still inside its own timeout, which is the
    // disagreement `vitest.config.ts` raised the default to fix.
  }, 90_000)

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
    await writeFile(config, `export default { analysts: [{ id: 'configured-analyst', description: 'runs only from an explicit config', inputKind: 'trace-store', cost: { kind: 'deterministic' }, version: '1.0.0', async analyze() { return [] } }] }\n`, 'utf8')

    const run = (report: string, extra: string[] = []) => execFileAsync(process.execPath, [
      '--import',
      tsx,
      cli,
      'analyze',
      input,
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
    expect(await readFile(defaultReport, 'utf8')).not.toContain('`configured-analyst`')

    await run(configuredReport, ['--config', config])
    expect(await readFile(configuredReport, 'utf8')).toContain('`configured-analyst`')
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
      sessionIdentityConflicts: Array<{ traceId: string; sessionIds: string[] }>
    }
    expect(result).toMatchObject({
      spanCount: 2,
      sessionCount: 0,
      unassignedTraceCount: 1,
      sessionIdentityConflicts: [
        { traceId: 'trace-conflict', sessionIds: ['session-a', 'session-b'] },
      ],
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
      session,
      '--harness',
      'codex',
      '--out',
      report,
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

  it('converts Codex readable IDs to conforming OTLP IDs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-otlp-codex-'))
    const session = join(dir, 'rollout-readable-codex.jsonl')
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
      'convert',
      session,
      '--harness',
      'codex',
      '--out',
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

  it('converts Claude readable IDs to conforming OTLP IDs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-otlp-claude-'))
    const session = join(dir, 'claude-readable.jsonl')
    const otlp = join(dir, 'spans.openinference.jsonl')
    const sessionId = 'claude/readable cli session'
    const callId = 'call/readable cli tool'
    await writeFile(session, [
      {
        timestamp: '2026-07-13T09:59:27.000Z',
        type: 'user',
        uuid: 'user-readable',
        sessionId,
        message: { role: 'user', content: [{ type: 'text', text: 'Inspect this session.' }] },
      },
      {
        timestamp: '2026-07-13T09:59:28.000Z',
        type: 'assistant',
        uuid: 'assistant-readable',
        sessionId,
        message: {
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command: 'pwd' } }],
        },
      },
      {
        timestamp: '2026-07-13T09:59:29.000Z',
        type: 'user',
        uuid: 'result-readable',
        sessionId,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: callId, content: 'workspace' }],
        },
      },
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')

    await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'convert',
      session,
      '--harness',
      'claude-code',
      '--out',
      otlp,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const rows = parseRows(await readFile(otlp, 'utf8'))
    const spanIds = new Set(rows.map((row) => row.span_id as string))
    expect(rows.every((row) => row.trace_id === deriveHexId(sessionId, 16))).toBe(true)
    expect(rows.every((row) => /^[0-9a-f]{16}$/.test(row.span_id as string))).toBe(true)
    expect(rows.every((row) => {
      const parent = row.parent_span_id as string
      return parent === '' || (/^[0-9a-f]{16}$/.test(parent) && spanIds.has(parent))
    })).toBe(true)
    expect(rows.some((row) => {
      const attributes = row.attributes as Record<string, unknown>
      return attributes['traces.claude.source_trace_id'] === sessionId
        && attributes['traces.claude.source_span_id'] === `assistant-readable:tool:0`
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

    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'facts',
      sessionId,
      '--harness',
      'codex',
      '--format',
      'json',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: dir, CODEX_HOME: codexHome, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const output = JSON.parse(stdout) as { sessions: Array<{ sessionId: string | null }> }
    expect(output.sessions.map((facts) => facts.sessionId)).toEqual([sessionId])
  })

  it('selects the Codex session named by CODEX_THREAD_ID instead of the most recent child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-current-'))
    const codexHome = join(dir, 'codex')
    const sessions = join(codexHome, 'sessions', '2026', '07', '29')
    const parentId = '019fabd3-6738-7491-a8c0-957ca2bc9876'
    const childId = '019fae74-a099-7b13-befd-003a6ba7f09a'
    const parent = join(sessions, `rollout-2026-07-29T00-00-00-${parentId}.jsonl`)
    const child = join(sessions, `rollout-2026-07-29T00-01-00-${childId}.jsonl`)
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

    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'facts',
      '--harness',
      'codex',
      '--current',
      '--format',
      'json',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: dir,
        CODEX_HOME: codexHome,
        CODEX_THREAD_ID: parentId,
        NO_COLOR: '1',
        FORCE_COLOR: '',
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const output = JSON.parse(stdout) as { sessions: Array<{ sessionId: string | null }> }
    expect(output.sessions.map((facts) => facts.sessionId)).toEqual([parentId])
  })

  it('limits an explicit Claude Code session to its latest task turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-claude-latest-'))
    const session = join(dir, 'claude-session.jsonl')
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

    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'facts',
      session,
      '--harness',
      'claude-code',
      '--latest-turn',
      '--format',
      'json',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: dir, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const output = JSON.parse(stdout) as { spanCount: number; sessions: Array<{ spanCount: number }> }
    // Root, the new task, its llm.turn, the assistant message it produced, and
    // the task notification that followed it.
    expect(output.sessions).toHaveLength(1)
    expect(output.spanCount).toBe(5)
    expect(stdout).toContain('NEW TASK')
    expect(stdout).not.toContain('OLD TASK')
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
      // facts reports a session only from its records, never a sheet of zeros.
      { timestamp: '2026-07-28T22:00:00.200Z', type: 'response_item', payload: { type: 'message', role: 'user', content: 'Nested task.' } },
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')

    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'facts',
      '--harness',
      'codex',
      '--current',
      '--latest-turn',
      '--format',
      'json',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: dir,
        CODEX_HOME: codexHome,
        CODEX_THREAD_ID: rootId,
        NO_COLOR: '1',
        FORCE_COLOR: '',
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const output = JSON.parse(stdout) as {
      sessions: Array<{
        sessionId: string | null
        parentSessionId: string | null
        measurements: { relationship: { childSessionIds: string[]; depth?: number; agentNickname?: string } }
      }>
    }
    // The tree is complete: no workflow warning on stderr.
    expect(stderr).not.toContain('session workflow is incomplete')
    expect(output.sessions.map((facts) => facts.sessionId)).toEqual([rootId, childId, nestedId])
    expect(output.sessions.map((facts) => facts.parentSessionId)).toEqual([null, rootId, childId])
    expect(output.sessions[1]!.measurements.relationship).toMatchObject({
      childSessionIds: [nestedId],
      depth: 1,
      agentNickname: 'worker',
    })
    expect(output.sessions[2]!.measurements.relationship).toMatchObject({
      childSessionIds: [],
      depth: 2,
      agentNickname: 'worker',
    })
  })

  it('reads a named Codex child alone: children come with a session, its parent does not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-nested-activity-'))
    const codexHome = join(dir, 'codex')
    const sessions = join(codexHome, 'sessions', '2026', '07', '29')
    const parentId = '019fabd3-6738-7491-a8c0-957ca2bc9876'
    const childId = '019fae74-a099-7b13-befd-003a6ba7f09a'
    const parent = join(sessions, `rollout-2026-07-29T00-00-00-${parentId}.jsonl`)
    const child = join(sessions, `rollout-2026-07-29T00-01-00-${childId}.jsonl`)
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
      // facts reports a session only from its records, never a sheet of zeros.
      {
        timestamp: '2026-07-29T00:00:02.700Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'Child task.' },
      },
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')

    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'facts',
      '--harness',
      'codex',
      '--current',
      '--latest-turn',
      '--format',
      'json',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: dir,
        CODEX_HOME: codexHome,
        CODEX_THREAD_ID: childId,
        NO_COLOR: '1',
        FORCE_COLOR: '',
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const output = JSON.parse(stdout) as {
      sessions: Array<{
        sessionId: string | null
        parentSessionId: string | null
        measurements: { relationship: { taskScope?: string } }
      }>
    }
    expect(stderr).not.toContain('session workflow is incomplete')
    expect(output.sessions.map((facts) => facts.sessionId)).toEqual([childId])
    expect(output.sessions[0]!.parentSessionId).toBe(parentId)
    expect(output.sessions[0]!.measurements.relationship.taskScope).toBe('latest')
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

describe('traces ask', () => {
  async function writeSessionFile(dir: string): Promise<string> {
    const input = join(dir, 'spans.openinference.jsonl')
    await writeFile(input, serializeSpans([
      span({
        traceId: 'trace-ask-cli',
        spanId: 'root',
        name: 'session',
        kind: 'AGENT',
        startTime: '2026-01-01T00:00:00.000Z',
        service: 'codex',
        extra: { 'session.id': 'session-ask-cli' },
      }),
      span({
        traceId: 'trace-ask-cli',
        spanId: 'turn',
        parentSpanId: 'root',
        name: 'llm.turn',
        kind: 'LLM',
        startTime: '2026-01-01T00:00:01.000Z',
        service: 'codex',
        step: 1,
        content: 'Running the checks now.',
      }),
    ]), 'utf8')
    return input
  }

  it('needs at least one question', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-ask-none-'))
    const input = await writeSessionFile(dir)
    const failure = await execFileAsync(process.execPath, [
      '--import', 'tsx', 'src/cli.ts', 'ask', input,
    ], { cwd: process.cwd(), env: { ...process.env, NO_COLOR: '1' }, timeout: 30_000 }).then(
      () => {
        throw new Error('ask exited 0 without a question')
      },
      (error: Error & { code?: number; stderr?: string }) => error,
    )
    expect(failure.code).toBe(2)
    expect(failure.stderr).toContain('ask needs --question')
  }, 30_000)

  it('rejects a --question-timeout that is not a positive number of seconds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-ask-timeout-'))
    const input = await writeSessionFile(dir)
    for (const value of ['0', '-5', 'soon']) {
      const failure = await execFileAsync(process.execPath, [
        '--import', 'tsx', 'src/cli.ts', 'ask', input,
        '--question', 'Did the session finish?', '--question-timeout', value,
      ], { cwd: process.cwd(), env: { ...process.env, NO_COLOR: '1' }, timeout: 30_000 }).then(
        () => {
          throw new Error(`ask exited 0 with --question-timeout ${value}`)
        },
        (error: Error & { code?: number; stderr?: string }) => error,
      )
      expect(failure.code).toBe(2)
      expect(failure.stderr).toContain('--question-timeout must be a number of seconds')
    }
  }, 60_000)

  it('writes every answer and failure, then exits 1 when the engine dies at startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-ask-fail-'))
    const input = await writeSessionFile(dir)
    const out = join(dir, 'ask')
    const questions = join(dir, 'questions.json')
    await writeFile(questions, JSON.stringify([
      { id: 'checks', question: 'Which checks ran?' },
      { id: 'turns', question: 'How many assistant turns were there?', answerSchema: { type: 'integer' } },
    ]), 'utf8')
    const fakeBridge = join(dir, 'failing-bridge.sh')
    const bridgeReason = 'DSPY-BRIDGE-FAILURE: ValueError: synthetic startup failure'
    await writeFile(fakeBridge, `#!/bin/sh\necho "${bridgeReason}" >&2\nexit 1\n`, { mode: 0o755 })

    const failure = await execFileAsync(process.execPath, [
      '--import', 'tsx', 'src/cli.ts', 'ask', input,
      '--questions', questions,
      '--question', 'Did the session finish?',
      '--budget', '5',
      '--question-timeout', '1.25',
      '--concurrency', '2',
      '--dir', out,
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
      timeout: 90_000,
    }).then(
      () => {
        throw new Error('ask exited 0 although every question failed')
      },
      (error: Error & { code?: number; stdout?: string; stderr?: string }) => error,
    )
    expect(failure.code).toBe(1)
    expect(failure.stdout).toContain('# traces ask')
    expect(failure.stdout).toContain('**0 answered, 3 failed.**')
    expect(failure.stderr).toContain('3 of 3 question(s) failed')

    const answers = JSON.parse(await readFile(join(out, 'answers.json'), 'utf8')) as {
      kind: string
      ok: boolean
      budgetUsd: number
      questionBudgetUsd: number
      questionTimeoutMs: number
      questions: Array<{ id: string; status: string; failure?: { kind: string; message: string } }>
    }
    expect(answers.kind).toBe('traces.ask')
    expect(answers.ok).toBe(false)
    expect(answers.budgetUsd).toBe(5)
    expect(answers.questionBudgetUsd).toBe(1)
    expect(answers.questionTimeoutMs).toBe(1250)
    expect(answers.questions.map((answer) => answer.id)).toEqual(['checks', 'turns', 'q3'])
    for (const answer of answers.questions) {
      expect(answer.status).toBe('failed')
      expect(answer.failure?.kind).toBe('error')
      expect(answer.failure?.message).toContain(bridgeReason)
    }
    expect(await readFile(join(out, 'report.md'), 'utf8')).toContain('failed: error')
  }, 90_000)
})
