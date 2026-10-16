/**
 * The argv shapes other repositories run, spawned against the built CLI. A
 * change that breaks one of these breaks that consumer when it bumps traces.
 *
 * Discovery (discovery-lab `runner/trace-review.mjs`) converts every Sandbox
 * live stream that carries a `"backend":"codex"` envelope with `--harness
 * codex-exec`, and every other sandbox recording as sandbox events.
 *
 * tangle-tools `fleet/recurrence.py` reads one session's facts as JSON from
 * stdout (`facts P --harness H --format json`); `tests/facts-json-contract.test.ts`
 * pins the paths it reads.
 *
 * Each consumer's pinned 0.x argv exits 2 and prints its 1.0 spelling, which
 * is the edit the consumer makes when it bumps.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
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
