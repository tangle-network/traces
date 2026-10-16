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

  it('still runs the 0.21.1 argv until the command table replaces it', async () => {
    const events = join(dir, 'events-0.21.otlp.jsonl')
    expect((await runCli(['convert', sandboxEvents, '--format', 'sandbox-events', '--otlp-out', events], { env })).code).toBe(0)
    expect((await spans(events)).length).toBeGreaterThanOrEqual(1)

    const live = join(dir, 'live-0.21.otlp.jsonl')
    expect((await runCli(['convert', '--harness', 'codex-exec', '--session', liveStream, '--otlp-out', live], { env })).code).toBe(0)
    const current = join(dir, 'live-1.0.otlp.jsonl')
    expect((await runCli(['convert', liveStream, '--harness', 'codex-exec', '--out', current], { env })).code).toBe(0)
    expect(await toolSpans(live)).toBe(await toolSpans(current))
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
})
