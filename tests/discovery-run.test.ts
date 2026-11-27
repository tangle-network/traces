/**
 * A stopped Discovery run read by its id: what its agents did beside the run's own records, which say
 * who stopped it and why, how far its checks got, and how long each agent and the root stream had been
 * quiet when it stopped. Asked on a host that does not hold the run, the command runs on one that does.
 *
 * The fixtures are open-research runs stopped on drew-gtr-pro in November 2026. Runtime's journal,
 * result and cancel records are kept whole but for error stacks; the lifecycle, check and settle records
 * are cut to the fields traces reads; the root stream keeps its last three events without payloads; and
 * each agent keeps its session spans and last 60 others, with no tool input, output, status message or
 * message text. Each operator's free-text reason is replaced by a neutral line; the spend-cap
 * controller's reason and the checkers' output are verbatim.
 * - claim-queens-cube-20261117a: stopped by its spend cap, two submissions, each failing the claim stage.
 * - claim-apn-flat-balance-20261117a: Runtime settled it on its deadline before the operator's request came.
 * - record-kissing-number-d11-605-20261116a: stopped when the root's stream went quiet; its root still acted after.
 * - co-snarks-rescue-witness-20261114a: stopped 52 seconds after its press, before any tool call.
 * - discovery-run-reopened/claim-apn-flat-balance-20261117a: the same apn run ten days later, reopened by an
 *   operator, its cancel request and Runtime result set aside, and running again; its root stream keeps the
 *   last three events before the reopen as well as its last three.
 * - discovery-run-reopened/record-kissing-number-d11-605-20261116a: the kissing run reopened ten days later
 *   and stopped again a minute after by its spend cap, which counted the first generation's spend; its root
 *   never acted in the second generation, and its settle check could not start.
 * - discovery-run-live/procedure-census-20261127a: a run read while it ran, before any settle exported its
 *   agents' sessions; its root's live stream records the Sandbox dropping events when its buffer overflowed.
 * - discovery-run-live/record-kissing-number-d11-605-20261116a: the kissing run's journal and live stream with
 *   no exported sessions, as it stood before its settle, with its five workers.
 *   Each live stream keeps the newest copy of each message part and the stream's overflow counts; reply,
 *   reasoning and tool output text is replaced, and a tool input keeps only paths, patterns and a shell
 *   command's first 160 characters.
 */
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { CLI, runCli } from './run-cli.js'

