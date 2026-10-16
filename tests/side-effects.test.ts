/**
 * Nothing is written outside `--out` and `$XDG_STATE_HOME/traces` (spec §2.1, U6).
 *
 * Each of the 12 commands runs through the built CLI on fixtures, with a fresh
 * TMPDIR and a fresh cwd. Afterwards both are empty, the fixture home and its
 * XDG directories hold exactly the files they held before (state under
 * `$XDG_STATE_HOME/traces` aside), and stderr carries no `ExperimentalWarning`
 * (the fixture's OpenCode store loads `node:sqlite`) and no `[analyst]` line.
 * Only process boundaries are faked: the fixture HOME, a Python bridge that
 * dies at startup for `ask`, and an HTTP ingest peer for `upload`.
 */
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { deriveHexId, llmSpan, toolSpan } from '@tangle-network/agent-trace-contract'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type FixtureHome, IDS, makeFixtureHome } from './fixtures/home.js'
import { type CliRun, runCli } from './run-cli.js'

const TRACE = deriveHexId('side-effects-trace', 16)

let fx: FixtureHome
/** Outside the fixture: span files, the contract, the stub bridge, `--out` targets, and each run's TMPDIR and cwd. */
let root: string
let out: string
let spans: string
let contract: string
let bridge: string
let ingest: Server
let ingestUrl: string
let runs = 0

beforeAll(async () => {
  fx = await makeFixtureHome()
  root = await mkdtemp(join(tmpdir(), 'traces-side-effects-'))
  out = join(root, 'out')
  await mkdir(out)
  spans = join(root, 'run.otlp.jsonl')
  await writeFile(spans, `${[
    llmSpan({
      traceId: TRACE,
      spanId: deriveHexId('side-effects-llm', 8),
      parentSpanId: null,
      name: 'turn',
      model: 'glm-5.2',
      inputTokens: 10,
      outputTokens: 2,
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:01.000Z',
    }),
    toolSpan({
      traceId: TRACE,
      spanId: deriveHexId('side-effects-tool', 8),
      parentSpanId: null,
      name: 'bash',
      toolName: 'bash',
      startTime: '2026-01-01T00:00:01.000Z',
      endTime: '2026-01-01T00:00:02.000Z',
      status: { code: 'STATUS_CODE_OK' },
    }),
  ].map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  // The run calls bash and never edit, so this contract fails and check has evidence to write.
  contract = join(root, 'edit.contract.json')
  await writeFile(contract, JSON.stringify({ name: 'edit-required', tools: { required: ['edit'] } }), 'utf8')
  // Stands in for `python -m agent_eval_rpc.dspy_rlm_bridge`: dies at startup, before any model call.
  bridge = join(root, 'failing-bridge.sh')
  await writeFile(bridge, '#!/bin/sh\necho "DSPY-BRIDGE-FAILURE: synthetic startup failure" >&2\nexit 1\n', { mode: 0o755 })
  // Tangle Intelligence's ingest endpoint: accepts every span it is sent.
  ingest = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const { spans: sent } = JSON.parse(body) as { spans: unknown[] }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ accepted: sent.length, rejected: [] }))
    })
  })
  ingest.listen(0, '127.0.0.1')
  await once(ingest, 'listening')
  ingestUrl = `http://127.0.0.1:${(ingest.address() as AddressInfo).port}`
})

afterAll(() => {
  ingest?.close()
})

/** Every file and directory under `dir`, files with their size; the state traces keeps is left out. */
async function listing(dir: string, state: string): Promise<string[]> {
  const kept = join(state, 'traces')
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name)
    if (path === state || path === kept || path.startsWith(`${kept}/`)) continue
    found.push(entry.isFile() ? `${relative(dir, path)} ${(await stat(path)).size}` : `${relative(dir, path)}/`)
  }
  return found.sort()
}

/** Run `traces <argv>` in a fresh TMPDIR and cwd, and assert it wrote nothing it was not asked to and printed no noise. */
async function run(argv: readonly string[], options: { env?: Record<string, string>; input?: string } = {}): Promise<CliRun> {
  const at = join(root, `run-${runs++}`)
  const tmp = join(at, 'tmp')
  const cwd = join(at, 'cwd')
  await mkdir(tmp, { recursive: true })
  await mkdir(cwd, { recursive: true })
  const state = fx.env.XDG_STATE_HOME!
  const before = await listing(fx.root, state)
  const result = await runCli(argv, {
    env: { ...fx.env, ...options.env, TMPDIR: tmp },
    cwd,
    timeoutMs: 120_000,
    ...(options.input !== undefined ? { input: options.input } : {}),
  })
  const command = `traces ${argv.join(' ')}`
  expect(await readdir(tmp), `TMPDIR after ${command}`).toEqual([])
  expect(await readdir(cwd), `cwd after ${command}`).toEqual([])
  expect(await listing(fx.root, state), `fixture home and XDG directories after ${command}`).toEqual(before)
  expect(result.stderr, command).not.toContain('ExperimentalWarning')
  expect(result.stderr, command).not.toContain('[analyst]')
  return result
}

