/**
 * `traces analyze` text, through the built CLI: at most 40 lines, answer
 * first, in the spec's fixed order (§2.2), every number the facts sheet's. The
 * false positives 0.23.1 printed are planted and must not come back: a HIGH
 * "session identity" finding on traces' own reads, corrections built from
 * injected turns, one-tool and no-check findings on short runs, durations in
 * milliseconds, the `@otlp` model suffix, and a `gh`-only review called a
 * repeated verification.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { makeAnalyzeHome, REVIEW_ID, toolRunSession, WORKER_ID, type AnalyzeHome } from './fixtures/analyze.js'
import { runCli } from './run-cli.js'

interface Finding {
  severity: string
  subject?: string
  claim: string
  area: string
  metadata?: { spanIds?: string[] }
}

interface Analysis {
  packet: { findings: Finding[] }
  cannotAnswer: Array<{ analysis: string; reason: string }>
}

let fx: AnalyzeHome
beforeAll(async () => {
  fx = await makeAnalyzeHome()
})

async function analyze(argv: readonly string[]): Promise<string> {
  const run = await runCli(['analyze', ...argv], { env: fx.env })
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return run.stdout
}

async function analysis(argv: readonly string[]): Promise<Analysis> {
  return JSON.parse(await analyze([...argv, '--format', 'json'])) as Analysis
}

const subjects = (result: Analysis) => result.packet.findings.map((finding) => finding.subject)

describe('one session, answer first', () => {
  it('fits 40 lines, in the fixed order, with every section the session supports', async () => {
    const text = await analyze([fx.worker])
    const lines = text.trimEnd().split('\n')
    expect(lines.length).toBeLessThanOrEqual(40)
    expect(lines[0]).toMatch(/^a11a1a11 claude-code · analyzed-repo · 10-14 10:00→10-16 10:29 UTC, 48h 29m · active /u)
    expect(lines[0]).toMatch(/ · \$[\d.]+ list price \(Router rates\)$/u)
    const order = [
      'asked "Fix the failing parser test." (+2 more human turns)',
      'first failure ',
      'failing commands 1: `pnpm test` 3× in a row (5 min, 10:01, span ',
      'tool errors 3/',
      'stalls 1 ≥ 10 min',
      'Interrupts and rejections: 1 turn after an interrupt',
      '  10:09 after an interrupt: "stop, run the tests before you say done"',
      'PRs opened 1 (#12)',
      'findings ',
      'cannot answer ',
    ]
    let previous = -1
    for (const line of order) {
      const index = text.indexOf(line)
      expect(index, line).toBeGreaterThan(previous)
      previous = index
    }
  })

  it('prints nothing it cannot support: no "unavailable", no milliseconds, no @otlp, no zero for an unknown', async () => {
    const text = await analyze([fx.worker])
    const json = await analyze([fx.worker, '--format', 'json'])
    expect(text).not.toContain('unavailable')
    expect(text).not.toMatch(/\d ?ms\b/u)
    expect(`${text}${json}`).not.toContain('@otlp')
  })

  it('calls the turns after an interrupt, a rejected tool or a claim what they are, never corrections', async () => {
    const text = await analyze([fx.worker])
    expect(text).toContain('Interrupts and rejections: ')
    expect(text).not.toMatch(/correct/iu)
    // The background notice says "no, stop, that is wrong": it is harness text, not a person.
    expect(text).not.toContain('that is wrong')
    expect(JSON.stringify((await analysis([fx.worker])).packet)).not.toMatch(/correct|reaction/iu)
  })

  it('ranks findings HIGH first, with the span ids facts names, and no session-identity finding on its own reads', async () => {
    const result = await analysis([fx.worker])
    const facts = JSON.parse((await runCli(['facts', fx.worker, '--format', 'json'], { env: fx.env })).stdout) as {
      sessions: Array<{ measurements: { waste: { failingStreaks: { value: Array<{ spanIds: string[] }> } } } }>
    }
    const streak = facts.sessions[0]!.measurements.waste.failingStreaks.value[0]!
    const [first] = result.packet.findings
    expect(first).toMatchObject({ severity: 'high', subject: 'same-failing-command' })
    expect(first!.metadata?.spanIds).toEqual(streak.spanIds)
    expect(subjects(result)).toContain('verification-without-change')
    // A claim after an edit with no check since held 0 of 9 on real sessions, and no stricter claim rule
    // found one in 44 (traces 1.0 step 14): it is neither a finding nor a section.
    expect(subjects(result)).not.toContain('completion-claim-without-verification')
    expect(await analyze([fx.worker])).not.toContain('unverified claims')
    expect(result.packet.findings.map((finding) => finding.area)).not.toContain('instrumentation')
    expect(JSON.stringify(result)).not.toContain('stable session identity')
    const text = await analyze([fx.worker])
    expect(text).toContain(`  HIGH same-failing-command: \`pnpm test\` failed 3× in a row (5 min). (spans ${streak.spanIds.slice(0, 2).join(', ')}, …)`)
  })
})

describe('watch and analyze share one rule set', () => {
  it('stream replays the findings analyze ranks, with the same spans', async () => {
    const run = await runCli(['stream', fx.worker, '--mode', 'findings'], { env: fx.env })
    expect(run.code).toBe(0)
    const live = run.stdout.trim().split('\n').map((line) => JSON.parse(line) as { event: string; finding?: { ruleId: string; evidence: Array<{ spanIds?: string[] }> } })
      .flatMap((event) => (event.finding ? [event.finding] : []))
    const ranked = (await analysis([fx.worker])).packet.findings.filter((finding) => finding.metadata?.spanIds !== undefined)
    expect(live.map((finding) => finding.ruleId).sort()).toEqual(ranked.map((finding) => finding.subject).sort())
    const streak = live.find((finding) => finding.ruleId === 'same-failing-command')!
    expect(streak.evidence[0]!.spanIds).toEqual(ranked.find((finding) => finding.subject === 'same-failing-command')!.metadata!.spanIds)
  })

  it('a command that failed twice is no streak and no finding: one definition, facts\' 3 in a row', async () => {
    const twice = (await import('./fixtures/analyze.js')).workerSession().filter((row) => !JSON.stringify(row).includes('"t3"'))
    const result = await analysis([await fx.file(`${WORKER_ID}.jsonl`, twice)])
    expect(subjects(result)).not.toContain('same-failing-command')
  })
})

describe('false positives 0.23.1 printed', () => {
  it('a gh-only pull-request review is not a repeated verification', async () => {
    const result = await analysis([fx.review])
    expect(subjects(result)).not.toContain('verification-without-change')
  })

  it('no one-tool or no-check finding on a run under 10 tool calls', async () => {
    const result = await analysis([await fx.file('c0ffee01-0000-4000-8000-000000000001.jsonl', toolRunSession('c0ffee01-0000-4000-8000-000000000001', 'Bash', 5, false))])
    expect(subjects(result)).not.toContain('single-tool-dependency')
    expect(subjects(result)).not.toContain('no-self-verification')
  })

  it('no one-tool finding on a shell, and no no-check finding on a run whose commands ran a check', async () => {
    const result = await analysis([await fx.file('c0ffee02-0000-4000-8000-000000000002.jsonl', toolRunSession('c0ffee02-0000-4000-8000-000000000002', 'Bash', 12, true))])
    expect(subjects(result)).not.toContain('single-tool-dependency')
    expect(subjects(result)).not.toContain('no-self-verification')
  })

  it('still names a 12-call run of one non-shell tool with no check; the no-check finding at its measured LOW', async () => {
    const result = await analysis([await fx.file('c0ffee03-0000-4000-8000-000000000003.jsonl', toolRunSession('c0ffee03-0000-4000-8000-000000000003', 'WebFetch', 12, false))])
    const bySubject = new Map(result.packet.findings.map((finding) => [finding.subject, finding.severity]))
    expect(bySubject.get('single-tool-dependency')).toBe('medium')
    expect(bySubject.get('no-self-verification')).toBe('low')
  })
})

describe('several sessions', () => {
  it('a window prints the fleet header and a table of the sessions with the most waste', async () => {
    const text = await analyze(['--since', '2026-10-01T00:00:00Z'])
    const lines = text.trimEnd().split('\n')
    expect(lines.length).toBeLessThanOrEqual(40)
    expect(lines[0]).toMatch(/^2 sessions \(claude-code 2\) · 10-14 10:00→10-16 10:29 UTC, 48h 29m · \$[\d.]+ list price \(Router rates\) · waste 0\.\d h · 1 interrupt$/u)
    expect(lines[1]).toMatch(/^session +harness +repo +active +cost +waste +streaks +stalls +signals +PRs +asked$/u)
    // The worker wasted more: it is first.
    expect(lines[2]).toMatch(new RegExp(`^${WORKER_ID.slice(0, 8)} claude-code`, 'u'))
    expect(lines[3]).toMatch(new RegExp(`^${REVIEW_ID.slice(0, 8)} claude-code`, 'u'))
    expect(text).toMatch(new RegExp(`^ {2}HIGH ${WORKER_ID.slice(0, 8)} same-failing-command: `, 'mu'))
  })
})
