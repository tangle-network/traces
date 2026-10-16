/**
 * Refs through the CLI: a positional argument is read for what it is. Every
 * case spawns the built CLI with HOME pointed at a synthetic home
 * (`fixtures/home.ts`) and asserts stdout, stderr and the exit code.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { serializeSpans, span } from '../src/index.js'
import { claudeStreamJson, codexRollout, IDS, makeFixtureHome, type FixtureHome } from './fixtures/home.js'
import { runCli } from './run-cli.js'

const liveStreams = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sandbox-live-stream')

let fx: FixtureHome
beforeAll(async () => {
  fx = await makeFixtureHome()
})

const run = (argv: readonly string[]) => runCli(argv, { env: fx.env })

interface FactsJson {
  harness: string
  sessions: Array<{ sessionId: string | null }>
}

async function factsOf(...argv: string[]): Promise<FactsJson> {
  const result = await run(['facts', ...argv, '--format', 'json'])
  expect(result.stderr).not.toMatch(/^error:/mu)
  expect(result.code).toBe(0)
  return JSON.parse(result.stdout) as FactsJson
}

interface ErrorJson {
  error: string
  code: string
  candidates?: Array<{ harness: string; sessionId: string; path: string }>
}

async function refusal(...argv: string[]): Promise<ErrorJson> {
  const result = await run(['facts', ...argv, '--format', 'json'])
  expect(result.code).toBe(2)
  expect(result.stdout).toBe('')
  // The error is the last line: Node can print its own warnings first.
  return JSON.parse(result.stderr.trim().split('\n').at(-1)!) as ErrorJson
}

function rows(text: string): Array<Record<string, unknown> & { trace_id: string; attributes: Record<string, unknown> }> {
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** Two runs in one span file: trace `a…` and trace `b…`, each a root, a model call and a tool call. */
function twoRuns(): string {
  const run = (traceId: string, session: string) => {
    const id = (n: number) => `${traceId.slice(0, 12)}000${n}`
    return [
      span({ traceId, spanId: id(1), name: 'session', kind: 'AGENT', startTime: '2026-10-14T10:00:00.000Z', endTime: '2026-10-14T10:01:00.000Z', service: 'codex', extra: { 'session.id': session } }),
      span({ traceId, spanId: id(2), parentSpanId: id(1), name: 'llm.turn', kind: 'LLM', startTime: '2026-10-14T10:00:01.000Z', service: 'codex', model: 'gpt-6.1', inputTokens: 10, outputTokens: 2 }),
      span({ traceId, spanId: id(3), parentSpanId: id(1), name: 'tool.shell', kind: 'TOOL', startTime: '2026-10-14T10:00:02.000Z', service: 'codex', tool: 'shell' }),
    ]
  }
  return serializeSpans([
    ...run('a'.repeat(32), 'session-a'),
    ...run('b'.repeat(32), 'session-b'),
  ])
}

describe('refs: session ids', () => {
  it('resolves an exact id, an 8-character prefix and an 8-character suffix on any harness', async () => {
    const exact = await factsOf(IDS.claude)
    expect(exact.harness).toBe('claude-code')
    expect(exact.sessions[0]!.sessionId).toBe(IDS.claude)

    const prefix = await factsOf(IDS.claude.slice(0, 8))
    expect(prefix.sessions[0]!.sessionId).toBe(IDS.claude)

    const suffix = await factsOf(IDS.codex.slice(-8))
    expect(suffix.harness).toBe('codex')
    expect(suffix.sessions[0]!.sessionId).toBe(IDS.codex)
  })

  it('refuses a prefix two sessions share: exit 2, code ambiguous, both ids', async () => {
    const error = await refusal('0199abcd')
    expect(error.code).toBe('ambiguous')
    expect(error.candidates?.map((candidate) => candidate.sessionId).sort()).toEqual([IDS.claudeTwin, IDS.codexTwin].sort())

    const text = await run(['facts', '0199abcd', '--format', 'text'])
    expect(text.code).toBe(2)
    expect(text.stdout).toBe('')
    expect(text.stderr).toContain(IDS.claudeTwin)
    expect(text.stderr).toContain(IDS.codexTwin)
  })

  it('refuses a 7-character prefix as a usage error, and an id or path nothing has as unreadable', async () => {
    expect((await refusal(IDS.claude.slice(0, 7))).code).toBe('usage')
    expect((await refusal('feedface')).code).toBe('unreadable')
    expect((await refusal('./no-such-session.jsonl')).code).toBe('unreadable')
  })
})

