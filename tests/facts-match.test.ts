/**
 * `traces facts --match RE`: one row per human turn, agent message or shell
 * command that matches, spawned against the built CLI on a synthetic home
 * (`fixtures/conversation.ts`).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { CONVERSATION, makeConversationHome, TEXT, type ConversationHome } from './fixtures/conversation.js'
import { runCli } from './run-cli.js'

let fx: ConversationHome
beforeAll(async () => {
  fx = await makeConversationHome()
})

interface Match {
  sessionId: string
  kind: string
  at: string
  spanId: string
  source: string | null
  text: string
}

async function matches(argv: readonly string[]): Promise<{ kind: string; sessions: number; matches: Match[] }> {
  const run = await runCli(['facts', ...argv, '--format', 'json'], { env: fx.env })
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as { kind: string; sessions: number; matches: Match[] }
}

describe('facts --match', () => {
  it('finds a human turn and an agent message, never a fleet message', async () => {
    const result = await matches([fx.paths.claude, '--match', 'sentinel-zebra'])
    expect(result.kind).toBe('traces.session_matches')
    expect(result.matches.map((match) => [match.kind, match.text])).toEqual([
      ['human', TEXT.correction],
      ['agent', TEXT.understood],
    ])
  })

  it('anchors ^ at the start of each shell command, so `tangle traces list` is not `traces …`', async () => {
    const result = await matches([fx.paths.claude, '--match', '^traces '])
    expect(result.matches.map((match) => [match.kind, match.text])).toEqual([
      ['command', 'traces facts c0a7e2a1 --format json'],
    ])
    const tangle = await matches([fx.paths.claude, '--match', '^tangle traces'])
    expect(tangle.matches.map((match) => match.text)).toEqual(['tangle traces list'])
  })

  it('searches a window, naming where each hit was read from', async () => {
    const result = await matches(['--since', '2026-10-14T00:00:00Z', '--until', '2026-10-15T00:00:00Z', '--match', 'sentinel-zebra'])
    expect(result.matches.length).toBe(2)
    expect(result.matches[0]).toEqual({
      sessionId: CONVERSATION.claude,
      kind: 'human',
      at: '2026-10-14T10:00:40.000Z',
      spanId: expect.any(String),
      source: fx.paths.claude,
      text: TEXT.correction,
    })
  })

  it('clips a long hit to 300 characters around the match', async () => {
    const result = await matches([fx.paths.claude, '--match', 'Finding 14'])
    // The relay is not a human turn; the agent never wrote it either.
    expect(result.matches).toEqual([])
    const long = await matches([fx.paths.claude, '--match', 'build'])
    for (const match of long.matches) expect(match.text.length).toBeLessThanOrEqual(300)
  })

  it('writes one hit per line with --format jsonl', async () => {
    const run = await runCli(['facts', fx.paths.claude, '--match', 'sentinel-zebra', '--format', 'jsonl'], { env: fx.env })
    expect(run.code).toBe(0)
    expect(run.stdout.trimEnd().split('\n').map((line) => (JSON.parse(line) as Match).kind)).toEqual(['human', 'agent'])
  })

  it('--count gives each value of the first capture group its rows, first and last time, and nothing else', async () => {
    const argv = ['--since', '2026-10-14T00:00:00Z', '--until', '2026-10-15T00:00:00Z', '--match', '^(traces|tangle|rm) ']
    const rows = (await matches(argv)).matches.map((match) => ({ group: /^(\w+) /u.exec(match.text)![1]!, at: match.at }))
    const counted = await runCli(['facts', ...argv, '--count', '--format', 'json'], { env: fx.env })
    expect(counted.code, counted.stderr).toBe(0)
    const groups = (JSON.parse(counted.stdout) as { groups: Array<{ group: string; count: number; first: string; last: string }> }).groups
    expect(groups.map((entry) => entry.group).sort()).toEqual(['rm', 'tangle', 'traces'])
    for (const entry of groups) {
      const own = rows.filter((row) => row.group === entry.group).map((row) => row.at).sort()
      expect(entry).toEqual({ group: entry.group, count: own.length, first: own[0], last: own.at(-1) })
    }
  })

  it('refuses a pattern that is not a regular expression, --no-content, and --count without --match', async () => {
    for (const argv of [['--match', '(unclosed'], ['--match', 'x', '--no-content'], ['--count']]) {
      const run = await runCli(['facts', fx.paths.claude, ...argv, '--format', 'json'], { env: fx.env })
      expect(run.code).toBe(2)
      expect(run.stdout).toBe('')
      expect(JSON.parse(run.stderr)).toMatchObject({ code: 'usage' })
    }
  })
})