const RUNS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'discovery-run')
const REOPENED = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'discovery-run-reopened')
const LIVE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'discovery-run-live')
const CENSUS = 'procedure-census-20261127a'
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
    // A node the journal never settled ends with the run, not when the command ran.
    expect(record.endedAt).toBe('2026-11-17T02:11:54.352Z')
    for (const node of result.nodes as Array<{ end: number }>) expect(node.end).toBeLessThanOrEqual(Date.parse(record.endedAt) / 1000)

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

  it('reads a reopened run up to its reopen: the stop that ended it, the progress then, and what came after', async () => {
    const at = { env: { ...env, TRACES_RUN_ROOTS: REOPENED } }
    const json = await runCli(['behavior', APN, '--format', 'json'], at)
    expect(json.code, json.stderr).toBe(0)
    const result = JSON.parse(json.stdout)
    const record = result.run_record
    const reopenedAt = '2026-11-27T08:26:44.347Z'
    expect(record.reopens).toEqual([{ at: reopenedAt, operator: 'value-audit', reason: 'operator choice: continue after the stop (fixture text)' }])
    expect(record.stop).toMatchObject({
      requestedAt: '2026-11-17T04:26:38.001Z',
      from: 'cancellations/reopened/disco-reopen-claim-apn-flat-balance-20261117a-1/disco-cancel-a0c8e370-776b-42df-a85d-a84e469b831c/run.request.json',
    })
    expect(record.stops).toHaveLength(1)
    // The reopen set Runtime's result aside; the stopped generation's result is read from there.
    expect(record.runtime).toMatchObject({ kind: 'no-winner', reason: 'deadline', settledAt: '2026-11-17T04:20:50.739Z' })
    expect(record.stoppedAt).toEqual({ at: '2026-11-17T04:16:44.271Z', what: 'settle record' })
    expect(record.endedAt).toBeNull()
    expect(record.state).toMatchObject({ value: 'open' })
    expect(Date.parse(record.rootStream.lastAt)).toBeLessThan(Date.parse(reopenedAt))
    for (const quiet of record.quiet as Quiet[]) {
      if (quiet.lastActivity !== null) expect(Date.parse(quiet.lastActivity)).toBeLessThan(Date.parse(reopenedAt))
    }

    const text = await runCli(['behavior', APN], at)
    expect(text.code, text.stderr).toBe(0)
    const lines = text.stdout.split('\n')
    expect(lines[0]).toMatch(new RegExp(`^run ${APN}: pressed 2026-11-17 00:59Z; Runtime settled 04:20Z no-winner/deadline; settle record 2026-11-17 04:16Z .*; now open since 2026-11-27 08:2\\dZ$`, 'u'))
    expect(lines[1]).toMatch(/^stop: requested 2026-11-17 04:26Z by /u)
    expect(text.stdout).toContain('  the request came 5.8m after Runtime had settled the run (deadline)')
    expect(text.stdout).toContain('progress at stop: 3 check(s), 2 submission(s); last 2026-11-17 04:21Z settle: reached 1 of 3 (claim, checker, novelty) on 4aa3a81; failed claim: no claim.json.md page was delivered')
    expect(text.stdout).toContain('reopened 2026-11-27 08:26Z by value-audit: operator choice: continue after the stop (fixture text)')
    expect(text.stdout).toMatch(/^ {2}since: \d+ check\(s\), [1-9]\d* submission\(s\); last 2026-11-27 /mu)
    expect(text.stdout.indexOf('progress at stop')).toBeLessThan(text.stdout.indexOf('reopened 2026-11-27'))
  }, 120_000)

  it('reads each generation of a run reopened and stopped again: the first stop on a line, the second in full', async () => {
    const at = { env: { ...env, TRACES_RUN_ROOTS: REOPENED } }
    const json = await runCli(['behavior', KISSING, '--format', 'json'], at)
    expect(json.code, json.stderr).toBe(0)
    const record = JSON.parse(json.stdout).run_record
    expect(record.generations.map((g: { generation: number; stop: { source: string } | null }) => [g.generation, g.stop?.source])).toEqual([
      [1, 'discovery-lab/operator'], [2, 'discovery-lab/spend-cap'],
    ])
    // The first generation's Runtime result was set aside by the reopen; the second's is the run's result.
    expect(record.generations[0].runtime).toEqual({ kind: 'no-winner', reason: 'cancelled', settledAt: '2026-11-17T02:11:54.352Z' })
    expect(record.generations[0].submissions).toHaveLength(2)
    expect(record.generations[1]).toMatchObject({ startedAt: '2026-11-27T08:56:01.277Z', submissions: [], stoppedAt: { at: '2026-11-27T08:57:29.152Z', what: 'stop request' } })
    expect(record.stop).toMatchObject({ source: 'discovery-lab/spend-cap', from: 'cancellations/run.request.json' })
    expect(record.endedAt).toBe('2026-11-27T08:58:22.035Z')

    const text = await runCli(['behavior', KISSING], at)
    expect(text.code, text.stderr).toBe(0)
    const lines = text.stdout.split('\n')
    expect(lines[0]).toMatch(/; now settling since 2026-11-27 08:58Z$/u)
    expect(lines[1]).toBe(
      "generation 1, pressed 2026-11-16 22:40Z: stop requested 2026-11-17 01:53Z by discovery-lab/operator (operator op-research:boards-vs-world): operator choice: the root's turn stream went silent (fixture text);" +
      ' 3 check(s), 2 submission(s); last 2026-11-17 02:18Z settle: reached 1 of 1 (certificate) on ddb1d5e; failed: invalid construction: supply construction.json or construction.json.gz;' +
      ' Runtime settled 2026-11-17 02:11Z no-winner/cancelled; root stream last event 2026-11-17 00:10Z',
    )
    expect(lines[2]).toBe('generation 2: reopened 2026-11-27 08:56Z by value-audit: operator choice: continue after the stop (fixture text)')
    expect(lines[3]).toBe("stop: requested 2026-11-27 08:57Z by discovery-lab/spend-cap (operator discovery-lab): operator choice: the play's registered Sandbox cap: $2.61 billed against $1.80 (Platform ledger, read at 2026-11-27T08:56:32.567Z)")
    expect(text.stdout).toMatch(/^quiet before the stop request 08:57Z: root \[[a-z]+\] no act since the reopen \(last act 2026-11-17 02:08Z\);.* Runtime root stream: no event since the reopen \(last event 2026-11-17 00:10Z tool_result, seq 21177\)$/mu)
    expect(text.stdout).toContain("failed: the check could not start: the check's declared interpreter /home/lab/")
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

/** Each node's tool calls as its live stream recorded them: one per message part, failed when the part did. */
async function streamedCalls(run: string): Promise<Map<string, { calls: number; failed: number }>> {
  const base = join(LIVE, run, 'evidence', 'live-stream')
  const out = new Map<string, { calls: number; failed: number }>()
  for (const folder of (await readdir(base)).filter((name) => name !== 'state.json')) {
    const parts = new Map<string, string>()
    for (const file of await readdir(join(base, folder))) {
      for (const line of (await readFile(join(base, folder, file), 'utf8')).split('\n').filter(Boolean)) {
        const part = JSON.parse(line).data?.part
        if (part?.type === 'tool') parts.set(`${part.messageID}:${part.id}`, part.state?.status)
      }
    }
    out.set(decodeURIComponent(folder), { calls: parts.size, failed: [...parts.values()].filter((status) => status === 'failed' || status === 'error').length })
  }
  return out
}

describe('a Discovery run whose sessions are not exported yet', () => {
  interface LiveNode { id: string; label: string; parent: string | null; state: string | null; tool_calls: number; failed: number; end: number }
  const live = () => ({ HOME: env.HOME!, XDG_STATE_HOME: env.XDG_STATE_HOME!, TRACES_RUN_ROOTS: LIVE })

  it('reads a running run from its live stream: the root\'s tool calls, its open state, and the events the stream dropped', async () => {
    const json = await runCli(['behavior', CENSUS, '--format', 'json'], { env: live() })
    expect(json.code, json.stderr).toBe(0)
    const result = JSON.parse(json.stdout)
    const streamed = (await streamedCalls(CENSUS)).get(CENSUS)!
    expect(streamed.calls).toBeGreaterThan(0)
    const nodes = result.nodes as LiveNode[]
    expect(nodes).toHaveLength(1)
    const root = nodes[0]!
    expect(root).toMatchObject({ id: 'ses_de3d4440bffe1yDixdggIbw5SX', label: 'root', parent: null, tool_calls: streamed.calls, failed: streamed.failed })
    // A running agent's record runs at least to the stream's last write, and not to when the command ran.
    const state = JSON.parse(await readFile(join(LIVE, CENSUS, 'evidence', 'live-stream', 'state.json'), 'utf8'))
    expect(root.end).toBeGreaterThanOrEqual(Date.parse(state.at) / 1000)
    expect(root.end).toBeLessThan(Date.parse('2026-11-27T12:00:00Z') / 1000)
    expect(result.run_record).toMatchObject({ runId: CENSUS, stop: null, endedAt: null })
    expect(result.coverage.unknowns).toEqual(expect.arrayContaining([
      'live stream: tool calls, no model calls until the sessions are exported',
      'root: live stream dropped 724 events; its tool calls are a lower bound',
    ]))

    const facts = JSON.parse((await runCli(['facts', CENSUS, '--format', 'json'], { env: live() })).stdout)
    expect(facts.sessions.map((session: { sessionId: string; toolCalls: { value: number } }) => [session.sessionId, session.toolCalls.value]))
      .toEqual([['ses_de3d4440bffe1yDixdggIbw5SX', streamed.calls]])
    const text = await runCli(['behavior', CENSUS], { env: live() })
    expect(text.code, text.stderr).toBe(0)
    expect(text.stdout).toMatch(new RegExp(`^root \\(ses_de3d4440bffe1yDixdggIbw5SX\\) \\S+ glm-5\\.3: .*\\| ${streamed.calls} calls, ${streamed.failed} failed`, 'mu'))
  }, 120_000)

  it('reads every worker from its live stream under the root that spawned it, as complete as each stream is', async () => {
    const json = await runCli(['behavior', KISSING, '--format', 'json'], { env: live() })
    expect(json.code, json.stderr).toBe(0)
    const nodes = JSON.parse(json.stdout).nodes as LiveNode[]
    const streamed = await streamedCalls(KISSING)
    const root = nodes.find((node) => node.label === 'root')!
    expect(root.id).toBe('ses_e197ab5f2ffeeM5SqRyzOZOAku')
    const byLabel = Object.fromEntries(nodes.map((node) => [node.label, node]))
    expect(Object.keys(byLabel).sort()).toEqual(['anneal-smooth', 'cluster-opt', 'communicator-r1', 'perturb-relax', 'root', 'slp-newton'])
    for (const [label, worker] of [['communicator-r1', 's0'], ['perturb-relax', 's1'], ['anneal-smooth', 's2'], ['slp-newton', 's3'], ['cluster-opt', 's4']] as const) {
      const node = byLabel[label]!
      expect(node.parent, label).toBe(root.id)
      expect({ calls: node.tool_calls, failed: node.failed }, label).toEqual(streamed.get(`${KISSING}:${worker}`))
    }
    // A complete stream reads as the exported session did: traces 4.0.4 read communicator-r1's export as 23 calls, 3 failed.
    expect(byLabel['communicator-r1']).toMatchObject({ state: 'done', tool_calls: 23, failed: 3 })
    const unknowns = JSON.parse(json.stdout).coverage.unknowns as string[]
    expect(unknowns).toEqual(expect.arrayContaining([
      'slp-newton: live stream dropped 23295 events; its tool calls are a lower bound',
      'cluster-opt: live stream dropped 298 events; its tool calls are a lower bound',
    ]))
    expect(unknowns.some((line) => line.startsWith('communicator-r1:'))).toBe(false)
  }, 120_000)
})
