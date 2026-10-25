/**
 * The operating measures, through the built CLI: each session's
 * `facts.measurements` (context per model call, reply latency by context band,
 * guard refusals, a limit stop) and their pool in analyze's
 * `measures.operating`. A sweep (`--since`) reads one session at a time and
 * must report what reading the same sessions together reports.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { task, userItem, writeRollout } from './codex-facts-fixture.js'
import { jsonl } from './fixtures/analyze.js'
import { runCli } from './run-cli.js'

const REPO = '/w/operating-repo'
const START = Date.parse('2026-10-14T10:00:00.000Z')
const at = (second: number): string => new Date(START + second * 1000).toISOString()
const LIMITED = 'c33c3c33-cccc-4ccc-8ccc-cccccccccccc'
const QUOTING = 'd44d4d44-dddd-4ddd-8ddd-dddddddddddd'
const NOTICE = "You've hit your weekly limit · resets Oct 27 at 11am (America/Los_Angeles)"

type Row = Record<string, unknown>

function records(sessionId: string) {
  let n = 0
  const base = { sessionId, cwd: REPO, version: '2.1.0', gitBranch: 'main' }
  const user = (time: string, content: unknown): Row =>
    ({ ...base, type: 'user', uuid: `u${++n}`, parentUuid: null, timestamp: time, message: { role: 'user', content } })
  /** A model call that read `context` tokens: 1,000 fresh, the rest from the cache, a fifth of it written. */
  const reply = (time: string, context: number, content: unknown[], model = 'claude-opus-5-5'): Row => ({
    ...base, type: 'assistant', uuid: `a${++n}`, parentUuid: null, timestamp: time,
    message: {
      id: `msg-${n}`, role: 'assistant', model, content,
      usage: context === 0
        ? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        : { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: ((context - 1000) / 5) * 4, cache_creation_input_tokens: (context - 1000) / 5 },
    },
  })
  const result = (time: string, id: string, text: string, isError = false): Row =>
    user(time, [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }])
  const bash = (id: string, command: string): unknown[] => [{ type: 'tool_use', id, name: 'Bash', input: { command } }]
  return { user, reply, result, bash }
}

/**
 * Four model calls at 201k, 250k, 260k and 950k tokens. The second and third
 * answer a tool result after 3 s and 4 s (the 200-300k band), the fourth after
 * 5 s. A guard refuses the first command. The last reply is the weekly limit
 * notice, and the run ends in an error.
 */
function limitedSession(): Row[] {
  const { user, reply, result, bash } = records(LIMITED)
  return [
    user(at(0), 'Ship the fix.'),
    reply(at(1), 201_000, bash('b1', 'gh pr checks 12 --watch')),
    result(at(10), 'b1', 'PreToolUse:Bash hook error: ci-wait-guard: do not wait on PR CI.', true),
    reply(at(13), 250_000, bash('b2', 'git status')),
    result(at(20), 'b2', 'clean'),
    reply(at(24), 260_000, bash('b3', 'git push')),
    result(at(30), 'b3', 'pushed'),
    reply(at(35), 950_000, [{ type: 'text', text: 'Pushed.' }]),
    reply(at(40), 0, [{ type: 'text', text: NOTICE }], '<synthetic>'),
    { type: 'result', subtype: 'success', is_error: true, result: NOTICE, session_id: LIMITED, timestamp: at(41) },
  ]
}

/** One model call whose reply quotes a limit notice in a longer answer: not a limit stop. */
function quotingSession(): Row[] {
  const { user, reply } = records(QUOTING)
  return [
    user(at(0), 'Why did the lane stop?'),
    reply(at(2), 40_000, [{ type: 'text', text: `The lane stopped because its account printed "${NOTICE}", so the next turn waits for the reset.` }]),
  ]
}

interface Measurements {
  modelCalls: { calls: number; contextTokens: { mean: number | null; p50?: number }; latencyByContext: unknown[] }
  guardRefusals: { refusals: number; byGuard: Record<string, number>; spanIds: string[] }
  limitStop: { kind: string; text: string | null; at: string; spanId: string } | null
}
interface Analysis {
  facts: { sessions: Array<{ sessionId: string; toolCalls: { value: number }; measurements: Measurements }> }
  measures: { operating: unknown }
}

let home: string
let env: Record<string, string>
let files: { limited: string; quoting: string }
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'traces-operating-'))
  home = join(dir, 'home')
  const project = join(home, '.claude', 'projects', REPO.replaceAll('/', '-'))
  await mkdir(project, { recursive: true })
  files = { limited: join(project, `${LIMITED}.jsonl`), quoting: join(project, `${QUOTING}.jsonl`) }
  await writeFile(files.limited, jsonl(limitedSession()))
  await writeFile(files.quoting, jsonl(quotingSession()))
  env = { HOME: home, XDG_STATE_HOME: join(dir, 'state') }
})

