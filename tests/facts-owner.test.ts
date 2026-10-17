/**
 * facts owns a session's tokens and cost (`src/execution.ts`). Every number is
 * checked against an oracle computed from the raw records by a jq one-liner,
 * never from facts, and the cost against agent-runtime's `priceTokens`, the
 * one price table. `analyze` renders the same numbers.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { priceTokens } from '@tangle-network/agent-runtime'
import { beforeAll, describe, expect, it } from 'vitest'
import { IDS, makeFixtureHome, type FixtureHome } from './fixtures/home.js'
import { claudeTokensTranscript, makeTokenHome, TOKEN_IDS, type TokenHome } from './fixtures/tokens.js'
import { FIXTURE_SESSION_ID, fixtureRecords } from './session-facts-fixture.js'
import { runCli } from './run-cli.js'

const execFileAsync = promisify(execFile)

/** Claude Code: each response's last usage record, its prompt categories summed. */
const CLAUDE_ORACLE = `[inputs | select(.type == "assistant" and (.isSidechain | not))] | group_by(.message.id) | map(.[-1].message.usage)
  | {input: (map((.input_tokens // 0) + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0)) | add),
     output: (map(.output_tokens // 0) | add), cacheRead: (map(.cache_read_input_tokens // 0) | add), cacheWrite: (map(.cache_creation_input_tokens // 0) | add)}`

/** Codex: its own last cumulative counter, whose input_tokens already hold the cached tokens. */
const CODEX_ORACLE = `[inputs | select(.type == "event_msg" and .payload.type == "token_count") | .payload.info.total_token_usage | select(. != null)] | last
  | {input: .input_tokens, output: .output_tokens, cacheRead: (.cached_input_tokens // 0), cacheWrite: (.cache_write_input_tokens // 0), reasoning: .reasoning_output_tokens}`

const CLAUDE_SPAWNS = '[inputs | select(.type == "assistant") | .message.content[]? | select(.type == "tool_use" and (.input.subagent_type? // null) != null) | .id] | unique | length'
const CODEX_SPAWNS = '[inputs | select(.type == "response_item" and .payload.type == "function_call" and .payload.name == "spawn_agent")] | length'

async function jq(program: string, path: string): Promise<unknown> {
  const { stdout } = await execFileAsync('jq', ['-n', '-c', program, path])
  return JSON.parse(stdout) as unknown
}

interface Tokens {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  reasoning: number | null
  modelCalls: number
  byModel: Array<{ model: string; input: number; output: number; cacheRead: number; cacheWrite: number }>
  unavailable: string | null
}

interface Session {
  sessionId: string
  tokens: Tokens
  cost: { usd: number | null; label: string; unavailable: string | null }
  tokenTotal: { value: number | null; unavailable: string | null }
  subagents: { value: unknown[] }
}

async function facts(argv: readonly string[], env: Readonly<Record<string, string>>): Promise<{ sessions: Session[]; bytes: number }> {
  const run = await runCli(['facts', ...argv, '--format', 'json'], { env })
  expect(run.stderr).not.toMatch(/^error:/mu)
  expect(run.code).toBe(0)
  return { ...(JSON.parse(run.stdout) as { sessions: Session[] }), bytes: Buffer.byteLength(run.stdout) }
}

/**
 * The tokens and cost `traces analyze` reports: the facts sheets in its JSON,
 * summed, with the cost its text header prints for one session.
 */
async function analyzeUsage(argv: readonly string[], env: Readonly<Record<string, string>>) {
  const json = await runCli(['analyze', ...argv, '--format', 'json'], { env })
  expect(json.code, json.stderr).toBe(0)
  const sessions = (JSON.parse(json.stdout) as { facts: { sessions: Session[] } }).facts.sessions
  const measured = sessions.filter((session) => session.tokens.input !== null)
  const total = (read: (tokens: Tokens) => number | null) => measured.reduce((sum, session) => sum + (read(session.tokens) ?? 0), 0)
  const usd = sessions.some((session) => session.cost.usd === null) ? null : sessions.reduce((sum, session) => sum + session.cost.usd!, 0)
  if (sessions.length === 1) {
    const header = (await runCli(['analyze', ...argv], { env })).stdout.split('\n')[0]!
    expect(header).toContain(usd === null ? 'cost unknown: ' : `$${usd.toFixed(usd < 1 ? 4 : 2)} list price (Router rates)`)
  }
  return {
    input: total((tokens) => tokens.input),
    output: total((tokens) => tokens.output),
    cacheRead: total((tokens) => tokens.cacheRead),
    cacheWrite: total((tokens) => tokens.cacheWrite),
    modelCalls: sessions.reduce((sum, session) => sum + session.tokens.modelCalls, 0),
    usd,
  }
}

