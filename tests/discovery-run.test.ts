/**
 * A stopped Discovery run read by its id: what its agents did beside the run's own records, which say
 * who stopped it and why, how far its checks got, and how long each agent and the root stream had been
 * quiet when it stopped. Asked on a host that does not hold the run, the command runs on one that does.
 *
 * The fixtures are four open-research runs stopped on drew-gtr-pro in November 2026. Runtime's journal,
 * result and cancel records are kept whole but for error stacks; the lifecycle, check and settle records
 * are cut to the fields traces reads; the root stream keeps its last three events without payloads; and
 * each agent keeps its session spans and last 60 others, with no tool input, output, status message or
 * message text. Each operator's free-text reason is replaced by a neutral line; the spend-cap
 * controller's reason and the checkers' output are verbatim.
 * - claim-queens-cube-20261117a: stopped by its spend cap, two submissions, each failing the claim stage.
 * - claim-apn-flat-balance-20261117a: Runtime settled it on its deadline before the operator's request came.
 * - record-kissing-number-d11-605-20261116a: stopped when the root's stream went quiet; its root still acted after.
 * - co-snarks-rescue-witness-20261114a: stopped 52 seconds after its press, before any tool call.
 */
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { CLI, runCli } from './run-cli.js'

const RUNS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'discovery-run')
const QUEENS = 'claim-queens-cube-20261117a'
const APN = 'claim-apn-flat-balance-20261117a'
const KISSING = 'record-kissing-number-d11-605-20261116a'
const SNARKS = 'co-snarks-rescue-witness-20261114a'

interface Quiet { node: string; label: string; lastActivity: string | null; minutesBeforeStop: number | null }

let dir: string
let env: Record<string, string>
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'traces-discovery-run-'))
  await mkdir(join(dir, 'home'), { recursive: true })
  env = { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state'), TRACES_RUN_ROOTS: RUNS }
})

