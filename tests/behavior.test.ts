/**
 * `traces behavior` on a three-node cut of run magnetar-rust-sandbox-20261101e (the M9 producer: one
 * contract trace per node): the root, its proof-size child s2, and the grandchild s2:s0 whose `cargo test`
 * failed four times in a row. Outputs and span text were trimmed to fit; every span, time, command, file
 * change and worker id is the producer's own.
 */
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { behaviorFromSpans, renderBehaviorText, type BehaviorResult } from '../src/behavior.js'
import { readOtlpInput } from '../src/otlp-input.js'
import { runCli } from './run-cli.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'behavior')
/** A Codex lane on drew-gtr-pro (2026-11-05) and the reviewer it forked with spawn_agent, redacted to ids, times, calls and token counts. */
const FORK = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-fork-child')
const [PARENT, CHILD] = ['01a1adf8-1ee5-76e3-b687-b8f3a93dc9dc', '01a1adfb-472d-7c51-b3ea-e009327df975']
const ROOT = 'magnetar-rust-sandbox-20261101e'
const S2 = `${ROOT}:s2`
const LOOPER = `${ROOT}:s2:s0`
const FLAG_KINDS = ['check_edit', 'test_delete', 'test_edited_to_pass', 'verification_capped', 'claim_without_reading']

let dir: string
let env: Record<string, string>
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'traces-behavior-'))
  env = { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') }
})

/** A span row as the producer writes it. */
const row = (name: string, kind: string, spanId: string, extra: Record<string, unknown> = {}): string => JSON.stringify({
  trace_id: 'a1b2c3d4e5f60718a1b2c3d4e5f60718', span_id: spanId, parent_span_id: spanId === '0000000000000001' ? null : '0000000000000001', name, kind,
  start_time: '2026-11-01T16:00:00.000Z', end_time: '2026-11-01T16:01:00.000Z', status: { code: 'STATUS_CODE_OK' },
  attributes: { 'session.id': 'x', 'openinference.span.kind': kind, ...extra },
})

