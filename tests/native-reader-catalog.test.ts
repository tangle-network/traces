import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listReaders, readerFor } from '@tangle-network/harness-sessions'
import { collectSessionSelection, parseSession } from '../src/index.js'
import { listAdapters, resolveAdapter } from '../src/registry.js'
import { resolveRefs } from '../src/refs.js'
import { claudeTranscript } from './fixtures/home.js'
import { runCli } from './run-cli.js'

const HERMES_A = 'hermes-alpha-session-0001'
const HERMES_B = 'hermes-beta-session-0002'
const OPENCLAW_A = 'openclaw-alpha-session-0001'
const OPENCLAW_B = 'openclaw-beta-session-0002'
const NANOCLAW = 'nanoclaw-session-0001'
const PRIME = 'prime-fixture-session-0001'
const AT = '2026-11-20T10:00:00.000Z'

let root: string
let home: string
let env: Record<string, string>
let hermesPath: string
let openclawPath: string
let nanoclawPath: string
let primePath: string
let hermesDb: DatabaseSync | undefined

const run = (argv: readonly string[]) => runCli(argv, { env })

interface FactsReport {
  harness: string
  sessions: Array<{
    sessionId: string
    harness: string
    firstRecordAt: { value: string | null }
    toolCalls: { value: number | null }
    tokens: { modelCalls: number }
  }>
}

async function facts(...argv: string[]): Promise<FactsReport> {
  const result = await run(['facts', ...argv, '--format', 'json'])
  expect(result.code, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as FactsReport
}

async function database(path: string, schema: string): Promise<DatabaseSync> {
  await mkdir(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(schema)
  return db
}

async function makeHermes(): Promise<void> {
  hermesPath = join(home, '.hermes', 'state.db')
  hermesDb = await database(hermesPath, `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, started_at REAL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL);`)
  const session = hermesDb.prepare('INSERT INTO sessions VALUES (?, ?, 20, 5, 0, 0, ?)')
  const message = hermesDb.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  for (const [offset, id, title] of [[0, HERMES_A, 'Alpha release title'], [1, HERMES_B, 'Beta unrelated title']] as const) {
    const started = Date.parse(AT) / 1000 + offset * 60
    session.run(id, 'hermes-model', started)
    message.run(offset * 10 + 1, id, 'user', title, null, null, null, started + 1)
    message.run(offset * 10 + 2, id, 'assistant', 'Inspecting.', null, JSON.stringify([{ id: `call-${offset}`, name: 'shell', arguments: { command: 'pwd' } }]), null, started + 2)
    message.run(offset * 10 + 3, id, 'tool', '/work', `call-${offset}`, null, null, started + 3)
  }
}

async function makeOpenclaw(): Promise<void> {
  openclawPath = join(home, '.openclaw', 'agents', 'main', 'agent', 'openclaw-agent.sqlite')
  const db = await database(openclawPath, `
    CREATE TABLE session_windows (session_id TEXT PRIMARY KEY);
    CREATE TABLE transcript_events (seq INTEGER PRIMARY KEY, session_id TEXT, event_json TEXT, event_zstd BLOB);`)
  const event = db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, NULL)')
  for (const [offset, id, title] of [[0, OPENCLAW_A, 'OpenClaw alpha title'], [1, OPENCLAW_B, 'OpenClaw beta title']] as const) {
    db.prepare('INSERT INTO session_windows VALUES (?)').run(id)
    const at = (seconds: number) => new Date(Date.parse(AT) + offset * 60_000 + seconds * 1000).toISOString()
    event.run(offset * 10 + 1, id, JSON.stringify({ type: 'message', id: `user-${offset}`, timestamp: at(0), message: { role: 'user', content: title } }))
    event.run(offset * 10 + 2, id, JSON.stringify({
      type: 'message', id: `assistant-${offset}`, timestamp: at(1),
      message: {
        role: 'assistant', provider: 'openclaw', model: 'openclaw-model', usage: { input: 10, output: 4 },
        content: [{ type: 'text', text: 'Running.' }, { type: 'toolCall', id: `call-${offset}`, name: 'shell', arguments: { command: 'ls' } }],
      },
    }))
    event.run(offset * 10 + 3, id, JSON.stringify({ type: 'message', id: `tool-${offset}`, timestamp: at(2), message: { role: 'toolResult', toolCallId: `call-${offset}`, content: 'done' } }))
  }
  db.close()
}

async function makeNanoclaw(): Promise<void> {
  const dir = join(home, '.nanoclaw', 'data', 'v2-sessions', 'group', NANOCLAW)
  nanoclawPath = join(dir, 'outbound.db')
  const inbound = await database(join(dir, 'inbound.db'), 'CREATE TABLE messages_in (id TEXT, timestamp TEXT, content TEXT, kind TEXT, seq INTEGER)')
  inbound.prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?, ?)').run('in-1', AT, 'NanoClaw metadata title', 'message', 1)
  inbound.close()
  const outbound = await database(nanoclawPath, 'CREATE TABLE messages_out (id TEXT, timestamp TEXT, content TEXT, kind TEXT, seq INTEGER)')
  outbound.prepare('INSERT INTO messages_out VALUES (?, ?, ?, ?, ?)').run('out-1', '2026-11-20T10:00:01.000Z', 'Metadata reply', 'message', 1)
  outbound.close()
}

