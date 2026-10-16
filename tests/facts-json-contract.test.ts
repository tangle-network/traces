/**
 * The `facts --format json` paths other repositories read, spawned against the
 * built CLI on a synthetic home (`fixtures/home.ts`).
 *
 * tangle-tools `fleet/recurrence.py` runs `traces facts <P> --harness <H>
 * --format json` and reads `sessions[0]` (`:215`): its human turns, final
 * messages, subagent task names, created pull requests, token total and first
 * and last record times. A named session brings its spawned children, so
 * `sessions[0]` must stay the named session and no number of it may include a
 * child's.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { IDS, makeFixtureHome, type FixtureHome } from './fixtures/home.js'
import { runCli } from './run-cli.js'

let fx: FixtureHome
beforeAll(async () => {
  fx = await makeFixtureHome()
})

interface Fact<T> {
  value: T | null
  spanIds: string[]
  unavailable: string | null
}

interface SessionJson {
  sessionId: string | null
  parentSessionId: string | null
  toolCalls: Fact<number>
  humanTurns: Fact<Array<{ text: string }>>
  finalMessages: Fact<Array<{ text: string }>>
  subagents: Fact<Array<{ taskName: string | null }>>
  pullRequests: Fact<{ created: Array<{ command: string }> }>
  tokenTotal: Fact<number>
  firstRecordAt: Fact<string>
  lastRecordAt: Fact<string>
}

async function factsOf(argv: readonly string[]): Promise<SessionJson[]> {
  const result = await runCli(['facts', ...argv, '--format', 'json'], { env: fx.env })
  expect(result.stderr).not.toMatch(/^error:/mu)
  expect(result.code).toBe(0)
  return (JSON.parse(result.stdout) as { sessions: SessionJson[] }).sessions
}

describe('facts JSON: the paths recurrence reads', () => {
  it('serves every path on the session file recurrence names', async () => {
    const [session] = await factsOf([fx.paths.parent, '--harness', 'codex'])
    expect(session!.sessionId).toBe(IDS.parent)
    expect(session!.humanTurns.value!.map((turn) => turn.text)).toEqual(['Split the release work.'])
    expect(session!.finalMessages.value!.map((message) => message.text)).toContain('Both children ran; PR #7 is open.')
    expect(session!.subagents.value!.map((spawn) => spawn.taskName)).toEqual(['/root/lint', '/root/test'])
    expect(session!.pullRequests.value!.created.map((created) => typeof created.command)).toEqual(['string'])
    expect(typeof session!.tokenTotal.value).toBe('number')
    expect(Date.parse(session!.firstRecordAt.value!)).toBeLessThan(Date.parse(session!.lastRecordAt.value!))
  })
})

describe('facts JSON: a named session and its children', () => {
  it('puts the named session first and each child after it, in the order they started', async () => {
    for (const ref of [IDS.parent, fx.paths.parent, IDS.parent.slice(0, 8)]) {
      const sessions = await factsOf([ref])
      expect(sessions.map((session) => [session.sessionId, session.parentSessionId])).toEqual([
        [IDS.parent, null],
        [IDS.child1, IDS.parent],
        [IDS.child2, IDS.parent],
      ])
    }
  })

  it('counts only the named session\'s own records in its numbers', async () => {
    const [parent, child1, child2] = await factsOf([IDS.parent])
    // Two spawns and the pull request: each child's one shell call is its own.
    expect(parent!.toolCalls.value).toBe(3)
    expect(child1!.toolCalls.value).toBe(1)
    expect(child2!.toolCalls.value).toBe(1)
    expect(parent!.humanTurns.value).toHaveLength(1)
  })

  it('reads a child alone, without its parent', async () => {
    const sessions = await factsOf([IDS.child2])
    expect(sessions.map((session) => session.sessionId)).toEqual([IDS.child2])
  })
})

/**
 * dotfiles voice-ledger `scripts/from_traces.py` runs `traces facts --harness
 * claude-code --since S --until U --format json` and reads `measurementVersion`
 * (at least 4), each session's `sessionId`, `cwd.value` and
 * `humanTurns.value[].{at, text, answered}`, and `selection.unreadSessions[]`
 * `{sessionId, source, reason}` for the sessions it must recover elsewhere.
 */
describe('facts JSON: the paths voice-ledger reads', () => {
  const window = ['--since', '2026-10-14T00:00:00Z', '--until', '2026-10-15T00:00:00Z']

  it('serves every path over a window of Claude Code sessions', async () => {
    const run = await runCli(['facts', '--harness', 'claude-code', ...window, '--format', 'json'], { env: fx.env })
    expect(run.code).toBe(0)
    const report = JSON.parse(run.stdout) as {
      measurementVersion: string
      sessions: Array<{ sessionId: string; cwd: { value: string | null }; humanTurns: { value: Array<{ at: string; text: string; answered: string | null }> } }>
    }
    expect(Number(report.measurementVersion)).toBeGreaterThanOrEqual(4)
    const byId = new Map(report.sessions.map((session) => [session.sessionId, session]))
    const claude = byId.get(IDS.claude)!
    expect(claude.cwd.value).toBe(fx.repo)
    expect(claude.humanTurns.value.map((turn) => [turn.at, turn.text, turn.answered])).toEqual([
      ['2026-10-14T10:00:00.000Z', 'Fix the build.', null],
    ])
  })

  it('names each session it could not read with its source and reason', async () => {
    const run = await runCli(['facts', '--harness', 'codex', ...window, '--format', 'json'], { env: fx.env })
    expect(run.code).toBe(0)
    const unread = (JSON.parse(run.stdout) as { selection: { unreadSessions: Array<{ sessionId: string; source: string; reason: string }> } })
      .selection.unreadSessions
    expect(unread.map((entry) => entry.sessionId)).toEqual([IDS.unreadable])
    expect(typeof unread[0]!.source).toBe('string')
    expect(unread[0]!.reason.length).toBeGreaterThan(0)
  })
})
