/**
 * Until harness-sessions reads every view traces needs (U18), a session has two
 * read paths: the shared reader, which `traces facts <f>` takes, and traces' own
 * Claude Code and Codex readers, which `--latest-turn` selects. On a session of
 * one turn the two must state every number the same; so must a bundle of the
 * session, which keeps its spans as OTLP.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { IDS, makeFixtureHome, type FixtureHome } from './fixtures/home.js'
import { makeTokenHome, type TokenHome } from './fixtures/tokens.js'
import { runCli } from './run-cli.js'

interface Fact<T> { value: T | null }
interface Session {
  sessionId: string
  firstFailure: Record<string, unknown> & { status: string }
  tokens: Record<string, unknown> & { spanIds: string[] }
  cost: unknown
  tokenTotal: Fact<number>
  toolCalls: Fact<number>
  toolCallsByName: Fact<Record<string, number>>
  humanTurns: Fact<Array<{ at: string; text: string }>>
  subagents: Fact<Array<{ taskName: string | null }>>
  pullRequests: Fact<{ created: Array<{ identifier: string | null }>; merged: Array<{ identifier: string | null }> }>
  measurements: {
    skills: Record<string, unknown>
    waste: {
      failingStreaks: Fact<Array<{ command: string | null; runs: number }>>
      rollbacks: Fact<number>
      repeatedCommands: Fact<unknown>
    }
  }
}

/**
 * The numbers S2 holds equal: tokens, cost, tool calls, human turns, subagents,
 * pull requests, skills, rework, rollbacks and failing streaks. Span ids differ by reader.
 */
function numbers(session: Session) {
  const { spanIds: _ids, ...tokens } = session.tokens
  return {
    sessionId: session.sessionId,
    tokens,
    cost: session.cost,
    tokenTotal: session.tokenTotal.value,
    toolCalls: session.toolCalls.value,
    toolCallsByName: session.toolCallsByName.value,
    humanTurns: session.humanTurns.value?.map((turn) => [turn.at, turn.text]) ?? null,
    subagents: session.subagents.value?.map((spawn) => spawn.taskName) ?? null,
    pullRequests: session.pullRequests.value === null ? null : {
      created: session.pullRequests.value.created.map((pr) => pr.identifier),
      merged: session.pullRequests.value.merged.map((pr) => pr.identifier),
    },
    skills: session.measurements.skills,
    rework: session.measurements.waste.repeatedCommands.value,
    rollbacks: session.measurements.waste.rollbacks.value,
    streaks: session.measurements.waste.failingStreaks.value?.map((streak) => [streak.command, streak.runs]) ?? null,
  }
}

async function facts(argv: readonly string[], env: Readonly<Record<string, string>>): Promise<Session[]> {
  const run = await runCli(['facts', ...argv, '--format', 'json'], { env })
  expect(run.stderr).not.toMatch(/^error:/mu)
  expect(run.code).toBe(0)
  return (JSON.parse(run.stdout) as { sessions: Session[] }).sessions
}

async function factsNumbers(argv: readonly string[], env: Readonly<Record<string, string>>) {
  return (await facts(argv, env)).map(numbers)
}

/** The first failure without its span and trace ids, which differ by reader. */
function firstFailure(session: Session): Record<string, unknown> {
  const { spanId: _spanId, later: _later, traceId: _traceId, ...rest } = session.firstFailure
  return rest
}

const EXEC_FAILS_ID = '019a8c00-eeee-7eee-8eee-eeeeeeeeee01'

/**
 * A Codex session whose `exec_command` exits 1, whose next one exits 0, and whose
 * `pnpm test` then exits 1. Codex writes the exit code in a text header before
 * `Output:`; the output body names another code, which is not the status. Both
 * read paths name a command that checks work `exec_command.verify`, from the
 * command alone: the `ls` runs in a directory named `vitest-setup`, which is
 * not a check.
 */
