/**
 * The `traces facts` text sheet (spec §2.2), through the built CLI: it is the
 * default output, each session fits 25 lines, and every line of the template
 * is there in its order, naming the session, its turns, tools, tokens and cost,
 * time lost, pull requests, first failure and final message.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { IDS, makeFixtureHome, type FixtureHome } from './fixtures/home.js'
import { makeTokenHome, TOKEN_IDS, type TokenHome } from './fixtures/tokens.js'
import { runCli } from './run-cli.js'

let th: TokenHome
let fx: FixtureHome
beforeAll(async () => {
  ;[th, fx] = await Promise.all([makeTokenHome(), makeFixtureHome()])
})

async function sheet(argv: readonly string[], env: Readonly<Record<string, string>>): Promise<string> {
  const run = await runCli(['facts', ...argv], { env })
  expect(run.stderr).not.toMatch(/^error:/mu)
  expect(run.code).toBe(0)
  return run.stdout
}

/** The blocks of a sheet: one per session, after any report header, split on blank lines. */
const blocks = (text: string): string[][] => text.trimEnd().split('\n\n').map((block) => block.split('\n'))

/** The template's lines, in order, each matched at the start of a line. */
const TEMPLATE = [/^human turns /u, /^tools /u, /^tokens /u, /^waste /u, /^PRs /u, /^first failure /u]

function expectTemplate(lines: readonly string[]): void {
  expect(lines.length).toBeLessThanOrEqual(25)
  const at = TEMPLATE.map((line) => lines.findIndex((text) => line.test(text)))
  expect(at.every((index) => index > 0), lines.join('\n')).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
}

describe('the facts text sheet', () => {
  it('is the default output: a Claude Code session in at most 25 lines, every template line in order', async () => {
    const lines = blocks(await sheet([th.claude], th.env))
    expect(lines).toHaveLength(1)
    const [session] = lines
    expectTemplate(session!)
    expect(session![0]).toMatch(new RegExp(`^${TOKEN_IDS.claude.slice(0, 8)} claude-code · widgets · 10-14 11:00→11:00 UTC · active \\d+ s$`, 'u'))
    expect(session).toContain('human turns 1 · interrupts 0')
    expect(session).toContain('tools 2 (Agent 1, Bash 1) · subagents 1 (Survey the repo)')
    expect(session).toContain('commands 1: gh pr 1')
    expect(session!.find((line) => line.startsWith('tokens '))).toMatch(/^tokens in \S+ · out \S+ · cache read \S+ · cache write \S+ · \$\d+\.\d+ list price \(Router rates\)$/u)
    expect(session).toContain('waste 0 min')
    expect(session).toContain('PRs opened #12 · merged none · changed 0 files')
    expect(session!.find((line) => line.startsWith('first failure '))).toMatch(/^first failure 11:00 \S+: .+ \(blame \w+, span [0-9a-f]+\)$/u)
    expect(session!.at(-1)).toBe('final "Opened PR #12."')
  })

  it('prints a Codex session from the same template', async () => {
    const [session] = blocks(await sheet([th.codex], th.env))
    expectTemplate(session!)
    expect(session![0]).toMatch(new RegExp(`^${TOKEN_IDS.codex.slice(0, 8)} codex · widgets · 10-14 11:00→11:00 UTC · active \\d+ s$`, 'u'))
    expect(session).toContain('commands 1: gh pr 1')
    // The shared reader records the pull request without its number.
    expect(session).toContain('PRs opened 1 unnumbered · merged none · changed 0 files')
    expect(session!.at(-1)).toBe('final "Opened PR #13."')
  })

  it('heads a selection of several sessions with one line, then one sheet per session, children marked', async () => {
    const [header, ...sessions] = blocks(await sheet([IDS.parent], fx.env))
    expect(header).toEqual(['3 sessions · $0, no model call'])
    expect(sessions).toHaveLength(3)
    for (const session of sessions) expectTemplate(session)
    expect(sessions[0]![0]).toMatch(/^0199f6c0 codex · agent-dev-container(?: \(\S+\))? · /u)
    expect(sessions[0]).toContain('PRs opened 1 unnumbered · merged none · changed 0 files')
    for (const child of sessions.slice(1)) expect(child[0]).toMatch(/ · child of 0199f6c0$/u)
  })

  it('names a window and each session it could not read in the header', async () => {
    const window = ['--since', '2026-10-14T00:00:00Z', '--until', '2026-10-15T00:00:00Z', '--harness', 'codex']
    const run = await runCli(['facts', ...window], { env: fx.env })
    expect(run.code).toBe(0)
    const [header, ...sessions] = blocks(run.stdout)
    expect(header![0]).toMatch(/^\d+ sessions · window 2026-10-14T00:00:00\.000Z → 2026-10-15T00:00:00\.000Z, 0 read with no record inside it · 1 unreadable · \$0, no model call$/u)
    expect(header![1]).toMatch(new RegExp(`^unreadable ${IDS.unreadable}: `, 'u'))
    expect(sessions.length).toBeGreaterThan(1)
    for (const session of sessions) expectTemplate(session)
  })

  it('says unknown with the reason where content was withheld, never zero', async () => {
    const [session] = blocks(await sheet([th.claude, '--no-content'], th.env))
    expectTemplate(session!)
    expect(session).toContain('human turns unknown: Content was not requested.')
    expect(session).toContain('PRs unknown: Content was not requested.')
    expect(session).toContain('commands unknown: Content was not requested.')
    expect(session!.join('\n')).not.toContain('Opened PR #12')
    expect(session!.join('\n')).not.toContain('Survey the repo')
  })
})