describe('refs: files and directories are read by their content', () => {
  it('reads harness session files by their store, else by their first records', async () => {
    const loose = join(fx.root, 'loose')
    await mkdir(loose, { recursive: true })
    const claudeCopy = join(loose, 'transcript.jsonl')
    await copyFile(fx.paths.claude, claudeCopy)
    const codexCopy = join(loose, 'rollout.jsonl')
    await writeFile(codexCopy, codexRollout(IDS.codex, '/w/x', 30, 'Run the tests.'), 'utf8')
    const streamJson = join(loose, 'claude-p.jsonl')
    await writeFile(streamJson, claudeStreamJson('5e55c0de-ffff-4fff-8fff-ffffffffffff', '/w/x', 40), 'utf8')

    for (const [ref, harness] of [
      [fx.paths.claude, 'claude-code'],
      [claudeCopy, 'claude-code'],
      [streamJson, 'claude-code'],
      [fx.paths.codex, 'codex'],
      [codexCopy, 'codex'],
    ] as const) {
      const facts = await factsOf(ref)
      expect({ ref, harness: facts.harness }).toEqual({ ref, harness })
    }
  })

  it('reads OTLP files and directories, and picks one run with #<trace id>', async () => {
    const dir = join(fx.root, 'otlp')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'runs.otlp.jsonl')
    await writeFile(file, twoRuns(), 'utf8')

    const both = await factsOf(file)
    expect(both.harness).toBe('otlp')
    expect(both.sessions.map((session) => session.sessionId).sort()).toEqual(['session-a', 'session-b'])
    expect((await factsOf(dir)).sessions).toHaveLength(2)

    const out = join(fx.root, 'one-run.otlp.jsonl')
    const picked = await run(['convert', `${file}#${'b'.repeat(32)}`, '--out', out])
    expect(picked.code).toBe(0)
    expect(new Set(rows(await readFile(out, 'utf8')).map((row) => row.trace_id))).toEqual(new Set(['b'.repeat(32)]))
  })

  it('reads a Sandbox live stream as codex-exec and a sandbox-events recording as events', async () => {
    const live = join(fx.root, 'live.otlp.jsonl')
    expect((await run(['convert', join(liveStreams, 'codex-director-in-progress.jsonl'), '--out', live])).code).toBe(0)
    expect(rows(await readFile(live, 'utf8')).some((row) => row.attributes['service.name'] === 'codex-exec')).toBe(true)

    const events = join(fx.root, 'events.otlp.jsonl')
    expect((await run(['convert', join(liveStreams, 'sandbox-refused-before-codex.jsonl'), '--out', events])).code).toBe(0)
    expect(rows(await readFile(events, 'utf8')).some((row) => row.attributes['traces.source_format'] === 'sandbox-events')).toBe(true)
  })

  it('reads a bundle directory as the session it keeps', async () => {
    const bundle = join(fx.root, 'bundle')
    const made = await run(['bundle', IDS.claude.slice(0, 8), '--out', bundle])
    expect(made.code).toBe(0)
    expect((await factsOf(bundle)).sessions[0]!.sessionId).toBe(IDS.claude)
  })

  it('reads a Runtime run directory as the supervision tree analyze reports', async () => {
    const runDir = join(fx.root, 'runs', 'r1')
    await mkdir(runDir, { recursive: true })
    const at = (sec: number) => new Date(Date.parse('2026-10-14T10:00:00.000Z') + sec * 1000).toISOString()
    const events = [
      { kind: 'spawned', id: 'sup-1', label: 'root', at: at(0) },
      { kind: 'spawned', id: 'sup-1:w0', parent: 'sup-1', label: 'w-0', at: at(10) },
      { kind: 'settled', id: 'sup-1:w0', status: 'done', at: at(100), spent: { iterations: 1, tokens: { input: 5, output: 1 }, usd: 0.01, ms: 90_000 } },
    ]
    await writeFile(join(runDir, 'spawn-journal.jsonl'), [
      JSON.stringify({ kind: 'begin', root: 'sup-1', at: at(0) }),
      ...events.map((event, seq) => JSON.stringify({ kind: 'event', root: 'sup-1', event: { ...event, seq } })),
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(runDir, 'result.json'), JSON.stringify({ kind: 'winner', tree: { root: 'sup-1' }, spentTotal: { usd: 0.01 } }), 'utf8')

    const positional = await run(['analyze', runDir])
    const flagged = await run(['analyze', '--supervisor-run-dir', runDir])
    expect(positional.code).toBe(0)
    expect(positional.stdout).not.toBe('')
    expect(positional.stdout).toBe(flagged.stdout)
  })
})

describe('refs: a store root', () => {
  it('selects over its own stores instead of HOME', async () => {
    const listed = await run(['list', fx.storeRoot])
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain(IDS.archived)
    expect(listed.stdout).not.toContain(IDS.claude)

    const windowed = await factsOf(fx.storeRoot, '--since', '3650d')
    expect(windowed.sessions.map((session) => session.sessionId)).toEqual([IDS.archived])

    expect((await factsOf(fx.storeRoot, IDS.archived.slice(0, 8))).sessions[0]!.sessionId).toBe(IDS.archived)
    expect((await refusal(fx.storeRoot, IDS.claude.slice(0, 8))).code).toBe('unreadable')
  })
})

describe('refs: convert and upload take files', () => {
  it('converts an OTLP file to --out, and previews its upload without sending', async () => {
    const file = join(fx.root, 'upload.otlp.jsonl')
    await writeFile(file, twoRuns(), 'utf8')

    const converted = join(fx.root, 'converted.otlp.jsonl')
    const convert = await run(['convert', file, '--out', converted])
    expect(convert.code).toBe(0)
    expect(rows(await readFile(converted, 'utf8'))).toHaveLength(6)

    const preview = join(fx.root, 'preview.otlp.jsonl')
    const upload = await run(['upload', file, '--dry-run', '--out', preview])
    expect(upload.stderr).not.toContain('REFUSED')
    expect(upload.code).toBe(0)
    expect(upload.stdout).toContain('dry run: 2 session(s)')
    expect(rows(await readFile(preview, 'utf8'))).toHaveLength(6)
  })
})