async function makeExecFailsHome(): Promise<{ path: string; env: Record<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), 'traces-exec-fails-'))
  const home = join(root, 'home')
  const cwd = join(home, 'w', 'widgets')
  const at = (second: number): string => `2026-10-17T10:00:${String(second).padStart(2, '0')}.000Z`
  const exec = (second: number, call: string, cmd: string, code: number, body: string, workdir = cwd) => [
    { timestamp: at(second), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: call, arguments: JSON.stringify({ cmd, workdir }) } },
    {
      timestamp: at(second + 2),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: call, output: `Chunk ID: ${call}\nWall time: 1.9 seconds\nProcess exited with code ${code}\nOriginal token count: 9\nOutput:\n${body}\n` },
    },
  ]
  const rows = [
    { timestamp: at(0), type: 'session_meta', payload: { id: EXEC_FAILS_ID, timestamp: at(0), cwd, originator: 'codex_cli_rs', cli_version: '0.150.0' } },
    { timestamp: at(1), type: 'event_msg', payload: { type: 'task_started', turn_id: `${EXEC_FAILS_ID}-t1` } },
    { timestamp: at(1), type: 'turn_context', payload: { cwd, model: 'gpt-6.1-sol' } },
    { timestamp: at(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Install the workspace.' }] } },
    ...exec(3, 'call-install', 'pnpm install --frozen-lockfile', 1, 'ERR_PNPM_OUTDATED_LOCKFILE (a postinstall exited with code 7)'),
    ...exec(6, 'call-list', 'ls packages', 0, 'core', join(cwd, 'vitest-setup')),
    ...exec(9, 'call-test', 'pnpm test', 1, '1 failed'),
    { timestamp: at(12), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The lockfile is out of date.' }] } },
    { timestamp: at(13), type: 'event_msg', payload: { type: 'task_complete', turn_id: `${EXEC_FAILS_ID}-t1` } },
  ]
  const path = join(home, '.codex', 'sessions', '2026', '10', '17', `rollout-2026-10-17T10-00-00-${EXEC_FAILS_ID}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  return { path, env: { HOME: home, XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache') } }
}

const TYPED_ID = '019a8c00-dddd-7ddd-8ddd-dddddddddd01'
const ASKED = 'The chart page renders blank.'
const REPLY = '<send_user_message_question_reply>\n[{"answer":"the SVG renderer","question":"Which renderer does the page use?","questionItemId":"q-1"}]\n</send_user_message_question_reply>'
const SCREENSHOT = 'still blank, see the screenshot'
const SCREENSHOT_AT = '2026-10-17T11:00:08.005Z'

/**
 * A Codex session where the person answers the agent's question through
 * Codex's question tool, then attaches a screenshot. Codex labels every item of
 * both messages `user.*` and reports each submitted turn (`item_completed`
 * UserMessage); the screenshot's report carries only the typed text, without the
 * `<image …>` wrapper its message has. The shared reader (harness-sessions 0.1.7)
 * read a user message that opens with a tag as injected, so facts dropped both turns.
 */
async function makeTypedTurnsHome(): Promise<{ path: string; env: Record<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), 'traces-typed-turns-'))
  const home = join(root, 'home')
  const cwd = join(home, 'w', 'charts')
  const at = (second: number): string => `2026-10-17T11:00:${String(second).padStart(2, '0')}.000Z`
  const user = (second: number, content: unknown[], kinds: string[]) => ({
    timestamp: at(second),
    type: 'response_item',
    payload: { type: 'message', role: 'user', content, internal_chat_message_metadata_passthrough: { turn_id: `${TYPED_ID}-t1`, content_item_kinds: kinds } },
  })
  const report = (when: string, id: string, content: unknown[]) => ({
    timestamp: when,
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: TYPED_ID, turn_id: `${TYPED_ID}-t1`, item: { type: 'UserMessage', id, content } },
  })
  const agent = (second: number, text: string) => ({ timestamp: at(second), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
  const rows = [
    { timestamp: at(0), type: 'session_meta', payload: { id: TYPED_ID, timestamp: at(0), cwd, originator: 'codex_cli_rs', cli_version: '0.150.0' } },
    { timestamp: at(1), type: 'event_msg', payload: { type: 'task_started', turn_id: `${TYPED_ID}-t1` } },
    { timestamp: at(1), type: 'turn_context', payload: { cwd, model: 'gpt-6.1-sol' } },
    user(2, [{ type: 'input_text', text: ASKED }], ['user.text']),
    report(at(2), 'um-asked', [{ type: 'text', text: ASKED }]),
    agent(3, 'Which renderer does the page use?'),
    user(4, [{ type: 'input_text', text: REPLY }], ['user.text']),
    report(at(4), 'um-reply', [{ type: 'text', text: REPLY }]),
    agent(6, 'Switching the SVG renderer to embedded fonts.'),
    user(8, [
      { type: 'input_text', text: '<image name=[Image #1] path="/tmp/shot.png">' },
      { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'high' },
      { type: 'input_text', text: '</image>' },
      { type: 'input_text', text: SCREENSHOT },
    ], ['user.text', 'user.image', 'user.text', 'user.text']),
    report(SCREENSHOT_AT, 'um-shot', [{ type: 'local_image', path: '/tmp/shot.png' }, { type: 'text', text: SCREENSHOT }]),
    agent(9, 'The font file was missing from the bundle.'),
    { timestamp: at(10), type: 'event_msg', payload: { type: 'task_complete', turn_id: `${TYPED_ID}-t1` } },
  ]
  const path = join(home, '.codex', 'sessions', '2026', '10', '17', `rollout-2026-10-17T11-00-00-${TYPED_ID}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  return { path, env: { HOME: home, XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache') } }
}

let th: TokenHome
let fx: FixtureHome
let ex: { path: string; env: Record<string, string> }
let tt: { path: string; env: Record<string, string> }
beforeAll(async () => {
  ;[th, fx, ex, tt] = await Promise.all([makeTokenHome(), makeFixtureHome(), makeExecFailsHome(), makeTypedTurnsHome()])
})

/** Every single-turn Claude Code and Codex session of both fixture homes. */
const SESSIONS: Array<[string, () => [string, Readonly<Record<string, string>>]]> = [
  ['Claude Code with cache tokens, a spawn and a PR', () => [th.claude, th.env]],
  ['Codex with a cumulative counter and a PR', () => [th.codex, th.env]],
  ['Claude Code with a folded subagent transcript', () => [IDS.claude, fx.env]],
  ['Claude Code in a sibling directory', () => [IDS.claudeTwin, fx.env]],
  ['Codex without token counts', () => [IDS.codex, fx.env]],
  ['Codex in a sibling directory', () => [IDS.codexTwin, fx.env]],
  ['Codex archived', () => [IDS.codexArchived, fx.env]],
  ['Codex in a sibling Codex home', () => [IDS.codexLane, fx.env]],
  ['Codex in an account home', () => [IDS.codexAccount, fx.env]],
  ['Codex in a renamed rollout', () => [IDS.codexUnnamed, fx.env]],
  ['Codex in a reaped worktree', () => [IDS.codexReaped, fx.env]],
  ['Codex parent with two spawned children', () => [IDS.parent, fx.env]],
  ['Codex spawned child', () => [IDS.child1, fx.env]],
  ['Codex exec_command that exits 1', () => [ex.path, ex.env]],
  ['Codex question reply and screenshot turns', () => [tt.path, tt.env]],
]

describe('both read paths state the same numbers', () => {
  it.each(SESSIONS)('%s', async (_name, select) => {
    const [ref, env] = select()
    const [shared, native] = await Promise.all([
      factsNumbers([ref], env),
      factsNumbers([ref, '--latest-turn'], env),
    ])
    expect(shared.length).toBeGreaterThan(0)
    expect(native).toEqual(shared)
  })

  it('reads the token fixtures with their tokens and cost known, so equality is not two nulls', async () => {
    for (const ref of [th.claude, th.codex]) {
      const [session] = await factsNumbers([ref], th.env)
      expect(session!.tokens.input).toEqual(expect.any(Number))
      expect((session!.cost as { usd: number | null }).usd).toEqual(expect.any(Number))
      expect(session!.pullRequests!.created).toHaveLength(1)
    }
    const [claude] = await factsNumbers([th.claude], th.env)
    expect(claude!.subagents).toEqual(['Survey the repo'])
  })

  // harness-sessions 0.1.6 read every Codex exec_command as completed, so the shared path found no failure.
  it('names the same first failure for a Codex exec_command that exits 1', async () => {
    const [[shared], [native]] = await Promise.all([facts([ex.path], ex.env), facts([ex.path, '--latest-turn'], ex.env)])
    expect(shared!.firstFailure).toMatchObject({ status: 'found', stage: 'error-span', name: 'tool.exec_command', laterCount: 1 })
    expect(firstFailure(native!)).toEqual(firstFailure(shared!))
  })

  // harness-sessions 0.1.7 called a Codex user message that opens with a tag injected, whatever
  // Codex's own labels said, so a question reply and a screenshot turn were not the person's.
  it("counts a Codex question reply and a screenshot turn as the person's, on both paths and in the index", async () => {
    const [[shared], [native]] = await Promise.all([facts([tt.path], tt.env), facts([tt.path, '--latest-turn'], tt.env)])
    for (const session of [shared!, native!]) {
      // The screenshot turn is the report of it: the typed text, at its time.
      expect(session.humanTurns.value!.map((turn) => [turn.at, turn.text])).toEqual([
        ['2026-10-17T11:00:02.000Z', ASKED],
        ['2026-10-17T11:00:04.000Z', REPLY],
        [SCREENSHOT_AT, SCREENSHOT],
      ])
    }
    const found = await runCli(['facts', '--since', '2026-10-17T10:00:00Z', '--match', 'still blank|SVG renderer', '--format', 'json'], { env: tt.env })
    expect(found.code).toBe(0)
    const matches = (JSON.parse(found.stdout) as { matches: Array<{ kind: string }> }).matches
    expect(matches.filter((match) => match.kind === 'human')).toHaveLength(2)
  })

  // The shared reader named every Codex command exec_command, and traces' own reader matched its
  // check pattern against the whole argument JSON, so a workdir named vitest-… read as a check.
  it('names a Codex command that checks work exec_command.verify on both paths, from the command alone', async () => {
    const [[shared], [native]] = await Promise.all([facts([ex.path], ex.env), facts([ex.path, '--latest-turn'], ex.env)])
    for (const session of [shared!, native!]) {
      expect(session.toolCallsByName.value).toEqual({ exec_command: 2, 'exec_command.verify': 1 })
    }
  })
})

describe('a bundle of a session states the same numbers', () => {
  it.each([
    ['Claude Code with cache tokens, a spawn and a PR', () => [th.claude, th.env] as const],
    ['Codex with a cumulative counter and a PR', () => [th.codex, th.env] as const],
    ['Claude Code with a folded subagent transcript', () => [IDS.claude, fx.env] as const],
    // A bundle keeps the named session; its spawned Codex children are sessions of their own.
    ['Codex parent', () => [IDS.parent, fx.env] as const],
  ])('%s', async (_name, select) => {
    const [ref, env] = select()
    const out = join(await mkdtemp(join(tmpdir(), 'traces-dual-bundle-')), 'bundle')
    const bundled = await runCli(['bundle', ref, '--out', out], { env })
    expect(bundled.stderr).not.toMatch(/^error:/mu)
    expect(bundled.code).toBe(0)
    const [[direct], fromBundle] = await Promise.all([factsNumbers([ref], env), factsNumbers([out], env)])
    expect(fromBundle).toEqual([direct])
  })
})