let th: TokenHome
let fx: FixtureHome
beforeAll(async () => {
  ;[th, fx] = await Promise.all([makeTokenHome(), makeFixtureHome()])
})

describe('facts tokens against the raw records', () => {
  it('Claude Code: input is the whole prompt, each response counted once, priced by priceTokens', async () => {
    const oracle = await jq(CLAUDE_ORACLE, th.claude) as { input: number; output: number; cacheRead: number; cacheWrite: number }
    // 3+1,000+200, 5+1,300+50 and 2+1,400: the repeated record of msg_1 and the
    // zero-usage <synthetic> notice add nothing.
    expect(oracle).toEqual({ input: 3_960, output: 75, cacheRead: 3_700, cacheWrite: 250 })
    for (const ref of [th.claude, TOKEN_IDS.claude, TOKEN_IDS.claude.slice(0, 8)]) {
      const [session] = (await facts([ref], th.env)).sessions
      expect(session!.tokens).toMatchObject({ ...oracle, reasoning: null, modelCalls: 3, unavailable: null })
      expect(session!.tokens.byModel).toEqual([{ model: 'claude-opus-5-5', ...oracle }])
      expect(session!.tokenTotal.value).toBe(oracle.input + oracle.output)
      const usd = priceTokens({
        model: 'claude-opus-5-5', inputTokens: oracle.input, outputTokens: oracle.output, cacheReadTokens: oracle.cacheRead, cacheWriteTokens: oracle.cacheWrite,
      })
      expect(usd).toBeGreaterThan(0)
      expect(session!.cost).toMatchObject({ label: 'list price (Router rates)', unavailable: null })
      expect(session!.cost.usd).toBeCloseTo(usd!, 6)
    }
  })

  it('Codex: input is its own cumulative input_tokens, the repeated counter counted once', async () => {
    const oracle = await jq(CODEX_ORACLE, th.codex) as { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }
    expect(oracle).toEqual({ input: 2_700, output: 70, cacheRead: 2_100, cacheWrite: 0, reasoning: 22 })
    const [session] = (await facts([th.codex], th.env)).sessions
    expect(session!.tokens).toMatchObject({ ...oracle, modelCalls: 2, unavailable: null })
    expect(session!.tokenTotal.value).toBe(2_770)
    const usd = priceTokens({ model: 'gpt-6.1-sol', inputTokens: oracle.input, outputTokens: oracle.output, cacheReadTokens: oracle.cacheRead })
    expect(session!.cost.usd).toBeCloseTo(usd!, 6)
  })

  it('states unknown tokens as null with the reason, and a cost it cannot price as null with the reason', async () => {
    const [noUsage] = (await facts([IDS.codex], fx.env)).sessions
    expect(noUsage!.tokens).toMatchObject({ input: null, output: null, modelCalls: 0 })
    expect(noUsage!.tokens.unavailable).toMatch(/reports token usage/u)
    expect(noUsage!.tokenTotal).toMatchObject({ value: null, unavailable: noUsage!.tokens.unavailable })
    expect(noUsage!.cost).toMatchObject({ usd: null })
    expect(noUsage!.cost.unavailable).toMatch(/^no token counts/u)

    const dir = await mkdtemp(join(tmpdir(), 'traces-unpriced-'))
    const path = join(dir, `${TOKEN_IDS.claude}.jsonl`)
    await writeFile(path, claudeTokensTranscript(TOKEN_IDS.claude, dir).replaceAll('claude-opus-5-5', 'claude-unpriced-0-1'))
    const [unpriced] = (await facts([path, '--harness', 'claude-code'], th.env)).sessions
    expect(unpriced!.tokens.input).toBe(3_960)
    expect(unpriced!.cost.usd).toBeNull()
    expect(unpriced!.cost.unavailable).toBe('the Router lists no price for claude-unpriced-0-1')
  })
})

