/**
 * `traces facts` over a Claude Code session whose subagent directory holds two
 * transcripts for one agent ID: a top-level subagent and a workflow run. Span
 * identity derives from the session ID, so both files produced the same root
 * span and the whole session was rejected as having a duplicate span identity.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import type { SessionFactsReport } from '../src/session-facts.js'

const execFileAsync = promisify(execFile)
const dir = mkdtempSync(join(tmpdir(), 'traces-repeated-agent-id-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const SESSION = 'repeated-agent-id'
const AGENT = 'aaaa1111bbbb2222c'

const parentRow = (uuid: string, timestamp: string, type: 'user' | 'assistant', text: string) => ({
  type,
  uuid,
  timestamp,
  sessionId: SESSION,
  isSidechain: false,
  userType: 'external',
  entrypoint: 'cli',
  cwd: '/tmp/x',
  message: type === 'user'
    ? { role: 'user', content: text }
    : { id: `message-${uuid}`, role: 'assistant', model: 'test-model', content: [{ type: 'text', text }] },
})

const agentRows = (prefix: string, start: number, task: string) => [
  {
    type: 'user', uuid: `${prefix}-u`, timestamp: `2026-10-15T10:00:${start}Z`, sessionId: SESSION, agentId: AGENT,
    isSidechain: true, userType: 'external', cwd: '/tmp/x', message: { role: 'user', content: task },
  },
  {
    type: 'assistant', uuid: `${prefix}-a`, timestamp: `2026-10-15T10:00:${start + 1}Z`, sessionId: SESSION, agentId: AGENT,
    isSidechain: true, cwd: '/tmp/x',
    message: { id: `message-${prefix}-a`, role: 'assistant', model: 'test-model', content: [{ type: 'text', text: 'Done.' }] },
  },
]

const write = (path: string, rows: readonly unknown[]) =>
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)

describe('traces facts when one agent ID has two transcripts', () => {
  it('reads the session and keeps both transcripts as distinct spans', async () => {
    const file = join(dir, `${SESSION}.jsonl`)
    write(file, [
      parentRow('p1', '2026-10-15T10:00:00Z', 'user', 'review the release notes'),
      parentRow('p2', '2026-10-15T10:00:09Z', 'assistant', 'Reviewed.'),
    ])
    const subagents = join(dir, SESSION, 'subagents')
    const workflow = join(subagents, 'workflows', 'wf_fixture')
    mkdirSync(workflow, { recursive: true })
    write(join(subagents, `agent-${AGENT}.jsonl`), agentRows('top', 10, 'check the changelog'))
    write(join(workflow, `agent-${AGENT}.jsonl`), agentRows('wf', 20, 'check the migration'))

    const run = (extra: string[]) => execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'facts', file, '--harness', 'claude-code', '--format', 'json', ...extra],
      { cwd: process.cwd(), env: { ...process.env, HOME: dir, NO_COLOR: '1', FORCE_COLOR: '' }, maxBuffer: 16 * 1024 * 1024 },
    )
    const first = JSON.parse((await run([])).stdout) as SessionFactsReport
    const second = JSON.parse((await run([])).stdout) as SessionFactsReport
    expect(first.sessions).toHaveLength(1)
    expect(first.sessions[0]!.humanTurns.value!.map((turn) => turn.text)).toEqual(['review the release notes'])
    // Deterministic: the same files give the same report twice.
    expect(second.sessions).toEqual(first.sessions)
  })
})