describe('traces behavior', () => {
  it('through the module: three nodes, the s2:s0 streak as a looping window, idle windows, steers with read latency, the calibration table', async () => {
    const input = await readOtlpInput(FIXTURE)
    const result = behaviorFromSpans(input.spans)
    expect(result.policy).toEqual({ id: 'dl-ui-behavior-windows', version: 1, window_s: 300 })
    expect(result.nodes.map((n) => n.id).sort()).toEqual([ROOT, S2, LOOPER])
    expect(result.nodes).toHaveLength(input.spans.filter((s) => s.name === 'session').length)
    for (const n of result.nodes) {
      expect(n.tool_calls).toBeGreaterThan(0)
      expect(n.z).toHaveProperty('calls_per_hour')
    }

    // The 4-run failing streak of one cargo test command makes its window looping, an uncalibrated class.
    const windowOf = (at: number): number => Math.floor((at - result.run.t0) / result.policy.window_s)
    const streak = result.streaks.find((s) => s.node === LOOPER)
    expect(streak).toMatchObject({ runs: 4 })
    expect(streak!.spans).toHaveLength(4)
    const looping = result.windows.find((w) => w.node === LOOPER && w.w === windowOf(streak!.at!))
    expect(looping).toMatchObject({ category: 'looping', calibrated: false })
    expect(looping!.span_ids.length).toBeGreaterThan(0)

    // Hand-checked windows; w counts five-minute windows from the run start (16:28:32Z).
    const category = (node: string, w: number): string | undefined => result.windows.find((x) => x.node === node && x.w === w)?.category
    expect(category(LOOPER, 2)).toBe('exploring') // ~190 s of cat, sed, rg and knowledge reads against a 40 s prompt
    expect(category(LOOPER, 3)).toBe('implementing') // file_change spans at 16:45:52, 16:47:10 and 16:47:49: a code edit wins the window
    expect(category(ROOT, 1)).toBe('verifying') // python3 scripts/check-release-baseline.py at 16:38:06 and no edit in the window
    expect(category(S2, 13)).toBe('idle') // inside the 17:33:24 to 17:49:30 gap after the commit's 15-minute cap
    expect(category(S2, 28)).toBe('reviewing') // read_journal at 18:48:45 explains 41 s; the steers and knowledge_record 35 s

    // A gap of ten minutes or more is an idle window (a calibrated class) and a stall after a named span.
    const idle = result.windows.filter((w) => w.category === 'idle')
    expect(idle.length).toBeGreaterThanOrEqual(1)
    expect(idle.every((w) => w.calibrated)).toBe(true)
    expect(result.stalls.length).toBeGreaterThanOrEqual(1)
    expect(result.stalls.every((s) => s.minutes >= 10 && s.after.length > 0)).toBe(true)

    // The root's steers name their recipients; the one to s2 was read at s2's next model turn, 4.9 minutes later.
    const steers = result.mail.edges.filter((e) => e.kind === 'steer_agent' && e.from === ROOT)
    expect(steers.length).toBeGreaterThanOrEqual(2)
    for (const e of steers) expect(e.to).toMatch(new RegExp(`^${ROOT}:s`))
    expect(steers.find((e) => e.to === S2)?.read_latency_min).toBe(4.9)
    expect(result.mail.summary.steers).toBe(result.mail.edges.filter((e) => e.kind === 'steer_agent').length)

    expect(result.calibration.policy).toBe('dl-ui-behavior-windows@1')
    expect(result.calibration.implementing.calibrated).toBe(true)
    expect(result.calibration.looping.calibrated).toBe(false)
    expect(result.windows.find((w) => w.category === 'implementing')?.calibrated).toBe(true)
    for (const flag of result.flags) expect(FLAG_KINDS).toContain(flag.kind)
    expect(renderBehaviorText(result).split('\n')[0]).toBe(`behavior dl-ui-behavior-windows@1, window 5m, 3 nodes, ${result.run.n_windows} windows, 2026-11-01T16:28:32Z to 2026-11-01T19:05:26Z`)
  })

  it('through the CLI: JSON and text on the fixture, exit 2 with one {error, code} object when no span is a tool call', async () => {
    const json = await runCli(['behavior', FIXTURE, '--format', 'json'], { env })
    expect(json.stderr).toBe('')
    expect(json.code).toBe(0)
    const parsed = JSON.parse(json.stdout) as { nodes: unknown[]; policy: { window_s: number }; streaks: { node: string }[]; windows: { category: string; calibrated: boolean }[] }
    expect(parsed.nodes).toHaveLength(3)
    expect(parsed.policy.window_s).toBe(300)
    expect(parsed.streaks.map((s) => s.node)).toEqual([LOOPER])
    expect(parsed.windows.some((w) => w.category === 'looping' && !w.calibrated)).toBe(true)

    const text = await runCli(['behavior', FIXTURE, '--window', '10m'], { env })
    expect(text.code).toBe(0)
    const lines = text.stdout.trimEnd().split('\n')
    expect(lines[0]).toMatch(/^behavior dl-ui-behavior-windows@1, window 10m, 3 nodes, /)
    expect(lines.length).toBeLessThanOrEqual(40)
    expect(text.stdout).toContain(`streak ${LOOPER} 4x failed at 16:51`)
    expect(text.stdout).toContain('flags (uncalibrated, record only): 3')
    expect(text.stdout).toContain('looping uncalibrated (n=0)')

    const file = join(dir, 'llm-only.otlp.jsonl')
    await writeFile(file, `${[row('session', 'AGENT', '0000000000000001'), row('llm.turn', 'LLM', '0000000000000002'), row('llm.turn', 'LLM', '0000000000000003')].join('\n')}\n`, 'utf8')
    const refused = await runCli(['behavior', file, '--format', 'json'], { env })
    expect(refused.code).toBe(2)
    expect(refused.stdout).toBe('')
    expect(JSON.parse(refused.stderr)).toEqual({ error: 'no tool spans; categories unavailable', code: 'no-outcome' })
    const refusedText = await runCli(['behavior', file], { env })
    expect(refusedText.code).toBe(2)
    expect(refusedText.stderr.trim()).toBe('error: no tool spans; categories unavailable')
  })

  it('a forked Codex child is its own node under its parent, with its own calls, harness and model; a --since sweep, read a session at a time, answers what the two read together answer', async () => {
    const home = join(dir, 'codex-home')
    await mkdir(join(home, '.codex', 'sessions', '2026', '11', '05'), { recursive: true })
    for (const [name, id] of [['parent', PARENT], ['child', CHILD]] as const) await copyFile(join(FORK, `${name}.jsonl`), join(home, '.codex', 'sessions', '2026', '11', '05', `rollout-${id}.jsonl`))
    const codexEnv = { HOME: home, XDG_STATE_HOME: join(dir, 'codex-state') }
    const facts = async (id: string) => (JSON.parse((await runCli(['facts', id, '--format', 'json'], { env: codexEnv })).stdout) as { sessions: Array<{ sessionId: string; harness: string; toolCalls: { value: number }; tokens: { byModel: Array<{ model: string }> } }> }).sessions.find((s) => s.sessionId === id)!
    const [parentFacts, childFacts] = [await facts(PARENT), await facts(CHILD)]
    const swept = await runCli(['behavior', '--since', '2026-11-05T00:00:00Z', '--format', 'json'], { env: codexEnv })
    expect(swept.code, swept.stderr).toBe(0)
    const result = JSON.parse(swept.stdout) as BehaviorResult
    // Read alone, the child's reader writes a lifecycle span for the parent it answered: a node with no calls, until 2.0.14.
    expect(result.nodes).toHaveLength(2)
    const [parent, child] = [result.nodes.find((n) => n.parent === null)!, result.nodes.find((n) => n.parent !== null)!]
    expect(child).toMatchObject({ parent: parent.id, depth: 1, tool_calls: childFacts.toolCalls.value })
    expect(child.tool_calls).toBeGreaterThan(0)
    expect(parent.tool_calls).toBe(parentFacts.toolCalls.value)
    for (const node of [parent, child]) expect(node).toMatchObject({ harness: childFacts.harness, model: childFacts.tokens.byModel[0]!.model })
    expect(result.mail.edges.map((e) => [e.kind, e.from, e.to])).toEqual(expect.arrayContaining([['spawn_agent', parent.id, 'review_env_scope'], ['send_message', child.id, '/root']]))
    const named = await runCli(['behavior', PARENT, CHILD, '--format', 'json'], { env: codexEnv })
    const canonical = (text: string): string => JSON.stringify(JSON.parse(text), (_, v: unknown) =>
      (Array.isArray(v) ? v.map((x) => JSON.stringify(x)).sort() : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort()) : v))
    expect(canonical(named.stdout)).toBe(canonical(swept.stdout))
  })
})
