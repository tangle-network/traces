/**
 * `traces watch` through the built CLI: the rules `analyze` ranks, over live
 * sessions, as one text line per finding or as the `traces.stream` events. The
 * clock is faked (`fixtures/clock.mjs`), the one boundary a live loop needs:
 * it stands still for exact output, or jumps between passes so a second pass
 * runs at once.
 */
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { streamSessions, type TraceLiveAnalyst, type TraceStreamEvent } from '../src/index.js'
import { ghReviewSession, jsonl, REPO, REVIEW_ID, WORKER_ID, workerSession } from './fixtures/analyze.js'
import { claudeTranscript } from './fixtures/home.js'
import { fakeClock, runCli, runCliUntil } from './run-cli.js'

const NOW = '2026-10-16T10:40:00.000Z'
const minutesBefore = (minutes: number): Date => new Date(Date.parse(NOW) - minutes * 60_000)

interface Home {
  readonly root: string
  readonly home: string
  readonly env: Record<string, string>
}

/** A HOME holding Claude Code sessions, each file's mtime `minutes` before NOW. */
async function homeWith(sessions: ReadonlyArray<{ id: string; text: string; minutes: number; project?: string }>): Promise<Home & { paths: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'traces-watch-'))
  const home = join(root, 'home')
  const paths: string[] = []
  for (const { id, text, minutes, project = REPO } of sessions) {
    const path = join(home, '.claude', 'projects', project.replaceAll('/', '-'), `${id}.jsonl`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
    await utimes(path, minutesBefore(minutes), minutesBefore(minutes))
    paths.push(path)
  }
  return { root, home, env: { HOME: home, XDG_STATE_HOME: join(root, 'state') }, paths }
}

const events = (stdout: string): TraceStreamEvent[] => stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as TraceStreamEvent)
const ticks = (stdout: string): number => (stdout.match(/"event":"tick"/gu) ?? []).length

let fx: Home & { paths: string[] }
beforeAll(async () => {
  fx = await homeWith([
    { id: WORKER_ID, text: jsonl(workerSession()), minutes: 2 },
    { id: REVIEW_ID, text: jsonl(ghReviewSession()), minutes: 4 },
  ])
})