async function makePrime(): Promise<void> {
  primePath = join(home, '.prime-provider', 'prime-agent-dirs', 'profile', 'sessions', `2026-11-20T10-00-00-000Z_${PRIME}.jsonl`)
  await mkdir(dirname(primePath), { recursive: true })
  const rows = [
    { type: 'session', id: 'prime-record-id-is-not-native-id', cwd: '/work/prime', timestamp: AT },
    { type: 'message', id: 'prime-user', timestamp: AT, message: { role: 'user', content: 'Prime format title' } },
    { type: 'message', id: 'prime-assistant', timestamp: '2026-11-20T10:00:01.000Z', message: {
      role: 'assistant', provider: 'prime', model: 'prime-model', usage: { input: 8, output: 3 },
      content: [{ type: 'text', text: 'Running.' }, { type: 'toolCall', id: 'prime-call', name: 'shell', arguments: { command: 'ls' } }],
    } },
    { type: 'message', id: 'prime-tool', timestamp: '2026-11-20T10:00:02.000Z', message: { role: 'toolResult', toolCallId: 'prime-call', content: 'done' } },
  ]
  await writeFile(primePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'traces-native-catalog-'))
  home = join(root, 'home')
  env = { HOME: home, XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(home, '.local', 'share') }
  await makeHermes()
  await makeOpenclaw()
  await makeNanoclaw()
  await makePrime()
})

afterAll(async () => {
  hermesDb?.close()
  await rm(root, { recursive: true, force: true })
})

