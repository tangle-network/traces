/**
 * The turn index (U20): `facts --since … --match` and `list` read it, and it
 * answers exactly what a whole read of each session answers, row for row,
 * however its file was appended. Every case spawns the built CLI with HOME
 * and XDG_STATE_HOME inside a synthetic home.
 */
import { spawn } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeConversationHome } from './fixtures/conversation.js'
import { IDS, makeFixtureHome } from './fixtures/home.js'
import { runCli } from './run-cli.js'

const WINDOW = ['--since', '2026-10-01T00:00:00Z', '--until', '2026-11-01T00:00:00Z'] as const
/** Matches every row, the empty text included. */
const EVERY_ROW = '^'

interface Match {
  sessionId: string | null
  kind: string
  at: string
  spanId: string
  source: string | null
  text: string
  record?: unknown
  lastLine?: unknown
}

interface IndexStats {
  sessions: number
  sessionsRead: number
  bytesRead: number
  wholeReads: number
}

interface Search {
  sessions: number
  matches: Match[]
  selection: { unreadSessions: Array<{ sessionId: string | null }>; index: IndexStats }
}

type Env = Readonly<Record<string, string>>

/** `facts` over the window, which reads the turn index. */
async function search(env: Env, pattern: string = EVERY_ROW): Promise<Search> {
  const run = await runCli(['facts', ...WINDOW, '--match', pattern, '--format', 'json'], { env })
  expect(run.code, run.stderr).toBe(0)
  return JSON.parse(run.stdout) as Search
}

/**
 * `facts <ref>`, which parses the session whole: its own rows, or null when it cannot be read.
 * A named read also cites each command's record and output's last line, which the index keeps no source for.
 */
async function parsed(env: Env, ref: string, sessionId: string, pattern: string = EVERY_ROW): Promise<Match[] | null> {
  const run = await runCli(['facts', ref, '--match', pattern, '--format', 'json'], { env })
  if (run.code === 2) return null
  expect(run.code, run.stderr).toBe(0)
  return (JSON.parse(run.stdout) as Search).matches
    .filter((match) => match.sessionId === sessionId)
    .map(({ record: _record, lastLine: _lastLine, ...match }) => match)
}

const byTime = (rows: readonly Match[]): Match[] => [...rows].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))

/** Every session the window selects, newest first, as `list` names it. */
async function listed(env: Env): Promise<Array<{ id: string; path: string }>> {
  const run = await runCli(['list', '--since', WINDOW[1], '--format', 'json'], { env })
  expect(run.code, run.stderr).toBe(0)
  return (JSON.parse(run.stdout) as { sessions: Array<{ id: string; path: string }> }).sessions
}

describe('turn index: the window answer is the union of whole reads', () => {
  it('on every session of the selection home, row for row and in order', async () => {
    const fx = await makeFixtureHome()
    const answer = await search(fx.env)
    expect(answer.selection.unreadSessions.map((entry) => entry.sessionId)).toEqual([IDS.unreadable])
    const union: Match[] = []
    for (const session of await listed(fx.env)) union.push(...(await parsed(fx.env, session.id, session.id)) ?? [])
    expect(union.length).toBeGreaterThan(10)
    expect(answer.matches).toEqual(byTime(union))
  }, 120_000)

  it('on every session of the conversation home: turns by other hands are never human rows', async () => {
    const fx = await makeConversationHome()
    const answer = await search(fx.env)
    const union: Match[] = []
    for (const session of await listed(fx.env)) union.push(...(await parsed(fx.env, session.id, session.id)) ?? [])
    expect(new Set(union.map((match) => match.kind))).toEqual(new Set(['human', 'agent', 'command']))
    expect(answer.matches).toEqual(byTime(union))
  }, 120_000)
})

// Two sessions written record by record. Claude Code writes a response's
// blocks as separate records with tool results between them; Codex repeats a
// token count and logs a failed stream inside an open response.
const at = (second: number): string => new Date(Date.parse('2026-10-14T10:00:00.000Z') + second * 1000).toISOString()
const CLAUDE_ID = 'c1a0de02-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CODEX_ID = '0199f00e-cccc-7ccc-8ccc-cccccccccccc'
/** A Codex subagent: a fork of {@link CODEX_ID} that first replays that thread's history. */
const FORK_ID = '0199f00f-dddd-7ddd-8ddd-dddddddddddd'