describe('every command writes only to --out and $XDG_STATE_HOME/traces', () => {
  it('list', async () => {
    const listed = await run(['list'])
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain(IDS.opencode.slice(0, 8))
  })

  it('facts, over every harness including the OpenCode SQLite store', async () => {
    const facts = await run(['facts', '--last', '20', '--format', 'json'])
    expect(facts.code).toBe(0)
    const report = JSON.parse(facts.stdout) as { sessions: Array<{ sessionId: string }> }
    expect(report.sessions.map((session) => session.sessionId)).toContain(IDS.opencode)
  })

  it('analyze, to stdout and to --out', async () => {
    const printed = await run(['analyze', IDS.claude])
    expect(printed.code).toBe(0)
    expect(printed.stdout).toContain('# Trace analysis')

    const report = join(out, 'report.md')
    const written = await run(['analyze', IDS.opencode, '--out', report])
    expect(written.code).toBe(0)
    expect(await readFile(report, 'utf8')).toContain('# Trace analysis')
  })

  it('ask, when the engine dies at startup', async () => {
    const asked = await run(['ask', IDS.claude, '--question', 'Which command ran first?', '--budget', '1'], {
      env: { TANGLE_API_KEY: 'test-key-never-sent-upstream', TRACES_PYTHON: bridge },
    })
    expect(asked.code).not.toBe(0)
    expect(asked.stdout).toContain('# traces ask')
    expect(asked.stderr).toContain('1 of 1 question(s) failed')
  })

  it('check, which writes evidence only under --out', async () => {
    const failed = await run(['check', spans, '--contract', contract])
    expect(failed.code).toBe(1)
    expect(failed.stdout).not.toContain('evidence →')

    const evidence = join(out, 'evidence')
    const kept = await run(['check', spans, '--contract', contract, '--out', evidence])
    expect(kept.code).toBe(1)
    const [dir] = await readdir(evidence)
    expect(kept.stdout).toContain(`evidence → ${join(evidence, dir!)}`)
    expect((await readdir(join(evidence, dir!))).sort()).toEqual(['cited-spans.jsonl', 'contract.json', 'explain.txt', 'verdict.json'])
  })

  it('diff', async () => {
    expect((await run(['diff', spans, spans])).code).toBe(0)
  })

  it('watch', async () => {
    const watched = await run(['watch', spans, '--once'])
    expect(watched.code).toBe(0)
    expect(watched.stdout).not.toBe('')
  })

  it('convert, to stdout and to --out', async () => {
    const printed = await run(['convert', IDS.claude])
    expect(printed.code).toBe(0)
    expect(printed.stdout.trim().split('\n').length).toBeGreaterThan(1)

    const file = join(out, 'spans.otlp.jsonl')
    expect((await run(['convert', IDS.codex, '--out', file])).code).toBe(0)
    expect((await readFile(file, 'utf8')).trim().split('\n').length).toBeGreaterThan(1)
  })

  it('bundle and bundle verify', async () => {
    const bundle = join(out, 'bundle')
    expect((await run(['bundle', IDS.claude, '--out', bundle])).code).toBe(0)
    expect((await run(['bundle', 'verify', bundle])).code).toBe(0)
  })

  it('upload: a dry run writes nothing without --out, and a sent upload records it under $XDG_STATE_HOME/traces', async () => {
    const dry = await run(['upload', IDS.claude, '--dry-run'])
    expect(dry.code).toBe(0)
    expect(dry.stdout).toMatch(/dry run: [1-9]\d* session\(s\)/u)

    const preview = join(out, 'preview.otlp.jsonl')
    expect((await run(['upload', IDS.claude, '--dry-run', '--out', preview])).code).toBe(0)
    expect((await readFile(preview, 'utf8')).trim()).not.toBe('')

    const sent = await run(['upload', IDS.claude, '--yes'], {
      env: { TANGLE_INGEST_URL: ingestUrl, TANGLE_INGEST_API_KEY: 'test-ingest-key', TANGLE_TENANT_ID: 'tenant-side-effects' },
    })
    expect(sent.code, sent.stderr).toBe(0)
    expect(sent.stdout).toMatch(/Uploaded [1-9]\d* session\(s\)/u)
    const state = JSON.parse(await readFile(join(fx.env.XDG_STATE_HOME!, 'traces', 'uploaded.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(state).some((key) => key.includes(IDS.claude))).toBe(true)
  })

  it('skills', async () => {
    expect((await run(['skills', '--since', '30d'])).code).toBe(0)
  })

  it('mcp', async () => {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'viewTrace', arguments: { trace_id: TRACE } } },
    ]
    const served = await run(['mcp', spans], { input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n` })
    expect(served.code).toBe(0)
    const replies = served.stdout.trim().split('\n').map((line) => JSON.parse(line) as { id: number; result?: unknown; error?: unknown })
    const viewed = replies.find((reply) => reply.id === 2)
    expect(viewed?.error).toBeUndefined()
    expect(viewed?.result).toBeDefined()
  })
})