describe('native reader catalog', () => {
  it('matches the held-out SDK catalog and never substitutes Claude for empty native stores', async () => {
    expect(listReaders().map((reader) => reader.harness)).toEqual([
      'claude-code', 'codex', 'opencode', 'pi', 'kimi-code', 'factory-droids', 'grok', 'nanoclaw', 'hermes', 'prime', 'openclaw',
    ])
    expect(listAdapters().map((adapter) => adapter.harness)).toEqual([
      'claude-code', 'codex', 'opencode', 'pi', 'kimi', 'factory', 'grok', 'nanoclaw', 'hermes', 'prime', 'openclaw', 'codex-exec',
    ])
    for (const [alias, harness] of [['claude', 'claude-code'], ['codex-acp', 'codex'], ['kimi-code', 'kimi'], ['factory-droids', 'factory'], ['openclaw', 'openclaw'], ['nanoclaw', 'nanoclaw']] as const) {
      expect(resolveAdapter(alias)?.harness).toBe(harness)
    }

    const aliasHome = join(root, 'alias-home')
    const id = 'c1a0de01-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const transcript = join(aliasHome, '.claude', 'projects', '-work', `${id}.jsonl`)
    await mkdir(dirname(transcript), { recursive: true })
    await writeFile(transcript, claudeTranscript(id, '/work', 0, 'Claude stays Claude'))
    for (const harness of ['openclaw', 'nanoclaw']) {
      const listed = await runCli(['list', '--harness', harness, '--format', 'json'], { env: { ...env, HOME: aliasHome } })
      expect(listed.code, listed.stderr).toBe(0)
      expect(JSON.parse(listed.stdout).sessions).toEqual([])
    }
  })

  it('discovers and reads every missing format through the SDK and physical CLI with native totals', async () => {
    const cases = [
      { harness: 'hermes', id: HERMES_A, path: hermesPath },
      { harness: 'openclaw', id: OPENCLAW_A, path: openclawPath },
      { harness: 'nanoclaw', id: NANOCLAW, path: nanoclawPath },
      { harness: 'prime', id: PRIME, path: primePath },
    ]
    for (const item of cases) {
      const refs = await readerFor(item.harness).locate(home, { nativeSessionId: item.id })
      expect(refs).toHaveLength(1)
      expect(refs[0]).toMatchObject({ harness: item.harness, nativeSessionId: item.id, path: item.path })
      const native = await readerFor(item.harness).read(refs[0]!)
      expect(native.startedAt).not.toBeNull()

      const listed = await run(['list', home, '--harness', item.harness, '--format', 'json'])
      expect(listed.code, listed.stderr).toBe(0)
      const rows = JSON.parse(listed.stdout).sessions as Array<{ id: string; harness: string }>
      expect(rows.some((row) => row.id === item.id && row.harness === item.harness)).toBe(true)
      expect(rows.every((row) => row.harness === item.harness)).toBe(true)

      const report = await facts(home, item.id, '--harness', item.harness)
      expect(report.harness).toBe(item.harness)
      expect(report.sessions).toHaveLength(1)
      expect(report.sessions[0]).toMatchObject({
        sessionId: item.id,
        harness: item.harness,
        firstRecordAt: { value: native.startedAt },
        toolCalls: { value: native.toolCalls.length },
        tokens: { modelCalls: native.modelCalls.filter((call) => call.usage !== null).length },
      })
    }
  })

  it('selects exact rows from direct and relocated SQLite stores and refuses conflicts and foreign stores', async () => {
    for (const { harness, path, ids } of [
      { harness: 'hermes', path: hermesPath, ids: [HERMES_A, HERMES_B] },
      { harness: 'openclaw', path: openclawPath, ids: [OPENCLAW_A, OPENCLAW_B] },
    ]) {
      const ambiguous = await run(['facts', path, '--format', 'json'])
      expect(ambiguous.code).toBe(2)
      expect(JSON.parse(ambiguous.stderr)).toMatchObject({ code: 'ambiguous' })
      for (const id of ids) {
        const direct = await facts(`${path}#session=${id}`)
        expect(direct.sessions.map((session) => [session.harness, session.sessionId])).toEqual([[harness, id]])
      }
    }

    const misleading = join(root, 'misleading', '.claude', 'projects', 'not-claude', 'state.db')
    await mkdir(dirname(misleading), { recursive: true })
    for (const suffix of ['', '-wal', '-shm']) await copyFile(`${hermesPath}${suffix}`, `${misleading}${suffix}`)
    const relocated = await facts(`${misleading}#session=${HERMES_B}`)
    expect(relocated.sessions[0]).toMatchObject({ harness: 'hermes', sessionId: HERMES_B })

    const foreign = join(root, 'foreign.db')
    const foreignDb = await database(foreign, 'CREATE TABLE unrelated (id TEXT)')
    foreignDb.close()
    const refused = await run(['facts', foreign, '--format', 'json'])
    expect(refused.code).toBe(2)
    expect(JSON.parse(refused.stderr)).toMatchObject({ code: 'unreadable' })

    const conflict = join(root, 'conflict.db')
    const conflictDb = await database(conflict, `
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE session_windows (session_id TEXT PRIMARY KEY);`)
    conflictDb.prepare('INSERT INTO sessions VALUES (?)').run(HERMES_A)
    conflictDb.prepare('INSERT INTO session_windows VALUES (?)').run(OPENCLAW_A)
    conflictDb.close()
    const conflicting = await run(['facts', conflict, '--format', 'json'])
    expect(conflicting.code).toBe(2)
    expect(JSON.parse(conflicting.stderr)).toMatchObject({ code: 'ambiguous' })
  })

  it('reads Prime and paired NanoClaw files with their own identities and unknown behavior coverage', async () => {
    const prime = await facts(primePath, '--harness', 'prime')
    expect(prime.sessions[0]).toMatchObject({ harness: 'prime', sessionId: PRIME, toolCalls: { value: 1 } })

    for (const path of [nanoclawPath, join(dirname(nanoclawPath), 'inbound.db')]) {
      const nano = await facts(path)
      expect(nano.sessions[0]).toMatchObject({ harness: 'nanoclaw', sessionId: NANOCLAW, toolCalls: { value: 0 }, tokens: { modelCalls: 0 } })
    }
    const behavior = await run(['behavior', nanoclawPath, '--format', 'json'])
    expect(behavior.code).toBe(2)
    expect(JSON.parse(behavior.stderr)).toMatchObject({ code: 'no-outcome' })

    for (const [path, harness] of [[hermesPath, 'hermes'], [openclawPath, 'openclaw'], [primePath, 'prime']] as const) {
      const ref = harness === 'prime' ? path : `${path}#session=${harness === 'hermes' ? HERMES_A : OPENCLAW_A}`
      const result = await run(['behavior', ref, '--format', 'json', ...(harness === 'prime' ? ['--harness', 'prime'] : [])])
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout).nodes[0]).toMatchObject({ harness, tool_calls: 1 })
    }
  })

  it('keeps public SDK rows separate and bundles paired stores and real SQLite sidecars', async () => {
    const [alpha] = await resolveRefs([`${hermesPath}#session=${HERMES_A}`])
    const [beta] = await resolveRefs([`${hermesPath}#session=${HERMES_B}`])
    if (alpha?.kind !== 'session' || beta?.kind !== 'session') throw new Error('Expected native sessions')
    const selected = await collectSessionSelection([{ adapter: alpha.adapter, refs: [alpha.session, beta.session] }])
    expect(selected.rows.map((row) => row.ref.sessionId)).toEqual([HERMES_A, HERMES_B])
    const titles = selected.rows.map((row) => row.spans.find((span) => span.name === 'user.prompt')?.attributes.content)
    expect(titles).toEqual(['Alpha release title', 'Beta unrelated title'])
    const spans = await parseSession(alpha.adapter, alpha.session)
    expect(spans.filter((span) => span.attributes['openinference.span.kind'] === 'LLM')).toHaveLength(1)
    expect(spans.filter((span) => span.attributes['openinference.span.kind'] === 'TOOL')).toHaveLength(1)
    expect(await alpha.adapter.sourcePaths?.(alpha.session)).toEqual(expect.arrayContaining([hermesPath, `${hermesPath}-wal`, `${hermesPath}-shm`]))

    for (const [name, ref, sources] of [
      ['hermes', `${hermesPath}#session=${HERMES_A}`, [hermesPath, `${hermesPath}-wal`, `${hermesPath}-shm`]],
      ['nanoclaw', nanoclawPath, [nanoclawPath, join(dirname(nanoclawPath), 'inbound.db')]],
    ] as const) {
      const out = join(root, `bundle-${name}`)
      const bundled = await run(['bundle', ref, '--out', out])
      expect(bundled.code, bundled.stderr).toBe(0)
      const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as { files: Array<{ path: string; sha256: string }> }
      const retained = await Promise.all(manifest.files.filter((file) => file.path === 'session/transcript.jsonl' || file.path.startsWith('session/sources/')).map(async (file) => ({
        sha256: file.sha256,
        bytes: await readFile(join(out, file.path)),
      })))
      for (const source of sources) {
        const bytes = await readFile(source)
        expect(retained.some((file) => file.bytes.equals(bytes))).toBe(true)
      }
      const verified = await run(['bundle', 'verify', out, '--format', 'json'])
      expect(verified.code, verified.stderr).toBe(0)
    }
  })
})