function claudeRecords(cwd: string): unknown[] {
  const base = { sessionId: CLAUDE_ID, cwd, version: '2.1.0', gitBranch: 'main', userType: 'external' }
  let n = 0
  const record = (second: number, type: string, message: unknown) => ({ ...base, type, uuid: `${CLAUDE_ID.slice(0, 8)}-r${++n}`, timestamp: at(second), message })
  const block = (second: number, id: string, content: unknown) =>
    record(second, 'assistant', { id, role: 'assistant', model: 'claude-opus-5-5', content: [content], usage: { input_tokens: 10, output_tokens: 4 } })
  const result = (second: number, call: string) => record(second, 'user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: 'ok' }] })
  return [
    record(0, 'user', { role: 'user', content: 'Ship the parser fix.' }),
    block(1, 'msg-a', { type: 'thinking', thinking: 'Tests first.' }),
    block(2, 'msg-a', { type: 'text', text: 'Running the tests first.' }),
    block(3, 'msg-a', { type: 'tool_use', id: 'toolu-1', name: 'Bash', input: { command: 'pnpm test' } }),
    result(4, 'toolu-1'),
    block(5, 'msg-a', { type: 'tool_use', id: 'toolu-2', name: 'Bash', input: { command: 'git status && traces facts c1a0de02' } }),
    result(6, 'toolu-2'),
    block(7, 'msg-b', { type: 'text', text: 'Part one.' }),
    block(8, 'msg-b', { type: 'text', text: 'Part two: the sentinel-otter test passes.' }),
    record(9, 'user', { role: 'user', content: 'Good, now merge it.' }),
    block(10, 'msg-c', { type: 'text', text: 'Merged.' }),
  ]
}

function codexRecords(cwd: string): unknown[] {
  const event = (second: number, payload: unknown) => ({ timestamp: at(second), type: 'event_msg', payload })
  const item = (second: number, payload: unknown) => ({ timestamp: at(second), type: 'response_item', payload })
  const tokens = (second: number, total: number) =>
    event(second, { type: 'token_count', info: { total_token_usage: { input_tokens: total - 20, output_tokens: 20, total_tokens: total }, last_token_usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 } } })
  const shell = (second: number, call: string, command: string) =>
    item(second, { type: 'function_call', name: 'shell', call_id: call, arguments: JSON.stringify({ command: ['bash', '-lc', command] }) })
  const output = (second: number, call: string) => item(second, { type: 'function_call_output', call_id: call, output: JSON.stringify({ output: 'ok', metadata: { exit_code: 0 } }) })
  const say = (second: number, text: string) => item(second, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
  const ask = (second: number, text: string) => item(second, { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
  return [
    { timestamp: at(0), type: 'session_meta', payload: { id: CODEX_ID, timestamp: at(0), cwd, originator: 'codex_cli_rs', cli_version: '0.150.0' } },
    event(1, { type: 'task_started', turn_id: `${CODEX_ID}-t1` }),
    ask(2, 'Fix the flaky test.'),
    item(3, { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Run it.' }] }),
    say(4, 'Looking at the sentinel-otter test.'),
    shell(5, 'call-1', 'pnpm test'),
    tokens(6, 100),
    output(7, 'call-1'),
    tokens(8, 100),
    say(9, 'Tests pass now.'),
    tokens(10, 180),
    event(11, { type: 'task_complete', turn_id: `${CODEX_ID}-t1` }),
    event(12, { type: 'task_started', turn_id: `${CODEX_ID}-t2` }),
    ask(13, 'Open the PR.'),
    shell(14, 'call-2', 'gh pr create --title Parser'),
    event(15, { type: 'stream_error', message: 'stream disconnected; retrying' }),
    output(16, 'call-2'),
    say(17, 'PR open.'),
    tokens(18, 260),
    event(19, { type: 'task_complete', turn_id: `${CODEX_ID}-t2` }),
  ]
}

/** A spawned Codex subagent's rollout: its own session_meta, the parent's history replayed, then its own turn. */
function forkRecords(cwd: string): unknown[] {
  const event = (second: number, payload: unknown) => ({ timestamp: at(second), type: 'event_msg', payload })
  const item = (second: number, payload: unknown) => ({ timestamp: at(second), type: 'response_item', payload })
  const tokens = (second: number, total: number) =>
    event(second, { type: 'token_count', info: { total_token_usage: { input_tokens: total - 20, output_tokens: 20, total_tokens: total }, last_token_usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 } } })
  const say = (second: number, text: string) => item(second, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
  const spawn = { subagent: { thread_spawn: { parent_thread_id: CODEX_ID, depth: 1, agent_path: '/root/lint' } } }
  return [
    { timestamp: at(30), type: 'session_meta', payload: { id: FORK_ID, forked_from_id: CODEX_ID, thread_source: 'subagent', source: spawn, timestamp: at(30), cwd, originator: 'codex_exec' } },
    { timestamp: at(30), type: 'session_meta', payload: { id: CODEX_ID, timestamp: at(0), cwd, originator: 'codex_cli_rs' } },
    event(30, { type: 'task_started', turn_id: `${CODEX_ID}-t1` }),
    item(30, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the flaky test.' }] }),
    say(30, 'Looking at the sentinel-otter test.'),
    tokens(30, 100),
    event(31, { type: 'task_started', turn_id: '0199f00f-eeee-7eee-8eee-eeeeeeeeeeee' }),
    item(32, { type: 'agent_message', id: 'amsg-1', content: [{ type: 'input_text', text: 'Lint the parser package.' }] }),
    say(33, 'Linting now.'),
    item(34, { type: 'function_call', name: 'shell', call_id: 'call-lint', arguments: JSON.stringify({ command: ['bash', '-lc', 'pnpm lint'] }) }),
    tokens(35, 140),
    item(36, { type: 'function_call_output', call_id: 'call-lint', output: JSON.stringify({ output: 'clean', metadata: { exit_code: 0 } }) }),
    say(37, 'Lint is clean.'),
    tokens(38, 190),
    event(39, { type: 'task_complete', turn_id: '0199f00f-eeee-7eee-8eee-eeeeeeeeeeee' }),
  ]
}

interface GrowingHome {
  readonly env: Env
  readonly claude: string
  readonly codex: string
  readonly fork: string
  readonly cwd: string
}

async function growingHome(): Promise<GrowingHome> {
  const root = await mkdtemp(join(tmpdir(), 'traces-turn-index-'))
  const home = join(root, 'home')
  const cwd = join(home, 'w', 'parser')
  await mkdir(cwd, { recursive: true })
  const claude = join(home, '.claude', 'projects', cwd.replace(/[/.]/gu, '-'), `${CLAUDE_ID}.jsonl`)
  const codex = join(home, '.codex', 'sessions', '2026', '10', '14', `rollout-2026-10-14T10-00-00-${CODEX_ID}.jsonl`)
  const fork = join(home, '.codex', 'sessions', '2026', '10', '14', `rollout-2026-10-14T10-00-30-${FORK_ID}.jsonl`)
  for (const path of [claude, codex, fork]) await mkdir(dirname(path), { recursive: true })
  return {
    claude,
    codex,
    fork,
    cwd,
    env: { HOME: home, XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(root, 'cache') },
  }
}

const line = (record: unknown): string => `${JSON.stringify(record)}\n`

describe('turn index: a session read as it is written', () => {
  it('answers like a whole read after every appended record, wherever a response is cut', async () => {
    const fx = await growingHome()
    const files = [
      { id: CLAUDE_ID, path: fx.claude, records: claudeRecords(fx.cwd) },
      { id: CODEX_ID, path: fx.codex, records: codexRecords(fx.cwd) },
      { id: FORK_ID, path: fx.fork, records: forkRecords(fx.cwd) },
    ]
    for (let k = 0; k < Math.max(...files.map((file) => file.records.length)); k += 1) {
      for (const file of files) if (k < file.records.length) await appendFile(file.path, line(file.records[k]))
      const answer = await search(fx.env)
      // One whole read of all three; while one has no record yet, that run exits 2, so read each alone.
      const together = await runCli(['facts', ...files.map((file) => file.path), '--match', EVERY_ROW, '--format', 'json'], { env: fx.env })
      const all = together.code === 0 ? (JSON.parse(together.stdout) as Search).matches : null
      for (const { id, path } of files) {
        const whole = all ? all.filter((match) => match.sessionId === id) : await parsed(fx.env, path, id)
        const indexed = answer.matches.filter((match) => match.sessionId === id)
        if (whole === null) expect(indexed, `${id} after ${k + 1} records`).toEqual([])
        else expect(indexed, `${id} after ${k + 1} records`).toEqual(whole.map((match) => ({ ...match, source: path })))
      }
    }
    const final = await search(fx.env, 'sentinel-otter')
    expect(final.matches.map((match) => [match.kind, match.text])).toEqual([
      ['agent', 'Looking at the sentinel-otter test.'],
      ['agent', 'Part one. Part two: the sentinel-otter test passes.'],
    ])
    // The fork's replay of its parent's history is not the fork's; its own turn is.
    const fork = await search(fx.env, '[Ll]int')
    expect(fork.matches.map((match) => [match.sessionId, match.kind, match.text])).toEqual([
      [FORK_ID, 'agent', 'Linting now.'],
      [FORK_ID, 'command', 'pnpm lint'],
      [FORK_ID, 'agent', 'Lint is clean.'],
    ])
  }, 300_000)

  it('reads only what was appended, and what an unchanged session needs, nothing', async () => {
    const fx = await growingHome()
    const claude = claudeRecords(fx.cwd)
    const codex = codexRecords(fx.cwd)
    const firstTurn = 12
    await writeFile(fx.claude, claude.slice(0, 9).map(line).join(''))
    await writeFile(fx.codex, codex.slice(0, firstTurn).map(line).join(''))
    const cold = await search(fx.env)
    const claudeBytes = Buffer.byteLength(claude.slice(0, 9).map(line).join(''))
    const codexBytes = Buffer.byteLength(codex.slice(0, firstTurn).map(line).join(''))
    expect(cold.selection.index).toMatchObject({ sessions: 2, sessionsRead: 2, bytesRead: claudeBytes + codexBytes, wholeReads: 0 })

    // Claude Code's last response may still be streaming, so its records are read
    // again; a Codex turn that ended is not.
    const claudeAppended = claude.slice(9).map(line).join('')
    const codexAppended = codex.slice(firstTurn).map(line).join('')
    await appendFile(fx.claude, claudeAppended)
    await appendFile(fx.codex, codexAppended)
    const lastResponse = Buffer.byteLength(claude.slice(7, 9).map(line).join(''))
    const warm = await search(fx.env, 'merge|PR')
    expect(warm.selection.index).toMatchObject({
      sessionsRead: 2,
      bytesRead: Buffer.byteLength(claudeAppended) + lastResponse + Buffer.byteLength(codexAppended),
    })
    expect(warm.matches.map((match) => [match.kind, match.text])).toEqual([
      ['human', 'Good, now merge it.'],
      ['human', 'Open the PR.'],
      ['agent', 'PR open.'],
    ])

    const unchanged = await search(fx.env)
    expect(unchanged.selection.index).toMatchObject({ sessionsRead: 0, bytesRead: 0 })
  }, 60_000)

  it('reads a truncated or replaced file again from its first byte', async () => {
    const fx = await growingHome()
    await writeFile(fx.claude, claudeRecords(fx.cwd).map(line).join(''))
    await writeFile(fx.codex, codexRecords(fx.cwd).map(line).join(''))
    await search(fx.env)
    const shorter = claudeRecords(fx.cwd).slice(0, 4).map((record) => {
      const copy = JSON.parse(JSON.stringify(record)) as { message: { content: unknown } }
      if (typeof copy.message.content === 'string') copy.message.content = 'Rewritten: only the tests.'
      return copy
    })
    await writeFile(fx.claude, shorter.map(line).join(''))
    const answer = await search(fx.env)
    expect(answer.selection.index.bytesRead).toBe(Buffer.byteLength(shorter.map(line).join('')))
    const indexed = answer.matches.filter((match) => match.sessionId === CLAUDE_ID)
    expect(indexed).toEqual((await parsed(fx.env, fx.claude, CLAUDE_ID))!.map((match) => ({ ...match, source: fx.claude })))
    expect(indexed.find((match) => match.kind === 'human')?.text).toBe('Rewritten: only the tests.')
  }, 60_000)
})

describe('turn index: a file rewritten in place, and a left-behind lock', () => {
  it('reads a session rewritten over the same inode again, whether it kept its size or grew', async () => {
    const fx = await growingHome()
    const original = claudeRecords(fx.cwd).map(line).join('')
    await writeFile(fx.claude, original)
    await search(fx.env)
    const human = async (): Promise<string[]> => {
      const answer = await search(fx.env)
      const indexed = answer.matches.filter((match) => match.sessionId === CLAUDE_ID)
      expect(indexed).toEqual((await parsed(fx.env, fx.claude, CLAUDE_ID))!.map((match) => ({ ...match, source: fx.claude })))
      return indexed.filter((match) => match.kind === 'human').map((match) => match.text)
    }
    // The same number of bytes, other words; the file's mtime moves, its inode does not.
    await writeFile(fx.claude, original.replace('Ship the parser fix.', 'Skip the parser fix.'))
    await utimes(fx.claude, new Date('2026-10-14T11:00:00Z'), new Date('2026-10-14T11:00:00Z'))
    expect(await human()).toEqual(['Skip the parser fix.', 'Good, now merge it.'])
    // Rewritten longer: the old offset falls inside the new text.
    await writeFile(fx.claude, original.replace('Ship the parser fix.', 'Ship the parser fix, then rewrite the lexer.'))
    expect(await human()).toEqual(['Ship the parser fix, then rewrite the lexer.', 'Good, now merge it.'])
  }, 60_000)

  it('takes over a lock its process left behind, once, while several searches start together', async () => {
    const fx = await growingHome()
    await writeFile(fx.claude, claudeRecords(fx.cwd).map(line).join(''))
    await writeFile(fx.codex, codexRecords(fx.cwd).map(line).join(''))
    const child = spawn(process.execPath, ['-e', ''])
    const dead = await new Promise<number>((resolve) => child.on('exit', () => resolve(child.pid!)))
    const dir = join(fx.env.XDG_STATE_HOME!, 'traces', 'turn-index')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'lock'), `${dead} left-behind`)
    const runs = await Promise.all(Array.from({ length: 6 }, () => runCli(['facts', ...WINDOW, '--match', EVERY_ROW, '--format', 'json'], { env: fx.env })))
    for (const run of runs) expect(run.code, run.stderr).toBe(0)
    const answers = runs.map((run) => (JSON.parse(run.stdout) as Search).matches)
    for (const answer of answers) expect(answer).toEqual(answers[0])
    expect(answers[0]!.length).toBeGreaterThan(5)
    expect((await readdir(dir)).filter((name) => name.startsWith('lock'))).toEqual([])
  }, 60_000)

  it('takes over a lock untouched for minutes, even when its pid now names a live process', async () => {
    const fx = await growingHome()
    await writeFile(fx.claude, claudeRecords(fx.cwd).map(line).join(''))
    const dir = join(fx.env.XDG_STATE_HOME!, 'traces', 'turn-index')
    await mkdir(dir, { recursive: true })
    // This test's own process is alive; the lock it names has had no heartbeat for ten minutes.
    await writeFile(join(dir, 'lock'), `${process.pid} reused`)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000)
    await utimes(join(dir, 'lock'), tenMinutesAgo, tenMinutesAgo)
    const answer = await search(fx.env)
    expect(answer.matches.length).toBeGreaterThan(5)
    expect((await readdir(dir)).filter((name) => name.startsWith('lock'))).toEqual([])
  }, 60_000)
})

describe('turn index: list', () => {
  it('reads its rows from the index, and a second run reads no session', async () => {
    const fx = await makeFixtureHome()
    const first = await runCli(['list', '--last', '50', '--format', 'json'], { env: fx.env })
    const second = await runCli(['list', '--last', '50', '--format', 'json'], { env: fx.env })
    expect(second.code).toBe(0)
    const before = JSON.parse(first.stdout) as { sessions: unknown[]; selection: { index: IndexStats } }
    const after = JSON.parse(second.stdout) as { sessions: unknown[]; selection: { index: IndexStats } }
    expect(before.selection.index.sessionsRead).toBe(before.selection.index.sessions)
    expect(after.selection.index).toMatchObject({ sessionsRead: 0, bytesRead: 0 })
    expect(after.sessions).toEqual(before.sessions)
  }, 60_000)
})
