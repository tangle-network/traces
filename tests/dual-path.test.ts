/**
 * Until harness-sessions reads every view traces needs (U18), a session has two
 * read paths: the shared reader, which `traces facts <f>` takes, and traces' own
 * Claude Code and Codex readers, which `--latest-turn` selects. On a session of
 * one turn the two must state every number the same; so must a bundle of the
 * session, which keeps its spans as OTLP.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { IDS, makeFixtureHome, type FixtureHome } from './fixtures/home.js'
import { makeTokenHome, type TokenHome } from './fixtures/tokens.js'
import { runCli } from './run-cli.js'

interface Fact<T> { value: T | null }
interface Session {
  sessionId: string
  tokens: Record<string, unknown> & { spanIds: string[] }
  cost: unknown
  tokenTotal: Fact<number>
  toolCalls: Fact<number>
  toolCallsByName: Fact<Record<string, number>>
  humanTurns: Fact<Array<{ at: string; text: string }>>
  subagents: Fact<Array<{ taskName: string | null }>>
  pullRequests: Fact<{ created: Array<{ identifier: string | null }>; merged: Array<{ identifier: string | null }> }>
}

/** The numbers S2 holds equal: tokens, cost, tool calls, human turns, subagents and pull requests. Span ids differ by reader. */
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
  }
}

async function factsNumbers(argv: readonly string[], env: Readonly<Record<string, string>>) {
  const run = await runCli(['facts', ...argv, '--format', 'json'], { env })
  expect(run.stderr).not.toMatch(/^error:/mu)
  expect(run.code).toBe(0)
  return (JSON.parse(run.stdout) as { sessions: Session[] }).sessions.map(numbers)
}

let th: TokenHome
let fx: FixtureHome
beforeAll(async () => {
  ;[th, fx] = await Promise.all([makeTokenHome(), makeFixtureHome()])
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