describe('one subagent definition', () => {
  it('counts one subagent per spawn record, on Claude Code and Codex', async () => {
    const [claude] = (await facts([th.claude], th.env)).sessions
    expect(claude!.subagents.value).toHaveLength(await jq(CLAUDE_SPAWNS, th.claude) as number)
    expect(claude!.subagents.value).toHaveLength(1)
    const [parent] = (await facts([fx.paths.parent], fx.env)).sessions
    expect(parent!.subagents.value).toHaveLength(await jq(CODEX_SPAWNS, fx.paths.parent) as number)
    expect(parent!.subagents.value).toHaveLength(2)
  })
})

describe('analyze renders the tokens and cost facts owns', () => {
  it.each(['claude', 'codex'] as const)('%s: the same tokens and cost', async (harness) => {
    const [session] = (await facts([th[harness]], th.env)).sessions
    const shown = await analyzeUsage([th[harness]], th.env)
    expect(shown).toEqual({
      input: session!.tokens.input,
      output: session!.tokens.output,
      cacheRead: session!.tokens.cacheRead,
      cacheWrite: session!.tokens.cacheWrite,
      modelCalls: session!.tokens.modelCalls,
      usd: session!.cost.usd,
    })
  })

  it('a session and its children: the sum of the sessions facts lists', async () => {
    const { sessions } = await facts([IDS.parent], fx.env)
    expect(sessions).toHaveLength(3)
    const shown = await analyzeUsage([IDS.parent], fx.env)
    const measured = sessions.filter((session) => session.tokens.input !== null)
    expect(shown.input).toBe(measured.reduce((total, session) => total + session.tokens.input!, 0))
    expect(shown.output).toBe(measured.reduce((total, session) => total + session.tokens.output!, 0))
    expect(shown.usd).toBeNull()
  })
})

describe('compact JSON', () => {
  // 6,500 bytes, not the spec's first 6,000: both Codex read paths now name a command that checks
  // work exec_command.verify, so this fixture's sheet has one more measurements.tools row (6,204
  // bytes; 5,867 before). No redundant field of a tool row buys the row back: dropping `calls`
  // leaves 6,164, dropping each measure's `eligible` 6,048. The `commands` fact adds 201 bytes
  // (6,405), its rows already without span ids.
  it('keeps the sheet of the 13-span fixture within 6,500 bytes, with no n = 1 distribution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-facts-size-'))
    const path = join(dir, `${FIXTURE_SESSION_ID}.jsonl`)
    await writeFile(path, `${fixtureRecords().map((record) => JSON.stringify(record)).join('\n')}\n`)
    const run = await runCli(['facts', path, '--harness', 'codex', '--format', 'json'], { env: th.env })
    expect(run.code).toBe(0)
    const report = JSON.parse(run.stdout) as { spanCount: number }
    expect(report.spanCount).toBe(13)
    expect(Buffer.byteLength(run.stdout)).toBeLessThanOrEqual(6_500)
    expect(run.stdout).not.toMatch(/"p50"|"p95"|"durationMs"/u)
  })
})

/**
 * agent-runtime's package root, where `priceTokens` lives, loads about 700
 * modules (0.3 s or more). Only a sheet with tokens to price may load it; the
 * preload `fixtures/import-log.mjs` records every module the spawned CLI resolves.
 */
describe('the price table loads only to price a sheet', () => {
  const hook = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'import-log.mjs')).href

  async function loadsPrices(argv: readonly string[], env: Readonly<Record<string, string>>): Promise<boolean> {
    const log = join(await mkdtemp(join(tmpdir(), 'traces-imports-')), 'imports.log')
    const run = await runCli(argv, { env: { ...env, TRACES_IMPORT_LOG: log, NODE_OPTIONS: `--import ${hook}` } })
    expect(run.code, run.stderr).toBe(0)
    const urls = (await readFile(log, 'utf8')).split('\n')
    expect(urls.length).toBeGreaterThan(100)
    return urls.some((url) => url.endsWith('/agent-runtime/dist/index.js'))
  }

  it('never for list, --match, jsonl rows or a session with no usage; for a sheet with tokens to price', async () => {
    expect(await loadsPrices(['list', '--last', '50', '--format', 'json'], fx.env)).toBe(false)
    expect(await loadsPrices(['facts', '--since', '2026-10-01T00:00:00Z', '--match', 'build', '--format', 'json'], fx.env)).toBe(false)
    expect(await loadsPrices(['facts', IDS.claude, '--format', 'jsonl'], fx.env)).toBe(false)
    expect(await loadsPrices(['facts', IDS.codex, '--format', 'json'], fx.env)).toBe(false)
    expect(await loadsPrices(['facts', IDS.claude, '--format', 'json'], fx.env)).toBe(true)
  })
})