async function analyze(args: string[]): Promise<Analysis> {
  const run = await runCli(['analyze', ...args, '--harness', 'claude-code', '--format', 'json'], { env })
  expect(run.code, run.stderr).toBe(0)
  return JSON.parse(run.stdout) as Analysis
}

const sheet = (analysis: Analysis, id: string) => analysis.facts.sessions.find((session) => session.sessionId === id)!

describe('operating measures', () => {
  it('each sheet states its context per call, reply latency by band, guard refusals and limit stop', async () => {
    const analysis = await analyze([files.limited, files.quoting])
    const limited = sheet(analysis, LIMITED).measurements
    // The <synthetic> notice used no tokens: it is not a model call.
    expect(limited.modelCalls).toEqual({
      calls: 4,
      contextTokens: { mean: (201_000 + 250_000 + 260_000 + 950_000) / 4, p50: 260_000 },
      // The 900k+ band holds one reply: one value is not a distribution.
      latencyByContext: [{ band: '200-300k', calls: 2, p50Ms: 4000, p90Ms: 4000 }],
    })
    expect(limited.guardRefusals).toMatchObject({ refusals: 1, byGuard: { 'ci-wait-guard': 1 } })
    expect(limited.guardRefusals.spanIds).toHaveLength(1)
    expect(limited.limitStop).toMatchObject({ kind: 'weekly', text: NOTICE, at: at(40) })

    const quoting = sheet(analysis, QUOTING).measurements
    expect(quoting.modelCalls).toEqual({ calls: 1, contextTokens: { mean: 40_000 }, latencyByContext: [] })
    expect(quoting.limitStop).toBeNull()
  })

  it('analyze pools them: rates per 1,000 of the sessions\' tool calls, and the terminal failures that are limit stops', async () => {
    const analysis = await analyze([files.limited, files.quoting])
    expect(sheet(analysis, LIMITED).toolCalls.value).toBe(3)
    expect(analysis.measures.operating).toEqual({
      modelCalls: {
        calls: 5,
        contextTokens: { mean: (201_000 + 250_000 + 260_000 + 950_000 + 40_000) / 5, p50: 250_000 },
        latencyByContext: [{ band: '200-300k', calls: 2, p50Ms: 4000, p90Ms: 4000 }],
      },
      guardRefusals: { toolCalls: 3, refusals: 1, perThousandCalls: 333.33, byGuard: [{ guard: 'ci-wait-guard', refusals: 1, perThousandCalls: 333.33 }] },
      limitStops: { sessions: 1, byKind: { weekly: 1 }, terminalFailures: 1, terminalFailuresAtLimit: 1 },
    })
  })

  it('a --since sweep, read one session at a time, reports what the sessions read together report', async () => {
    const together = await analyze([files.limited, files.quoting])
    const swept = await analyze(['--since', '2026-10-01T00:00:00Z'])
    expect(swept.measures.operating).toEqual(together.measures.operating)
    for (const id of [LIMITED, QUOTING]) expect(sheet(swept, id).measurements).toEqual(sheet(together, id).measurements)
  })

  it('--no-content keeps the limit stop and withholds its text', async () => {
    const run = await runCli(['facts', files.limited, '--harness', 'claude-code', '--no-content', '--format', 'json'], { env })
    expect(run.code, run.stderr).toBe(0)
    const facts = JSON.parse(run.stdout) as Analysis['facts']
    expect(facts.sessions[0]!.measurements.limitStop).toMatchObject({ kind: 'weekly', text: null })
    expect(run.stdout).not.toContain('resets Oct 27')
  })

  it('a Codex task that completed with the usage-limit error is a terminal failure and a limit stop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-operating-codex-'))
    const ref = writeRollout(dir, 'limited-codex', [
      { t: 0, type: 'session_meta', payload: { id: 'limited-codex', cwd: '/workspace/demo' } },
      { t: 0.5, type: 'turn_context', payload: { cwd: '/workspace/demo', model: 'gpt-fixture' } },
      userItem(0.6, [{ type: 'input_text', text: 'Ship the fix.' }]),
      task(1, 'task_started', 'turn-1'),
      { t: 2, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: null, error: { message: 'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.' } } },
    ])
    const run = await runCli(['analyze', ref.path, '--harness', 'codex', '--format', 'json'], { env })
    expect(run.code, run.stderr).toBe(0)
    const analysis = JSON.parse(run.stdout) as Analysis & { measures: { failureClusters: { totalFailures: number } } }
    expect(analysis.measures.failureClusters.totalFailures).toBe(1)
    expect(analysis.facts.sessions[0]!.measurements.limitStop).toMatchObject({ kind: 'usage', at: expect.any(String) })
    expect(analysis.measures.operating).toMatchObject({ limitStops: { sessions: 1, byKind: { usage: 1 }, terminalFailures: 1, terminalFailuresAtLimit: 1 } })
  })
})
