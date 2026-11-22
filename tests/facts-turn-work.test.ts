/**
 * `traces facts --format jsonl`: each typed turn's `work`, what the agent did
 * since the person's previous turn, read from a recorded run (the root and one
 * worker of the Discovery run magnetar-rust-sandbox-20261101d, as its producer
 * exported them from the kept Codex sessions). The oracle counts the run's own
 * TOOL spans between consecutive turns straight from the file, never from facts.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { runCli } from './run-cli.js'

const RUN = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'causality', 'magnetar-rust-sandbox-20261101d.jsonl')

interface RawSpan {
  trace_id: string
  parent_span_id: string
  name: string
  start_time: string
  attributes: Record<string, unknown>
}

interface Work {
  index: number
  durationMs: number
  toolCalls: number
  toolCallsByName: Record<string, number>
  failedToolCalls: number
  agentMessages: number
  reply: unknown
}

interface Row {
  session: string
  at: string
  author: string
  work: Work
}

let raw: RawSpan[]
let rows: Row[]
let stdout: string

beforeAll(async () => {
  raw = (await readFile(RUN, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as RawSpan)
  const run = await runCli(['facts', RUN, '--format', 'jsonl', '--no-content'])
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  stdout = run.stdout
  rows = run.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as Row)
})

const sessionOf = (span: RawSpan): string => span.attributes['tangle.sessionId'] as string

describe('facts --format jsonl --no-content: the work before each turn of a recorded run', () => {
  it('prints one row per typed turn, with its work and without its text, cwd or record', () => {
    expect(rows).toHaveLength(18)
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['at', 'author', 'harness', 'host', 'interrupted', 'session', 'signals', 'spanId', 'work'])
    }
  })

  it("counts each turn's tool calls since the previous turn, as the recorded spans do", () => {
    for (const session of new Set(rows.map((row) => row.session))) {
      const turns = rows.filter((row) => row.session === session)
      const own = raw.filter((span) => sessionOf(span) === session && span.parent_span_id !== '')
      const tools = own.filter((span) => span.attributes['openinference.span.kind'] === 'TOOL')
      const expected = turns.map((turn, index) => {
        const from = index === 0 ? Number.NEGATIVE_INFINITY : Date.parse(turns[index - 1]!.at)
        return tools.filter((span) => Date.parse(span.start_time) >= from && Date.parse(span.start_time) < Date.parse(turn.at)).length
      })
      expect(turns.map((turn) => turn.work.toolCalls)).toEqual(expected)
      expect(turns.map((turn) => turn.work.index)).toEqual(turns.map((_, index) => index))
      // The first turn's work runs from the session's first record: the brief it was started on.
      const first = Math.min(...own.map((span) => Date.parse(span.start_time)))
      expect(turns.map((turn) => turn.work.durationMs)).toEqual(
        turns.map((turn, index) => Date.parse(turn.at) - (index === 0 ? first : Date.parse(turns[index - 1]!.at))),
      )
    }
    // The root spawned its worker and ran five commands before the person's first turn, and one more before the second.
    const root = rows.filter((row) => row.session === '01a19685-f1a1-79e2-aa02-3021c2b63f45')
    expect(root.map((row) => row.work.toolCalls)).toEqual([6, 1, 0, 0, 0, 0])
    expect(root[0]!.work.toolCallsByName).toEqual({ exec: 5, mcp__agent_runtime_coordination__spawn_worker: 1 })
  })

  it("adds up, over a session's turns, to the tool calls the sheet states when none came after the last turn", async () => {
    const run = await runCli(['facts', RUN, '--format', 'json', '--no-content'])
    expect(run.code).toBe(0)
    const sheet = JSON.parse(run.stdout) as { sessions: Array<{ sessionId: string; toolCalls: { value: number } }> }
    for (const facts of sheet.sessions) {
      const turns = rows.filter((row) => row.session === facts.sessionId)
      if (turns.length === 0) continue
      expect(turns.reduce((total, turn) => total + turn.work.toolCalls, 0)).toBe(facts.toolCalls.value)
    }
  })

  it('carries no content: no prompt, command or path of the recording', () => {
    expect(stdout).not.toContain('"text"')
    expect(stdout).not.toContain('"cwd"')
    expect(stdout).not.toContain('recordFile')
    for (const row of rows) expect(row.work.reply).toBeNull()
  })
})
