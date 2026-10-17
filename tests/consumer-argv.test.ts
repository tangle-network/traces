/**
 * The argv shapes other repositories run, spawned against the built CLI. A
 * change that breaks one of these breaks that consumer when it bumps traces.
 *
 * Discovery (discovery-lab `runner/trace-review.mjs`) converts every Sandbox
 * live stream that carries a `"backend":"codex"` envelope with `--harness
 * codex-exec`, and every other sandbox recording as sandbox events, then asks
 * its question bank of the converted directory and reads `answers.json`
 * whatever the exit code.
 *
 * tangle-tools `fleet/recurrence.py` reads one session's facts as JSON from
 * stdout (`facts P --harness H --format json`); `tests/facts-json-contract.test.ts`
 * pins the paths it reads.
 *
 * Each consumer's pinned 0.x argv exits 2 and prints its 1.0 spelling, which
 * is the edit the consumer makes when it bumps.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { ASK_KEY, startEndpoint, writeAskSession, writeStubBridge } from './fixtures/ask.js'
import { IDS, makeFixtureHome } from './fixtures/home.js'
import { runCli } from './run-cli.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sandbox-live-stream')
const liveStream = join(fixtures, 'codex-director-in-progress.jsonl')
const sandboxEvents = join(fixtures, 'sandbox-refused-before-codex.jsonl')

let dir: string
let env: Record<string, string>
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'traces-consumer-argv-'))
  // An empty home: a file ref reads no harness store.
  env = { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') }
})

async function spans(path: string): Promise<Array<{ attributes: Record<string, unknown> }>> {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

const toolSpans = async (path: string): Promise<number> =>
  (await spans(path)).filter((span) => span.attributes['openinference.span.kind'] === 'TOOL').length

describe('Discovery convert argv', () => {
  it('converts a Codex live stream with --harness codex-exec, and sniffs the same file without it', async () => {
    const forced = join(dir, 'forced.otlp.jsonl')
    const run = await runCli(['convert', liveStream, '--harness', 'codex-exec', '--out', forced], { env })
    expect(run.code).toBe(0)
    const tools = await toolSpans(forced)
    expect(tools).toBeGreaterThanOrEqual(1)

    const sniffed = join(dir, 'sniffed.otlp.jsonl')
    expect((await runCli(['convert', liveStream, '--out', sniffed], { env })).code).toBe(0)
    expect(await toolSpans(sniffed)).toBe(tools)
  })

  it('converts a sandbox-events recording with no --format', async () => {
    const out = join(dir, 'events.otlp.jsonl')
    const run = await runCli(['convert', sandboxEvents, '--out', out], { env })
    expect(run.code).toBe(0)
    expect((await spans(out)).length).toBeGreaterThanOrEqual(1)
  })

  it('refuses the 0.21.1 argv, printing the 1.0 argv that replaces it, which runs', async () => {
    const events = join(dir, 'events-0.21.otlp.jsonl')
    const live = join(dir, 'live-0.21.otlp.jsonl')
    for (const [argv, rewritten] of [
      [['convert', sandboxEvents, '--format', 'sandbox-events', '--otlp-out', events], ['convert', sandboxEvents, '--out', events]],
      [['convert', '--harness', 'codex-exec', '--session', liveStream, '--otlp-out', live], ['convert', liveStream, '--harness', 'codex-exec', '--out', live]],
    ] as const) {
      const refused = await runCli(argv, { env })
      expect(refused.code).toBe(2)
      expect(refused.stdout).toBe('')
      expect(refused.stderr).toContain(`Instead: traces ${rewritten.join(' ')}`)
      expect((await runCli(rewritten, { env })).code).toBe(0)
    }
    expect((await spans(events)).length).toBeGreaterThanOrEqual(1)
    expect(await toolSpans(live)).toBeGreaterThanOrEqual(1)
  })
})

describe('Discovery ask argv', () => {
  it('asks its question bank of the converted directory and writes answers.json and report.md under --out', async () => {
    const D = join(dir, 'review')
    const session = await writeAskSession(join(D, 'otlp'), 'node-1')
    const Q = join(dir, 'questions.json')
    await writeFile(Q, JSON.stringify([
      { id: 'dsc.E3', question: 'Which command failed first?', answerSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { id: 'dsc.F1', question: 'Did the run verify its result?' },
    ]), 'utf8')
    const bridge = await writeStubBridge(join(dir, 'bridge'), [
      { match: 'failed first', answer: '{"command": "bash"}' },
      { match: 'verify', answer: `No: the bash call failed (trace://${session.traceId}/span/${session.toolSpanId}).` },
    ])
    const endpoint = await startEndpoint(['ok'])
    try {
      const askEnv = { ...env, TANGLE_API_KEY: ASK_KEY, OPENAI_BASE_URL: endpoint.baseUrl, TRACES_PYTHON: bridge.path }
      const argv = ['ask', join(D, 'otlp'), '--questions', Q, '--model', 'zai/glm-5.3', '--budget', '18.5', '--out', D]
      const run = await runCli(argv, { env: askEnv, timeoutMs: 120_000 })
      expect(run.code, run.stderr).toBe(0)
      const answers = JSON.parse(await readFile(join(D, 'answers.json'), 'utf8')) as {
        engine: { model: string }
        questionBudgetUsd: number
        questionTimeoutMs: number
        concurrency: number
        questions: Array<{ id: string; status: string; parsedAnswer?: unknown }>
      }
      expect(answers).toMatchObject({ engine: { model: 'zai/glm-5.3' }, questionBudgetUsd: 2, questionTimeoutMs: 1_800_000, concurrency: 4 })
      expect(answers.questions.map((answer) => [answer.id, answer.status])).toEqual([['dsc.E3', 'answered'], ['dsc.F1', 'answered']])
      expect(answers.questions[0]!.parsedAnswer).toEqual({ command: 'bash' })
      expect(await readFile(join(D, 'report.md'), 'utf8')).toContain('## dsc.F1: Did the run verify its result?')

      // The 0.21.1 argv names the 1.0 argv, whose removed flags are its defaults.
      const old = await runCli([
        'ask', '--otlp', join(D, 'otlp'), '--questions', Q, '--model', 'zai/glm-5.3', '--budget', '18.5',
        '--question-budget', '2', '--question-timeout', '1800', '--concurrency', '4', '--dir', D,
      ], { env: askEnv })
      expect(old.code).toBe(2)
      expect(old.stdout).toBe('')
      expect(old.stderr).toContain(`Instead: traces ${argv.join(' ')}`)
    } finally {
      await endpoint.close()
    }
  }, 120_000)
})

describe('recurrence facts argv', () => {
  it('reads a Codex session file with --harness codex, the named session first', async () => {
    const fx = await makeFixtureHome()
    const run = await runCli(['facts', fx.paths.parent, '--harness', 'codex', '--format', 'json'], { env: fx.env })
    expect(run.code).toBe(0)
    const report = JSON.parse(run.stdout.slice(run.stdout.indexOf('{'))) as { sessions: Array<{ sessionId: string }> }
    expect(report.sessions[0]!.sessionId).toBe(IDS.parent)
  })

  it('refuses the 0.16.4 argv, printing the 1.0 argv that replaces it', async () => {
    const fx = await makeFixtureHome()
    const run = await runCli(['facts', '--harness', 'codex', '--session', fx.paths.parent, '--format', 'json'], { env: fx.env })
    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
    // An error under --format json is one JSON object on stderr: recurrence parses stdout, never this.
    const error = JSON.parse(run.stderr) as { error: string; code: string }
    expect(error.code).toBe('usage')
    expect(error.error).toContain(`Instead: traces facts ${fx.paths.parent} --harness codex --format json`)
  })
})
