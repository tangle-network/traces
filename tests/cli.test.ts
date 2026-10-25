import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { deriveHexId } from '@tangle-network/agent-trace-contract'
import { describe, expect, it } from 'vitest'
import { serializeSpans, span } from '../src/otlp.js'

const execFileAsync = promisify(execFile)

function parseRows(jsonl: string): Record<string, unknown>[] {
  return jsonl.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('traces CLI', () => {
  it('routes a span file through analyze, to stdout and to --out DIR', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-test-'))
    const input = join(dir, 'spans.otlp.jsonl')
    const out = join(dir, 'analysis')
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

    const printed = await run(['analyze', input])
    const header = printed.stdout.split('\n')[0]!
    expect(header).toMatch(/^session- claude-code · 06-25 22:44→22:44 UTC, 3 s · /u)
    // The external-engine footer went with the engines (1.0).
    expect(printed.stdout).not.toContain('--analyzer')

    const { stdout } = await run(['analyze', input, '--out', out])
    expect(stdout).toContain(`analysis → ${out}  (report.md, findings.json: `)
    expect(await readFile(join(out, 'report.md'), 'utf8')).toContain(header)
    expect((JSON.parse(await readFile(join(out, 'findings.json'), 'utf8')) as { kind: string }).kind).toBe('traces.finding_packet')
    // Two cold CLI subprocesses, each allowed 30s of its own.
  }, 90_000)

  it('identifies an explicitly analyzed Codex child session in the report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-cli-child-'))
    const session = join(dir, 'rollout-child.jsonl')
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

    const analyze = (format: string[]) => execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'analyze',
      session,
      '--harness',
      'codex',
      ...format,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const text = (await analyze([])).stdout
    expect(text.split('\n')[0]).toContain(`${childId.slice(0, 8)} codex`)
    expect(text.split('\n')[0]).toContain(`child of ${parentId.slice(0, 8)}`)
    const json = JSON.parse((await analyze(['--format', 'json'])).stdout) as { facts: { sessions: Array<{ sessionId: string; parentSessionId: string }> } }
    expect(json.facts.sessions[0]).toMatchObject({ sessionId: childId, parentSessionId: parentId })
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
      'check',
      otlp,
      '--contract',
      'conformance',
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
      'check',
      otlp,
      '--contract',
      'conformance',
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

  it('watches a span file as the traces.stream events of its runs', async () => {
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
          name: 'tool.Bash',
          kind: 'TOOL',
          startTime: `2026-01-01T00:00:0${i}.000Z`,
          endTime: `2026-01-01T00:00:0${i}.500Z`,
          service: 'synthetic',
          tool: 'Bash',
          status: 'ERROR',
          step: i,
          extra: { 'input.value': JSON.stringify({ command: 'pnpm test' }) },
        })),
      span({
        traceId: 'trace_stream',
        spanId: 'edit',
        parentSpanId: 'root',
        name: 'tool.Edit',
        kind: 'TOOL',
        startTime: '2026-01-01T00:00:04.000Z',
        service: 'synthetic',
        tool: 'Edit',
        step: 4,
        extra: { 'input.value': JSON.stringify({ file_path: '/w/src/a.ts', old_string: 'a', new_string: 'b' }) },
      }),
      span({
        traceId: 'trace_stream',
        spanId: 'claim',
        parentSpanId: 'root',
        name: 'message.assistant',
        kind: 'CHAIN',
        startTime: '2026-01-01T00:00:05.000Z',
        service: 'synthetic',
        content: 'Complete. Tests pass.',
        step: 5,
      }),
    ]
    await writeFile(input, serializeSpans(spans), 'utf8')

    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'watch',
      input,
      '--once',
      '--format',
      'jsonl',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })

    const rows = parseRows(stdout)
    expect(rows.map((row) => row.event)).toEqual(['session', 'finding', 'finding', 'finding', 'tick'])
    const rules = rows
      .filter((row) => row.event === 'finding')
      .map((row) => (row.finding as Record<string, unknown>).ruleId)
      .sort()
    expect(rules).toEqual([
      'high-tool-error-rate',
      'same-failing-command',
      'verification-without-change',
    ])

    // --spans adds each span once, as the OTLP-JSONL contract, after its session and before its findings.
    const withSpans = parseRows((await execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'watch', input, '--once', '--format', 'jsonl', '--spans'], {
      cwd: process.cwd(), env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' }, maxBuffer: 10 * 1024 * 1024, timeout: 30_000,
    })).stdout)
    expect(withSpans.map((row) => row.event)).toEqual(['session', 'span', 'span', 'span', 'span', 'span', 'span', 'finding', 'finding', 'finding', 'tick'])
    const streamed = withSpans.filter((row) => row.event === 'span').map((row) => row.span as Record<string, unknown>)
    expect(streamed.map((row) => row.span_id).sort()).toEqual(['claim', 'edit', 'root', 'test-1', 'test-2', 'test-3'])
    expect(withSpans.find((row) => row.event === 'span')!.kind).toBe('traces.stream.span')
  })
})
