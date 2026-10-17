/**
 * The `traces.stream.*` envelope `traces watch --format jsonl` prints is a
 * stable API. trustgate reads it through `projectTrace`
 * (`integrations/agent-protection/src/traces.mjs`), copied below. The CLI runs
 * once over a fixture home with a frozen clock: a worker whose test failed 3
 * times in a row, and a Codex session no reader can read. Every field
 * trustgate takes is checked, and `docs/watch-jsonl.v1.example.jsonl`, which
 * ships in the package for consumers to test against, must equal the output
 * (`UPDATE_WATCH_EXAMPLE=1` rewrites it).
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { jsonl, REPO, WORKER_ID, workerSession } from './fixtures/analyze.js'
import { IDS, unreadableRollout } from './fixtures/home.js'
import { CLI, type CliRun, fakeClock, runCli } from './run-cli.js'

const EXAMPLE = join(dirname(CLI), '..', 'docs', 'watch-jsonl.v1.example.jsonl')
const NOW = '2026-10-16T10:40:00.000Z'
/** The fixture root as the example file names it: a temp directory differs on every run. */
const ROOT = '/tmp/traces-watch-fixture'

// ── trustgate f7f91bd integrations/agent-protection/src/traces.mjs, verbatim ──
const hash = (x: unknown): string => createHash('sha256').update(String(x)).digest('hex')
const isObject = (x: unknown): x is Record<string, any> => x !== null && typeof x === 'object' && !Array.isArray(x)

/** Project the actual traces.stream contract, discarding content before HTTP I/O. */
function projectTrace(event: any): Record<string, unknown> | null {
  if (!isObject(event) || event.schemaVersion !== 1) return null
  const kind = event.event
  if (!['session', 'span', 'finding', 'report'].includes(kind)) return null
  if (event.kind !== 'traces.stream.' + kind) return null
  const session = kind === 'finding' ? event.finding?.session : event.session
  if (!isObject(session) || typeof session.sessionId !== 'string' || session.sessionId.length > 4096) return null
  if (session.harness !== undefined && (typeof session.harness !== 'string' || session.harness.length > 128)) return null
  const sessionId = 'source:' + hash(JSON.stringify([session.harness ?? 'unspecified', session.sessionId]))
  const base = { kind, source: 'tangle-traces', trace_id: sessionId, severity: 'info', code: 'observed_' + kind }
  if (kind === 'finding') {
    const f = event.finding
    if (!isObject(f) || f.kind !== 'traces.live_finding' || typeof f.fingerprint !== 'string' || f.fingerprint.length > 4096) return null
    // Do not send titles, claims, paths, tool arguments, or free-form rule IDs.
    const severity = f.severity === 'high' ? 'high' : ['low', 'medium'].includes(f.severity) ? 'review' : 'info'
    return { ...base, severity, event_id: 'trace:' + hash(JSON.stringify([sessionId, kind, f.fingerprint, f.observedAt ?? event.generatedAt, severity])) }
  }
  if (kind === 'span') {
    const span = event.span
    const id = span?.span_id ?? span?.spanId
    if (!isObject(span) || typeof id !== 'string' || id.length > 4096) return null
    return { ...base, span_id: 'span:' + hash(id), event_id: 'trace:' + hash(JSON.stringify([sessionId, kind, id, span.end_time ?? span.endTime ?? null])) }
  }
  return { ...base, event_id: 'trace:' + hash(JSON.stringify([sessionId, kind, event.generatedAt ?? null])) }
}
// ── end of the copy ─────────────────────────────────────────────────────────

type Event = Record<string, any>

let run: CliRun
let events: Event[]
let normalized: string

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'traces-watch-contract-'))
  const home = join(root, 'home')
  const worker = join(home, '.claude', 'projects', REPO.replaceAll('/', '-'), `${WORKER_ID}.jsonl`)
  const unreadable = join(home, '.codex', 'sessions', '2026', '10', '16', `rollout-2026-10-16T10-30-00-${IDS.unreadable}.jsonl`)
  await mkdir(dirname(worker), { recursive: true })
  await mkdir(dirname(unreadable), { recursive: true })
  await writeFile(worker, jsonl(workerSession()))
  await writeFile(unreadable, unreadableRollout(REPO, 30))
  // Both active in the last 30 minutes of the frozen clock, the worker last.
  for (const [path, minutesAgo] of [[worker, 1], [unreadable, 10]] as const) {
    const at = new Date(Date.parse(NOW) - minutesAgo * 60_000)
    await utimes(path, at, at)
  }
  run = await runCli(['watch', '--once', '--format', 'jsonl'], {
    env: { HOME: home, XDG_STATE_HOME: join(root, 'state'), ...fakeClock(NOW) },
  })
  normalized = run.stdout.replaceAll(root, ROOT)
  events = run.stdout.trim().split('\n').map((line) => JSON.parse(line) as Event)
})

describe('traces watch --format jsonl', () => {
  it('prints one JSON event a line, of the three kinds, and exits 0 with an unreadable session among the active ones', () => {
    expect(run.code, run.stderr).toBe(0)
    expect(events.map((event) => event.kind)).toEqual([
      'traces.stream.session',
      ...events.filter((event) => event.event === 'finding').map(() => 'traces.stream.finding'),
      'traces.stream.tick',
    ])
    for (const event of events) {
      expect(event.schemaVersion).toBe(1)
      expect(event.kind).toBe(`traces.stream.${event.event}`)
      expect(typeof event.generatedAt).toBe('string')
    }
    const tick = events.at(-1)!
    expect(tick).toMatchObject({ sessions: 1, findings: events.length - 2 })
    expect(tick.unreadSessions).toHaveLength(1)
    expect(tick.unreadSessions[0].sessionId).toBe(IDS.unreadable)
    expect(run.stderr).toContain('1 unreadable: ')
  })

  it('carries every field trustgate reads, and each finding and session projects', () => {
    const session = events.find((event) => event.event === 'session')!
    expect(session.session).toMatchObject({ harness: 'claude-code', sessionId: WORKER_ID, cwd: REPO })
    const findings = events.filter((event) => event.event === 'finding')
    expect(findings.length).toBeGreaterThanOrEqual(1)
    for (const { finding } of findings) {
      expect(finding.kind).toBe('traces.live_finding')
      expect(finding.fingerprint).toMatch(/^[0-9a-f]{16}$/u)
      expect(['info', 'low', 'medium', 'high']).toContain(finding.severity)
      expect(finding.observedAt).toBe(NOW)
      expect(finding.session).toMatchObject({ harness: 'claude-code', sessionId: WORKER_ID })
    }
    expect(findings.map(({ finding }) => finding.ruleId)).toContain('same-failing-command')
    const projected = events.map(projectTrace)
    expect(projected.filter((row, at) => events[at]!.event !== 'tick' && row === null)).toEqual([])
    // A tick is not an event trustgate records; it counts it as skipped.
    expect(projected.at(-1)).toBeNull()
  })

  it('is the example the package ships', async () => {
    if (process.env.UPDATE_WATCH_EXAMPLE === '1') await writeFile(EXAMPLE, normalized)
    expect(normalized).toBe(await readFile(EXAMPLE, 'utf8'))
  })
})
