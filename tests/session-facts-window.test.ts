/**
 * `traces facts --since/--until`: a time window over every local session.
 *
 * A reader who mines one day of an operator's turns needs every session that
 * was active that day, and from each only that day's turns. Before the window,
 * `facts` returned the newest session alone and ignored `--since`.
 *
 * The sessions live in a temporary HOME, so the CLI discovers them exactly as
 * it discovers a real Claude Code store.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionFactsReport } from '../src/session-facts.js'

const execFileAsync = promisify(execFile)

const DAY_ONE = '2026-02-01'
const DAY_TWO = '2026-02-02'
const DAY_THREE = '2026-02-03'

const home = mkdtempSync(join(tmpdir(), 'traces-facts-window-'))
const project = join(home, '.claude', 'projects', '-work-release')
afterAll(() => rmSync(home, { recursive: true, force: true }))

const human = (session: string, uuid: string, timestamp: string, text: string) => ({
  type: 'user',
  uuid,
  sessionId: session,
  timestamp,
  cwd: '/work/release',
  userType: 'external',
  origin: { kind: 'human' },
  message: { role: 'user', content: text },
})

const injected = (session: string, uuid: string, timestamp: string, text: string) => ({
  type: 'user',
  uuid,
  sessionId: session,
  timestamp,
  cwd: '/work/release',
  isMeta: true,
  message: { role: 'user', content: text },
})

const agent = (session: string, uuid: string, timestamp: string, text: string) => ({
  type: 'assistant',
  uuid,
  sessionId: session,
  timestamp,
  cwd: '/work/release',
  message: { id: `message-${uuid}`, role: 'assistant', model: 'test-model', content: [{ type: 'text', text }] },
})

function writeSession(id: string, rows: readonly unknown[]): string {
  const path = join(project, `${id}.jsonl`)
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  return path
}

beforeAll(() => {
  mkdirSync(project, { recursive: true })
  // Active on both days: the window must keep the session and only day two's turns.
  writeSession('two-day', [
    human('two-day', 'u1', `${DAY_ONE}T10:00:00Z`, 'day one: plan the release'),
    injected('two-day', 'm1', `${DAY_ONE}T10:00:01Z`, 'Caveat: day one reminder'),
    agent('two-day', 'a1', `${DAY_ONE}T10:01:00Z`, 'Plan: cut, test, ship.'),
    human('two-day', 'u2', `${DAY_ONE}T23:59:00Z`, 'ship it'),
    agent('two-day', 'a2', `${DAY_ONE}T23:59:30Z`, 'Shipped tonight’s build.'),
    human('two-day', 'u3', `${DAY_TWO}T09:00:00Z`, 'day two: check the deploy'),
    injected('two-day', 'm2', `${DAY_TWO}T09:00:01Z`, 'Caveat: day two reminder'),
    agent('two-day', 'a3', `${DAY_TWO}T09:01:00Z`, 'Deploy is healthy.'),
    human('two-day', 'u4', `${DAY_TWO}T09:05:00Z`, 'thanks'),
  ])
  // Active on day one only: read, found outside the window, and named.
  writeSession('day-one-only', [
    human('day-one-only', 'u1', `${DAY_ONE}T08:00:00Z`, 'an unrelated morning'),
    agent('day-one-only', 'a1', `${DAY_ONE}T08:01:00Z`, 'Done.'),
  ])
  // Last written before the window opened: it cannot hold a record inside it,
  // so it is not read at all.
  const stale = writeSession('stale', [
    human('stale', 'u1', `${DAY_ONE}T07:00:00Z`, 'stale morning'),
  ])
  const before = new Date(`${DAY_ONE}T12:00:00Z`)
  utimesSync(stale, before, before)
  // Not a session at all: nothing in it can be read.
  writeFileSync(join(project, 'garbage.jsonl'), 'this is not a transcript\n')
})

const cli = (args: string[]) =>
  execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, NO_COLOR: '1', FORCE_COLOR: '' },
    maxBuffer: 16 * 1024 * 1024,
  })

const DAY_TWO_WINDOW = ['--since', `${DAY_TWO}T00:00:00Z`, '--until', `${DAY_THREE}T00:00:00Z`]

describe('traces facts --since/--until', () => {
  it("selects every session with a record in the window and counts only the window's turns", async () => {
    const { stdout, stderr } = await cli(['facts', '--harness', 'claude-code', ...DAY_TWO_WINDOW, '--format', 'json'])
    const report = JSON.parse(stdout) as SessionFactsReport

    expect(report.selection).toMatchObject({
      since: `${DAY_TWO}T00:00:00.000Z`,
      until: `${DAY_THREE}T00:00:00.000Z`,
      outsideWindow: ['day-one-only'],
    })
    expect(report.selection!.turnRule).toContain('humanTurns, excludedTurns and turnsByActor')
    expect(report.sessions.map((facts) => facts.sessionId)).toEqual(['two-day'])

    const [facts] = report.sessions
    expect(facts!.humanTurns.value!.map((turn) => turn.text)).toEqual(['day two: check the deploy', 'thanks'])
    // The first turn of the day answers the last message of the night before:
    // the window limits which turns count, not what they answered.
    expect(facts!.humanTurns.value!.map((turn) => turn.answered)).toEqual([
      'Shipped tonight’s build.',
      'Deploy is healthy.',
    ])
    expect(facts!.excludedTurns.value!.map((entry) => entry.turns)).toEqual([1])
    expect(facts!.turnsByActor.value!.map((entry) => [entry.actor, entry.turns])).toEqual([
      ['human', 2],
      ['injected', 1],
    ])
    // Facts about the session as a whole are not windowed.
    expect(Date.parse(facts!.firstRecordAt.value!)).toBe(Date.parse(`${DAY_ONE}T10:00:00Z`))
    expect(facts!.cwd.value).toBe('/work/release')

    // The file that could not be read is named with its reason, never counted as empty.
    expect(report.selection!.unreadSessions).toEqual([
      expect.objectContaining({ sessionId: 'garbage', reason: expect.any(String) }),
    ])
    // One stderr line says how many were skipped and how to see each reason.
    expect(stderr).toMatch(/^1 unreadable: traces facts .*--format json \| jq \.selection$/mu)
  })

  it('reads the same window in the relative forms other commands accept', async () => {
    const { stdout } = await cli(['facts', '--harness', 'claude-code', '--since', `${DAY_TWO}T00:00:00Z`, '--until', '1m', '--format', 'json'])
    const report = JSON.parse(stdout) as SessionFactsReport
    expect(report.sessions.map((facts) => facts.sessionId)).toEqual(['two-day'])
    expect(Date.parse(report.selection!.until!)).toBeGreaterThan(Date.parse(`${DAY_THREE}T00:00:00Z`))
  })

  it('withholds the answered text and the directory under --no-content', async () => {
    const { stdout } = await cli(['facts', '--harness', 'claude-code', ...DAY_TWO_WINDOW, '--no-content', '--format', 'json'])
    const report = JSON.parse(stdout) as SessionFactsReport
    expect(report.contentIncluded).toBe(false)
    const [facts] = report.sessions
    expect(facts!.humanTurns).toEqual({ value: null, spanIds: [], unavailable: 'Content was not requested.' })
    expect(facts!.cwd.value).toBeNull()
    expect(stdout).not.toContain('Deploy is healthy.')
    expect(stdout).not.toContain('Shipped tonight’s build.')
  })

  it('leaves a selection without a window as it was, and refuses --until elsewhere', async () => {
    const { stdout } = await cli(['facts', join(project, 'two-day.jsonl'), '--harness', 'claude-code', '--format', 'json'])
    const report = JSON.parse(stdout) as SessionFactsReport
    expect(report.selection).toBeNull()
    expect(report.sessions[0]!.humanTurns.value).toHaveLength(4)

    await expect(cli(['list', '--harness', 'claude-code', '--until', '1d']))
      .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('--until does not apply to list; it applies to: facts') })
    await expect(cli(['facts', '--harness', 'claude-code', '--until', 'yesterday-ish']))
      .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('--until: expected') })
  })
})