describe('a Discovery run by its id', () => {
  it('says who stopped it and why, how far its checks got, and that its root kept acting after its stream went quiet', async () => {
    const json = await runCli(['behavior', KISSING, '--format', 'json'], { env })
    expect(json.code, json.stderr).toBe(0)
    const result = JSON.parse(json.stdout)
    const record = result.run_record
    expect(record.stop).toMatchObject({
      requestedAt: '2026-11-17T01:53:54.016Z', source: 'discovery-lab/operator', operator: 'op-research:boards-vs-world',
      reason: "operator choice: the root's turn stream went silent (fixture text)", from: 'cancellations/run.request.json',
      applied: { observedAt: '2026-11-17T02:10:54.245Z', path: 'observer', effect: 'unknown' },
    })
    expect(record.runtime).toMatchObject({ kind: 'no-winner', reason: 'cancelled', settledAt: '2026-11-17T02:11:54.352Z' })
    expect(record.rootStream).toEqual({ lastAt: '2026-11-17T00:10:53.221Z', lastSeq: 21177, lastKind: 'tool_result' })
    expect(record.submissions.map((s: { entity: string }) => s.entity)).toEqual(['rc1', 'rc2'])
    expect(record.checks.at(-1)).toMatchObject({
      kind: 'settle', solved: false, reached: 1, of: 1, stages: ['certificate'], commit: expect.stringMatching(/^ddb1d5e/u),
      reason: 'invalid construction: supply construction.json or construction.json.gz',
    })
    expect(record.settle).toMatchObject({ status: 'stopped', wallMs: 12608547, tokens: { status: 'lower-bound', floor: 2090525 }, usdBasis: 'subscription' })
    // The relay went quiet 103 minutes before the request; an agent's own spans continue past it.
    const quiet = record.quiet as Quiet[]
    expect(quiet.length).toBe(result.nodes.length)
    const latest = quiet.reduce((a, b) => ((a.minutesBeforeStop ?? Infinity) <= (b.minutesBeforeStop ?? Infinity) ? a : b))
    expect(latest.lastActivity).toBe('2026-11-17T02:08:01.924Z')
    expect(latest.minutesBeforeStop).toBe(-14.1)

    const text = await runCli(['behavior', KISSING], { env })
    expect(text.code, text.stderr).toBe(0)
    const lines = text.stdout.split('\n')
    expect(lines[0]).toBe(`run ${KISSING}: pressed 2026-11-16 22:40Z; Runtime settled 02:11Z no-winner/cancelled; settle record 2026-11-17 02:11Z stopped`)
    expect(lines[1]).toBe("stop: requested 2026-11-17 01:53Z by discovery-lab/operator (operator op-research:boards-vs-world): operator choice: the root's turn stream went silent (fixture text)")
    expect(text.stdout).toContain('progress at stop: 3 check(s), 2 submission(s); last 2026-11-17 02:18Z settle: reached 1 of 1 (certificate) on ddb1d5e; failed: invalid construction')
    expect(text.stdout).toContain('Runtime root stream 103m (last event 00:10Z tool_result, seq 21177)')
    expect(text.stdout).toMatch(/quiet before the stop request 01:53Z: .*14\.1m after it \(last act 02:08Z\)/u)
    expect(text.stdout).toContain('settle record: wall 3.5 h · tokens at least 2.09M')
    expect(text.stdout).toMatch(/^behavior dl-ui-behavior-windows@1, window 5m, /mu)

    const analyzed = await runCli(['analyze', KISSING], { env })
    expect(analyzed.code, analyzed.stderr).toBe(0)
    expect(analyzed.stdout.indexOf(`# Run record — ${KISSING}`)).toBe(0)
    expect(analyzed.stdout).toContain(`# Run report — ${KISSING}`)
    expect(analyzed.stdout).toContain(lines[1])
  }, 120_000)

  it('names a spend-cap stop and its claim failures, and a request that came after Runtime had settled the run', async () => {
    const queens = await runCli(['facts', QUEENS], { env })
    expect(queens.code, queens.stderr).toBe(0)
    expect(queens.stdout).toContain("stop: requested 2026-11-17 04:12Z by discovery-lab/spend-cap (operator discovery-lab): operator choice: the play's registered Sandbox cap: $0.50 billed against $0.50")
    expect(queens.stdout).toContain('Runtime acknowledged it 04:43Z via fallback after 8.3s (effect unknown: run aborted but teardown remains unconfirmed')
    expect(queens.stdout).toContain('last 2026-11-17 04:44Z settle: reached 1 of 3 (claim, checker, novelty) on d4cabc7; failed claim: claim.json.md holds no fenced block')
    const facts = JSON.parse((await runCli(['facts', QUEENS, '--format', 'json'], { env })).stdout)
    expect(facts.runRecord.checks.map((check: { kind: string; failedStage: string }) => [check.kind, check.failedStage])).toEqual([['submission', 'claim'], ['submission', 'claim'], ['settle', 'claim']])
    expect(facts.sessions.length).toBeGreaterThan(0)

    const apn = await runCli(['behavior', APN], { env })
    expect(apn.code, apn.stderr).toBe(0)
    expect(apn.stdout).toContain('Runtime settled 04:20Z no-winner/deadline')
    expect(apn.stdout).toContain('  Runtime recorded no acknowledgement of the request')
    expect(apn.stdout).toContain('  the request came 5.8m after Runtime had settled the run (deadline)')
    expect(apn.stdout).toContain('quiet before the settle record 04:16Z')
  }, 120_000)

  it('answers with the run record when no agent made a tool call', async () => {
    const json = await runCli(['behavior', SNARKS, '--format', 'json'], { env })
    expect(json.code, json.stderr).toBe(0)
    const result = JSON.parse(json.stdout)
    expect(result.categories).toBeNull()
    expect(result.reason).toBe('no tool spans; categories unavailable')
    expect(result.run_record.stop).toMatchObject({ requestedAt: '2026-11-14T03:25:11.908Z', operator: 'crypto-repro', applied: { effect: 'cancelled', path: 'observer' } })
    expect(result.run_record.checks).toEqual([expect.objectContaining({ kind: 'settle', solved: false, reason: 'no pages: the settled run wrote nothing to its Knowledge store' })])
    const text = await runCli(['behavior', SNARKS], { env })
    expect(text.code, text.stderr).toBe(0)
    expect(text.stdout).toContain('behavior: categories unavailable: no tool spans; categories unavailable')
    expect(text.stdout).toContain('settle record: wall 43 s · tokens unknown: Runtime reports the usage unknown · compute $0.0024 (free) · opencode/glm-5.3-flash-free (free)')
  }, 120_000)

  it('runs on the remote that holds the run, skipping one without traces, and says when none holds it', async () => {
    // A fake ssh runs the remote command here, as the named host's login shell would, with that host's HOME and run roots.
    const hosts = join(dir, 'hosts')
    const ssh = join(dir, 'fake-ssh')
    await writeFile(ssh, [
      '#!/bin/sh',
      'while [ "$1" = -o ]; do shift 2; done',
      'host="$1"; shift',
      `[ -d "${hosts}/$host" ] || { echo "ssh: Could not resolve hostname $host" >&2; exit 255; }`,
      `HOME="${hosts}/$host" PATH=/usr/bin:/bin TRACES_RUN_ROOTS="$(cat "${hosts}/$host/run-roots" 2>/dev/null)" exec /bin/sh -c "$*"`,
      '',
    ].join('\n'))
    await chmod(ssh, 0o755)
    await mkdir(join(hosts, 'bare'), { recursive: true })
    await mkdir(join(hosts, 'lab', '.local', 'bin'), { recursive: true })
    await writeFile(join(hosts, 'lab', 'run-roots'), RUNS)
    await writeFile(join(hosts, 'lab', '.local', 'bin', 'traces'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`)
    await chmod(join(hosts, 'lab', '.local', 'bin', 'traces'), 0o755)
    const laptop = { HOME: env.HOME!, XDG_STATE_HOME: env.XDG_STATE_HOME!, TRACES_SSH: ssh, TRACES_REMOTES: 'bare,lab' }

    const here = await runCli(['behavior', KISSING, '--format', 'json'], { env })
    const there = await runCli(['behavior', KISSING, '--format', 'json'], { env: laptop })
    expect(there.code, there.stderr).toBe(0)
    expect(JSON.parse(there.stdout).run_record).toEqual(JSON.parse(here.stdout).run_record)

    const written = await runCli(['facts', KISSING, '--out', join(dir, 'out')], { env: laptop })
    expect(written.code).toBe(2)
    expect(written.stderr).toContain('--out writes here: run the command on the host that holds it (bare, lab)')

    const unknown = await runCli(['facts', 'record-nothing-by-this-name-20261116a', '--format', 'json'], { env: { ...laptop, TRACES_REMOTES: 'bare,lab,gone' } })
    expect(unknown.code).toBe(2)
    expect(unknown.stdout).toBe('')
    const error = JSON.parse(unknown.stderr.trim().split('\n').at(-1)!)
    expect(error.code).toBe('unreadable')
    expect(error.error).toContain('asked bare, lab, gone: no answer from bare (traces is not installed on')
    expect(error.error).toContain('gone (ssh: Could not resolve hostname gone)')
  }, 180_000)
})
