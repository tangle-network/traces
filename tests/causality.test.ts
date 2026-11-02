/**
 * Steering and rounds through the CLI, on real spans: the root and one worker of a Discovery run
 * (magnetar-rust-sandbox-20261101d) as its producer exports them from the kept Codex sessions, cut to the
 * session roots, the rounds, every span a link points at and the producer's own records, long strings
 * dropped. A round is the prompt that opened it (`agent.loop.iteration`, `agent.loop.id` the node); a steer is
 * what a round's `steered_by` link points at (the parent's code-mode call that sent it, or a Lab steer
 * request); the worker's session is `spawned_by` the parent's call that started it.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runCli } from './run-cli.js'

const RUN = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'causality', 'magnetar-rust-sandbox-20261101d.jsonl')
const ROOT = 'magnetar-rust-sandbox-20261101d'

describe('traces analyze: what caused what', () => {
  it('rows each steer to the round it caused, and each loop round to round', async () => {
    const { stdout, code } = await runCli(['analyze', RUN, '--format', 'json'])
    expect(code).toBe(0)
    const result = JSON.parse(stdout)
    const { links, steering, rounds } = result.measures.causality
    expect(links).toEqual({ steered_by: { total: 12, resolved: 12 }, spawned_by: { total: 1, resolved: 1 } })
    expect([steering.steers, steering.turns, steering.changes]).toEqual([12, 9, { improved: 0, held: 8, regressed: 0, unscored: 1 }])
    // The root's script at 09:59:05 steered four leads; s1's second round, 6.7 minutes later, acted on its line.
    expect(steering.rows[0]).toMatchObject({
      cause: { name: 'tool.exec', at: '2026-11-01T09:59:05.053Z' },
      effect: { name: 'user.prompt', loopId: `${ROOT}:s1`, iteration: 2, outcome: 'fail', at: '2026-11-01T10:05:47.709Z' },
      lagMs: 402_656,
      change: 'held',
    })
    expect(rounds).toMatchObject({ loops: 2, rounds: 20, outcomes: { pass: 1, fail: 18, error: 0, unscored: 1 }, transitions: { improved: 1, held: 16, regressed: 0 }, converged: 1 })
    expect(rounds.rows.map((row: { loopId: string; outcomes: string }) => [row.loopId, row.outcomes.length])).toEqual([[`${ROOT}:s1`, 13], [ROOT, 7]])
    for (const analysis of ['steering-chain', 'loop-convergence']) {
      expect(result.cannotAnswer.map((entry: { analysis: string }) => entry.analysis.split(':')[0])).not.toContain(analysis)
    }
  })

  it('prints the steering and rounds lines, and the steering table in report.md', async () => {
    const { stdout } = await runCli(['analyze', RUN])
    expect(stdout).toMatch(/^steering 12 steers caused 9 turns \(12\/12 links resolved, median lag [\d.]+ min\); against the round before: 0 improved, 8 held, 0 regressed, 1 unscored$/mu)
    expect(stdout).toMatch(/^rounds 20 over 2 loops \(1 pass, 18 fail, 0 error, 1 unscored\); round to round 1 improved, 16 held, 0 regressed; 1 loops reached pass$/mu)
    expect(stdout).toMatch(/^links spawned_by 1\/1 resolved$/mu)
    const out = await mkdtemp(join(tmpdir(), 'traces-causality-'))
    await runCli(['analyze', RUN, '--out', out])
    const report = await readFile(join(out, 'report.md'), 'utf8')
    expect(report).toContain('## Steering (12 of 12 links resolved)')
    expect(report).toMatch(/\| `[0-9a-f-]+` tool\.exec \| `[0-9a-f-]+` user\.prompt round 2 \(fail\) \| 6\.7 min \| held \|/u)
  })
})
