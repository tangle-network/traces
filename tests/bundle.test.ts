/**
 * `traces bundle` (spec §2.2): one session's evidence, kept beyond log
 * rotation, as `session/`, `spans.otlp.jsonl`, `facts.json`, `git-log.txt` and
 * `manifest.json`. `bundle verify` checks it byte for byte, and the bundle
 * directory is a ref that reads as the session it keeps. Every case spawns the
 * built CLI on a synthetic session whose recorded cwd is a throwaway git repo.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { runCli } from './run-cli.js'

const run = promisify(execFile)

const SESSION_ID = 'bundle-session'
const INSIDE = 'fixture: the commit made during the session'
const OUTSIDE = 'fixture: a commit months before the session'

let root: string
let env: Record<string, string>
let repo: string
let transcript: string
let bundle: string

/** A commit made at `at`, through plumbing: no hook or signing config of the host applies. */
async function commitAt(at: string, message: string, parent?: string): Promise<string> {
  const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' }
  const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
  const { stdout } = await run('git', ['-C', repo, 'commit-tree', '--no-gpg-sign', emptyTree, ...(parent ? ['-p', parent] : []), '-m', message], {
    env: { ...process.env, ...identity, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  })
  return stdout.trim()
}

interface FactsJson {
  readonly sessions: ReadonlyArray<{
    readonly sessionId: string | null
    readonly cwd: { readonly value: string | null }
    readonly toolCalls: { readonly value: number | null }
    readonly humanTurns: { readonly value: ReadonlyArray<{ readonly text: string }> | null }
    readonly firstRecordAt: { readonly value: string | null }
    readonly lastRecordAt: { readonly value: string | null }
  }>
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'traces-bundle-'))
  env = { HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state') }
  repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  await run('git', ['init', '-q', '-b', 'main', repo])
  const before = await commitAt('2025-06-01T00:00:00Z', OUTSIDE)
  await run('git', ['-C', repo, 'update-ref', 'refs/heads/main', await commitAt('2026-01-01T00:00:30Z', INSIDE, before)])

  transcript = join(root, 'session.jsonl')
  const record = (uuid: string, timestamp: string, message: Record<string, unknown>) =>
    JSON.stringify({ type: message.role, uuid, sessionId: SESSION_ID, cwd: repo, timestamp, message })
  await writeFile(transcript, [
    record('u1', '2026-01-01T00:00:00Z', { role: 'user', content: 'Fix the date parser.' }),
    record('a1', '2026-01-01T00:00:01Z', { id: 'm1', role: 'assistant', content: 'Fixed the date parser.' }),
  ].join('\n') + '\n', 'utf8')

  bundle = join(root, 'bundle')
  const made = await runCli(['bundle', transcript, '--harness', 'claude-code', '--out', bundle], { env })
  expect(made.code).toBe(0)
  expect(made.stdout).toContain(`session bundle → ${bundle}`)
})

describe('traces bundle', () => {
  it('keeps the session as session/, spans.otlp.jsonl, facts.json, git-log.txt and a manifest of every file', async () => {
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')) as {
      schemaVersion: number
      provenance: { sessionId: string; cwd: string | null; transcriptSha256: string }
      files: Array<{ path: string; bytes: number; sha256: string }>
      absent: Array<{ path: string }>
    }
    expect(manifest.schemaVersion).toBe(3)
    expect(manifest.files.map((file) => file.path)).toEqual([
      'facts.json',
      'git-log.txt',
      'session/transcript.jsonl',
      'spans.otlp.jsonl',
    ])
    const bytes = await readFile(transcript)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    expect(manifest.provenance).toMatchObject({ sessionId: SESSION_ID, cwd: repo, transcriptSha256: sha256 })
    expect(manifest.files.find((file) => file.path === 'session/transcript.jsonl')).toEqual({
      sourceId: expect.any(String),
      path: 'session/transcript.jsonl',
      bytes: bytes.length,
      sha256,
    })
    // An input the session never had is named, not silently missing.
    expect(manifest.absent.map((entry) => entry.path)).toEqual(['session/subagents'])
  })

  it('logs the commits made in the session window from the cwd the session recorded', async () => {
    const log = await readFile(join(bundle, 'git-log.txt'), 'utf8')
    expect(log).toContain(INSIDE)
    expect(log).not.toContain(OUTSIDE)
  })

  it('reads as the session it keeps, with the facts it wrote beside it', async () => {
    const kept = JSON.parse(await readFile(join(bundle, 'facts.json'), 'utf8')) as FactsJson
    const read = await runCli(['facts', bundle, '--format', 'json'], { env })
    expect(read.code).toBe(0)
    const reread = JSON.parse(read.stdout) as FactsJson
    const summary = (facts: FactsJson) => facts.sessions.map((session) => ({
      sessionId: session.sessionId,
      cwd: session.cwd.value,
      toolCalls: session.toolCalls.value,
      humanTurns: session.humanTurns.value?.map((turn) => turn.text),
      firstRecordAt: session.firstRecordAt.value,
      lastRecordAt: session.lastRecordAt.value,
    }))
    expect(summary(kept)).toEqual([{
      sessionId: SESSION_ID,
      cwd: repo,
      toolCalls: 0,
      humanTurns: ['Fix the date parser.'],
      firstRecordAt: expect.stringMatching(/^2026-01-01T00:00:00/),
      lastRecordAt: expect.stringMatching(/^2026-01-01T00:00:01/),
    }])
    expect(summary(reread)).toEqual(summary(kept))
  })

  it('verifies byte for byte, and fails on a changed byte or a file it does not list', async () => {
    const ok = await runCli(['bundle', 'verify', bundle], { env })
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain(`VERIFIED  bundle ${bundle}`)
    expect(ok.stdout).toContain('4/4 listed file(s) match')

    const changed = join(root, 'changed')
    await cp(bundle, changed, { recursive: true })
    await appendFile(join(changed, 'facts.json'), ' ')
    await writeFile(join(changed, 'notes.md'), 'added after assembly\n')
    const failed = await runCli(['bundle', 'verify', changed, '--format', 'json'], { env })
    expect(failed.code).toBe(1)
    const result = JSON.parse(failed.stdout) as { ok: boolean; issues: Array<{ kind: string; path: string }> }
    expect(result.ok).toBe(false)
    expect(result.issues.map(({ kind, path }) => ({ kind, path }))).toEqual([
      { kind: 'mismatch', path: 'facts.json' },
      { kind: 'unexpected', path: 'notes.md' },
    ])
  })

  it('reads and verifies a 0.x bundle, whose spans are derived/trace.otlp.jsonl', async () => {
    const old = join(root, 'bundle-0x')
    await mkdir(join(old, 'derived'), { recursive: true })
    const spans = await readFile(join(bundle, 'spans.otlp.jsonl'))
    await writeFile(join(old, 'derived', 'trace.otlp.jsonl'), spans)
    await writeFile(join(old, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 2,
      kind: 'traces.session_bundle',
      view: 'full',
      files: [{ path: 'derived/trace.otlp.jsonl', bytes: spans.length, sha256: createHash('sha256').update(spans).digest('hex') }],
    })}\n`)

    const read = await runCli(['facts', old, '--format', 'json'], { env })
    expect(read.code).toBe(0)
    expect((JSON.parse(read.stdout) as FactsJson).sessions.map((session) => session.sessionId)).toEqual([SESSION_ID])
    expect((await runCli(['bundle', 'verify', old], { env })).code).toBe(0)
  })
})
