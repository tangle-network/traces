/** The real CLI's window export stays equivalent to named facts and cites native source records. */
import { readFile } from 'node:fs/promises'
import { beforeAll, expect, it } from 'vitest'
import { makeConversationHome, type ConversationHome } from './fixtures/conversation.js'
import { runCli } from './run-cli.js'

let fx: ConversationHome
beforeAll(async () => { fx = await makeConversationHome() })

it('window JSONL preserves turn/reply semantics and cites every human, fleet and relay turn', async () => {
  const argv = ['--since', '2026-10-14T00:00:00Z', '--until', '2026-10-15T00:00:00Z', '--harness', 'claude-code']
  const run = await runCli(['facts', ...argv, '--format', 'jsonl'], { env: fx.env })
  expect(run.code, run.stderr).toBe(0)
  const rows = run.stdout.trim().split('\n').map((line) => JSON.parse(line))
    .filter((row) => row.session === fx.paths.claude.split('/').at(-1)!.replace('.jsonl', ''))
  expect(rows).toHaveLength(6)
  const native = (await readFile(fx.paths.claude, 'utf8')).split('\n').map((line) => line ? JSON.parse(line) : null)
  for (const row of rows) {
    expect(row.recordFile).toBe(fx.paths.claude)
    expect(row.record).toMatchObject({ file: fx.paths.claude, line: expect.any(Number) })
    expect(native[row.record.line - 1].timestamp).toBe(row.at)
  }
  const full = await runCli(['facts', fx.paths.claude, '--format', 'json'], { env: fx.env })
  expect(full.code, full.stderr).toBe(0)
  const human = JSON.parse(full.stdout).sessions[0].humanTurns.value
  const fields = ['at', 'text', 'answered', 'reply', 'interrupted', 'signals', 'spanId']
  const pick = (row: Record<string, unknown>) => Object.fromEntries(fields.map((key) => [key, row[key]]))
  expect(rows.filter((row) => row.author === 'human').map(pick)).toEqual(human.map(pick))
})

it('a clipped long first brief retains its source citation', async () => {
  const run = await runCli(['facts', fx.paths.unknown, '--format', 'jsonl'], { env: fx.env })
  expect(run.code, run.stderr).toBe(0)
  const [row] = run.stdout.trim().split('\n').map((line) => JSON.parse(line))
  expect(row.author).toBe('fleet')
  expect(row.recordFile).toBe(fx.paths.unknown)
  expect(row.record).toMatchObject({ file: fx.paths.unknown, line: expect.any(Number) })
})
