/**
 * `traces facts <file> --harness claude-code` reads through the default
 * path (HarnessSessionsAdapter → harness-sessions), not ClaudeAdapter. Claude Code
 * (2026-10) writes its own command records with no `origin` field and string
 * content; they must not count as the person's turns, and a typed slash command
 * must read as the line the person typed. A command that drives the harness
 * (`/effort`) is the person's, but not a turn of the conversation.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import type { SessionFactsReport } from '../src/session-facts.js'

const execFileAsync = promisify(execFile)
const dir = mkdtempSync(join(tmpdir(), 'traces-facts-harness-records-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const SESSION = 'harness-records'
const TYPED = 'now fix the flaky parser test'

const userRecord = (uuid: string, timestamp: string, content: string, extra: object = {}) => ({
  type: 'user',
  uuid,
  timestamp,
  sessionId: SESSION,
  isSidechain: false,
  userType: 'external',
  entrypoint: 'cli',
  cwd: '/tmp/x',
  ...extra,
  message: { role: 'user', content },
})

const rows = [
  userRecord(
    'u1',
    '2026-10-15T10:00:00Z',
    '<local-command-caveat>The command below was run directly in Claude Code, not sent to you.</local-command-caveat>',
    { isMeta: true },
  ),
  userRecord(
    'u2',
    '2026-10-15T10:00:01Z',
    '<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args></command-args>',
  ),
  userRecord(
    'u3',
    '2026-10-15T10:00:02Z',
    '<local-command-stdout>Ultracode on (this session only): dynamic workflows on every task.</local-command-stdout>',
  ),
  userRecord(
    'u3b',
    '2026-10-15T10:00:02.500Z',
    '<command-name>/reflect-last</command-name>\n            <command-message>reflect-last</command-message>\n            <command-args>yesterday</command-args>',
  ),
  userRecord('u4', '2026-10-15T10:00:03Z', TYPED),
  {
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-10-15T10:00:04Z',
    sessionId: SESSION,
    cwd: '/tmp/x',
    message: { id: 'message-a1', role: 'assistant', model: 'test-model', content: [{ type: 'text', text: 'Fixed.' }] },
  },
]

describe('traces facts on real Claude Code harness records', () => {
  it('counts the typed skill command and prompt, not the command caveat, stdout or a harness command', async () => {
    const file = join(dir, `${SESSION}.jsonl`)
    writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'facts', file, '--harness', 'claude-code', '--format', 'json'],
      { cwd: process.cwd(), env: { ...process.env, HOME: dir, NO_COLOR: '1', FORCE_COLOR: '' }, maxBuffer: 16 * 1024 * 1024 },
    )
    const [facts] = (JSON.parse(stdout) as SessionFactsReport).sessions
    expect(facts!.humanTurns.value!.map((turn) => turn.text)).toEqual(['/reflect-last yesterday', TYPED])
    expect(facts!.excludedTurns.value).toContainEqual(expect.objectContaining({
      author: 'human', turns: 1, reason: expect.stringContaining('a command the person gave the harness'),
    }))
  })
})