describe('traces watch, one pass', () => {
  it('prints one line per finding of a named session, then what it read', async () => {
    const run = await runCli(['watch', fx.paths[0]!, '--once'], { env: { ...fx.env, ...fakeClock(NOW) } })
    expect(run.code, run.stderr).toBe(0)
    expect(run.stderr).toBe('')
    const lines = run.stdout.trimEnd().split('\n')
    expect(lines[0]).toMatch(/^10:40:00 HIGH a11a1a11 claude-code same-failing-command: `pnpm test` failed 3× in a row \(5 min\)\. \(spans \S+, \S+, …\)$/u)
    expect(lines[1]).toMatch(/^10:40:00 MED a11a1a11 claude-code verification-without-change: `pnpm test` ran 3× with no edit between\. \(spans /u)
    expect(lines[2]).toMatch(/^10:40:00 MED a11a1a11 claude-code high-tool-error-rate: 3\/6 tool call\(s\) ended with ERROR\. \(spans /u)
    expect(lines.slice(3)).toEqual(['1 named session: 1 session read · 3 findings'])
  })

  it('reads every session active in the window by default, and none older', async () => {
    const stale = await homeWith([
      { id: WORKER_ID, text: jsonl(workerSession()), minutes: 45 },
      { id: REVIEW_ID, text: jsonl(ghReviewSession()), minutes: 4 },
    ])
    const recent = await runCli(['watch', '--once'], { env: { ...fx.env, ...fakeClock(NOW) } })
    expect(recent.stdout.trimEnd().split('\n').at(-1)).toBe('every session active in the last 30m: 2 sessions read · 3 findings')
    const one = await runCli(['watch', '--once', '--format', 'jsonl'], { env: { ...stale.env, ...fakeClock(NOW) } })
    expect(events(one.stdout).flatMap((event) => (event.event === 'session' ? [event.session.sessionId] : []))).toEqual([REVIEW_ID])
    const wider = await runCli(['watch', '--once', '--since', '1h', '--format', 'jsonl'], { env: { ...stale.env, ...fakeClock(NOW) } })
    expect(events(wider.stdout).filter((event) => event.event === 'session')).toHaveLength(2)
  })

  it('reads the sessions of a store root', async () => {
    const run = await runCli(['watch', fx.home, '--once', '--format', 'jsonl'], { env: { HOME: join(fx.root, 'elsewhere'), ...fakeClock(NOW) } })
    expect(run.code, run.stderr).toBe(0)
    expect(events(run.stdout).flatMap((event) => (event.event === 'session' ? [event.session.sessionId] : [])).sort()).toEqual([WORKER_ID, REVIEW_ID].sort())
  })
})

describe('traces watch, live', () => {
  it('names each session and each finding once, however many passes read them', async () => {
    const run = await runCliUntil(['watch', '--format', 'jsonl'], (stdout) => ticks(stdout) >= 3, { env: { ...fx.env, ...fakeClock(NOW, 5_000) } })
    expect(run.code, run.stderr).toBe(0)
    const seen = events(run.stdout)
    const passes = seen.filter((event) => event.event === 'tick')
    expect(passes.slice(0, 3).map((tick) => [tick.sessions, tick.findings, tick.newSpans > 0])).toEqual([[2, 3, true], [2, 0, false], [2, 0, false]])
    expect(seen.filter((event) => event.event === 'session')).toHaveLength(2)
    expect(seen.filter((event) => event.event === 'finding')).toHaveLength(3)
    expect(run.stderr).toContain('traces watch: every session active in the last 30m, every 5 s')
  })

  it('slides the window: 40 minutes on, a session idle for 35 minutes leaves it and one idle for 10 stays', async () => {
    // At the start both were active in the last 30 minutes; 40 minutes later only the newer one is.
    const sliding = await homeWith([
      { id: 'a0000000-aaaa-4aaa-8aaa-00000000000a', text: claudeTranscript('a0000000-aaaa-4aaa-8aaa-00000000000a', REPO, 30, 'Newer.'), minutes: -30 },
      { id: 'b0000000-bbbb-4bbb-8bbb-00000000000b', text: claudeTranscript('b0000000-bbbb-4bbb-8bbb-00000000000b', REPO, 5, 'Older.'), minutes: -5 },
    ])
    const watched = async (since: string): Promise<number[]> => {
      const run = await runCliUntil(['watch', '--since', since, '--format', 'jsonl'], (stdout) => ticks(stdout) >= 2, {
        env: { ...sliding.env, ...fakeClock(NOW, 40 * 60_000) },
      })
      expect(run.code, run.stderr).toBe(0)
      return events(run.stdout).flatMap((event) => (event.event === 'tick' ? [event.sessions] : [])).slice(0, 2)
    }
    expect(await watched('30m')).toEqual([2, 1])
    // A start given as a time does not slide.
    expect(await watched(minutesBefore(30).toISOString())).toEqual([2, 2])
  })
})

describe('streamSessions (SDK)', () => {
  it('runs a caller\'s own rule after the built-in ones, on the same classified actions', async () => {
    const counted: TraceLiveAnalyst = {
      id: 'action-count',
      analyze(context) {
        return [{
          schemaVersion: 1,
          kind: 'traces.live_finding',
          id: `live.action-count.${context.session.sessionId}`,
          ruleId: 'action-count',
          fingerprint: context.session.sessionId,
          severity: 'info',
          title: 'Actions counted',
          claim: `${context.actions.length} action(s).`,
          action: 'None.',
          check: 'None.',
          evidence: [],
          session: context.session,
          observedAt: context.generatedAt,
        }]
      },
    }
    const seen: TraceStreamEvent[] = []
    await streamSessions({ harnesses: ['claude-code'], home: fx.home, sinceMs: 0, once: true, extraAnalysts: [counted], onEvent: (event) => { seen.push(event) } })
    const rules = seen.flatMap((event) => (event.event === 'finding' ? [`${event.finding.session.sessionId.slice(0, 8)} ${event.finding.ruleId}`] : []))
    expect(rules).toEqual(expect.arrayContaining(['a11a1a11 same-failing-command', 'a11a1a11 action-count', 'b22b2b22 action-count']))
    expect(rules.indexOf('a11a1a11 action-count')).toBeGreaterThan(rules.indexOf('a11a1a11 same-failing-command'))
  })
})
