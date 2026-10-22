/**
 * Selection through the CLI: which sessions a command reads when no file is
 * named. Every case spawns the built CLI with HOME at a synthetic home
 * (`fixtures/home.ts`) and asserts stdout, stderr and the exit code.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  codexChildRollout,
  codexParentRollout,
  IDS,
  MTIME_ORDER,
  makeFixtureHome,
  unreadableRollout,
  type FixtureHome,
} from './fixtures/home.js'
import { runCli, type CliRun } from './run-cli.js'

let fx: FixtureHome
beforeAll(async () => {
  fx = await makeFixtureHome()
})

const run = (argv: readonly string[], env: Record<string, string> = {}): Promise<CliRun> =>
  runCli(argv, { env: { ...fx.env, ...env } })

interface ListJson {
  sessions: Array<{ ref: string; id: string; harness: string; cwd: string | null; humanTurns: number | null; firstPrompt: string | null }>
  selection: { unreadSessions: Array<{ sessionId: string | null; reason: string }> }
}

async function list(argv: readonly string[], env: Record<string, string> = {}): Promise<ListJson> {
  const result = await run(['list', ...argv, '--format', 'json'], env)
  expect(result.stderr).not.toMatch(/^error:/mu)
  expect(result.code).toBe(0)
  return JSON.parse(result.stdout) as ListJson
}

interface FactsJson {
  sessions: Array<{ sessionId: string | null; parentSessionId: string | null }>
  selection: { unreadSessions: Array<{ sessionId: string | null; source: string | null; reason: string }> } | null
}

async function facts(argv: readonly string[], env: Record<string, string> = {}): Promise<FactsJson> {
  const result = await run(['facts', ...argv, '--format', 'json'], env)
  expect(result.stderr).not.toMatch(/^error:/mu)
  expect(result.code).toBe(0)
  return JSON.parse(result.stdout) as FactsJson
}

const within = (cwd: string | null, dir: string): boolean => cwd === dir || (cwd ?? '').startsWith(`${dir}/`)

describe('selection: every harness, every Codex home', () => {
  it('lists every harness by default, newest first, with the unreadable session counted and named', async () => {
    const listed = await list(['--last', '50'])
    expect(new Set(listed.sessions.map((row) => row.harness))).toEqual(new Set(['claude-code', 'codex', 'opencode']))
    // Every HOME session but the unreadable one, in file-mtime order.
    expect(listed.sessions.map((row) => row.id)).toEqual(MTIME_ORDER.filter((id) => id !== IDS.unreadable))
    expect(listed.selection.unreadSessions.map((entry) => entry.sessionId)).toEqual([IDS.unreadable])

    const text = await run(['list', '--last', '50'])
    expect(text.code).toBe(0)
    expect(text.stdout.trim().split('\n').at(-1)).toBe(`${MTIME_ORDER.length - 1} sessions · 1 unreadable`)
  })

  it('lists sessions in archived, sibling and account Codex homes, and finds a renamed rollout by id', async () => {
    const ids = (await list(['--harness', 'codex', '--last', '50'])).sessions.map((row) => row.id)
    expect(ids).toEqual(expect.arrayContaining([IDS.codexArchived, IDS.codexLane, IDS.codexAccount, IDS.codexUnnamed]))
    expect((await facts([IDS.codexUnnamed])).sessions[0]!.sessionId).toBe(IDS.codexUnnamed)
  })

  // One `facts` spawn per row, run at once: in sequence, about 20 cold spawns outlasted 30 s on a loaded gate host.
  it('prints a short ref per row that names that session alone', async () => {
    const { sessions } = await list(['--last', '50'])
    for (const row of sessions) expect(row.ref.length).toBeGreaterThanOrEqual(8)
    const named = await Promise.all(sessions.map(async (row) => (await facts([row.ref])).sessions[0]!.sessionId))
    expect(named).toEqual(sessions.map((row) => row.id))
    // The two ids that share an 8-character prefix are told apart by their suffixes.
    const twin = sessions.find((row) => row.id === IDS.codexTwin)!
    expect(IDS.codexTwin.endsWith(twin.ref)).toBe(true)
  }, 60_000)

  it('shows the first prompt and the human-turn count facts reports', async () => {
    const row = (await list(['--last', '50'])).sessions.find((entry) => entry.id === IDS.parent)!
    expect(row).toMatchObject({ harness: 'codex', humanTurns: 1, firstPrompt: 'Split the release work.', cwd: fx.repo })
  })
})

describe('selection: --cwd', () => {
  it('matches the recorded cwd on a path boundary, never a sibling whose name it starts with', async () => {
    const { sessions } = await list(['--cwd', fx.repo, '--last', '50'])
    expect(sessions.length).toBeGreaterThanOrEqual(1)
    expect(sessions.some((row) => within(row.cwd, fx.sibling))).toBe(false)
    expect(sessions.map((row) => row.id)).not.toContain(IDS.claudeTwin)
    expect(sessions.map((row) => row.id)).not.toContain(IDS.codexTwin)
    for (const row of sessions) expect([row.cwd, within(row.cwd, fx.repo) || row.cwd === fx.reapedWorktree]).toEqual([row.cwd, true])

    const siblingOnly = await list(['--cwd', fx.sibling, '--last', '50'])
    expect(siblingOnly.sessions.map((row) => row.id).sort()).toEqual([IDS.claudeTwin, IDS.codexTwin].sort())
  })

  it('finds a session recorded in a removed worktree of the repository by the repository it recorded', async () => {
    const ids = (await list(['--cwd', fx.repo, '--last', '50'])).sessions.map((row) => row.id)
    expect(ids).toContain(IDS.codexReaped)
    // `.` is the directory the command runs in.
    const dot = await runCli(['list', '--cwd', '.', '--last', '50', '--format', 'json'], { env: fx.env, cwd: fx.repo })
    expect((JSON.parse(dot.stdout) as ListJson).sessions.map((row) => row.id)).toContain(IDS.codexReaped)
  })
})

describe('selection: --current and --last', () => {
  const both = (): Record<string, string> => ({ CLAUDE_CODE_SESSION_ID: IDS.claude, CODEX_THREAD_ID: IDS.codex })

  it('keeps a Claude Code session\'s own id when its subagent is read with it', async () => {
    const report = await facts([IDS.claude])
    expect(report.sessions.map((entry) => entry.sessionId)).toEqual([IDS.claude])
  })

  it('reads CODEX_THREAD_ID before CLAUDE_CODE_SESSION_ID', async () => {
    expect((await facts(['--current'], both())).sessions[0]!.sessionId).toBe(IDS.codex)
    expect((await facts(['--current'], { CLAUDE_CODE_SESSION_ID: IDS.claude })).sessions[0]!.sessionId).toBe(IDS.claude)
    // An explicit --harness reads its own harness's variable.
    expect((await facts(['--current', '--harness', 'claude-code'], both())).sessions[0]!.sessionId).toBe(IDS.claude)
  })

  it('exits 2 naming both variables and the list command when neither is set', async () => {
    const result = await run(['facts', '--current', '--format', 'json'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    const error = JSON.parse(result.stderr.trim().split('\n').at(-1)!) as { error: string; code: string }
    expect(error.code).toBe('usage')
    expect(error.error).toContain('CODEX_THREAD_ID')
    expect(error.error).toContain('CLAUDE_CODE_SESSION_ID')
    expect(error.error).toContain('traces list --cwd . --last 1')
  })

  it('never selects the caller\'s own session with --last', async () => {
    const ids = (await list(['--last', '50'], both())).sessions.map((row) => row.id)
    expect(ids).not.toContain(IDS.codex)
    expect(ids).toContain(IDS.claude)

    // The newest session is the caller: --last 1 reads the one before it.
    const last = await facts(['--last', '1', '--harness', 'codex'], { CODEX_THREAD_ID: MTIME_ORDER[0] })
    expect(last.sessions.map((entry) => entry.sessionId)).toEqual([MTIME_ORDER[1]])
    expect(last.selection).toBeNull()
  })
})

describe('selection: one unreadable session never ends a sweep', () => {
  it('skips and names it in a window, with a one-line footer, and exits 0', async () => {
    const result = await run(['facts', '--since', '1h', '--format', 'json'])
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as FactsJson
    expect(report.selection?.unreadSessions.map((entry) => entry.sessionId)).toEqual([IDS.unreadable])
    expect(report.selection?.unreadSessions[0]!.reason).toContain('duplicate span identity')
    expect(result.stderr).toContain('1 unreadable: traces facts --since 1h --format json | jq .selection')
  })

  it('skips and names it in a --last sweep', async () => {
    const report = await facts(['--last', '3', '--harness', 'codex'])
    expect(report.selection?.unreadSessions.map((entry) => entry.sessionId)).toEqual([IDS.unreadable])
    expect(report.sessions.map((entry) => entry.sessionId)).not.toContain(IDS.unreadable)
  })

  it('skips and names a spawned child that cannot be read, and reads the rest of the tree', async () => {
    const home = join(fx.root, 'home-unreadable-child')
    const day = join(home, '.codex', 'sessions', '2026', '10', '14')
    await mkdir(day, { recursive: true })
    const named = (id: string) => join(day, `rollout-2026-10-14T10-30-00-${id}.jsonl`)
    await writeFile(named(IDS.parent), codexParentRollout(fx.repo, 30))
    await writeFile(named(IDS.child1), codexChildRollout(IDS.child1, '/root/lint', fx.repo, 31))
    await writeFile(named(IDS.child2), unreadableRollout(fx.repo, 33, IDS.child2, { parent_thread_id: IDS.parent }))

    const result = await run(['facts', IDS.parent, '--format', 'json'], { HOME: home })
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as FactsJson
    expect(report.sessions.map((entry) => entry.sessionId)).toEqual([IDS.parent, IDS.child1])
    expect(report.selection?.unreadSessions.map((entry) => entry.sessionId)).toEqual([IDS.child2])
    expect(result.stderr).toContain(`1 unreadable: traces facts ${IDS.parent} --format json | jq .selection`)

    const jsonl = await run(['facts', IDS.parent, '--format', 'jsonl'], { HOME: home })
    expect(jsonl.code, jsonl.stderr).toBe(0)
    const rows = jsonl.stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect([...new Set(rows.map((row) => row.session))]).toEqual([IDS.parent])
    expect(jsonl.stderr).toContain('1 unreadable')
  })

  it('exits 2 when the unreadable session is the one named', async () => {
    const result = await run(['facts', IDS.unreadable, '--format', 'json'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr.trim().split('\n').at(-1)!)).toMatchObject({ code: 'unreadable' })

    const jsonl = await run(['facts', IDS.unreadable, '--format', 'jsonl'])
    expect(jsonl.code).toBe(2)
    expect(jsonl.stdout).toBe('')
    expect(JSON.parse(jsonl.stderr)).toMatchObject({ code: 'unreadable' })
  })
})

describe('selection: a store root', () => {
  it('lists only its own stores', async () => {
    const { sessions } = await list([fx.storeRoot])
    expect(sessions.map((row) => row.id)).toEqual([IDS.archived])
  })
})
