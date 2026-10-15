/**
 * Two facts a reader of the human turns needs beside the turns themselves:
 * where the session ran, and what the person was answering.
 *
 * `cwd` is the working directory the harness recorded, read from the record
 * that states it, never decoded from the project directory's name. `answered`
 * is the last message the session's own agent wrote before each human turn.
 *
 * Sessions are read through the registered adapter the CLI uses. A harness
 * reads one whole session through the shared reader and a task-scoped read
 * through traces' own parser, and both must state the same directory.
 *
 * Every session below is written here by hand.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { OtlpSpan } from '../src/otlp.js'
import { resolveAdapter } from '../src/registry.js'
import { ANSWERED_TEXT_CAP, computeSessionFacts, type SessionFacts } from '../src/session-facts.js'
import type { ParseOptions, SessionRef } from '../src/types.js'
import { type Row, task, writeRollout } from './codex-facts-fixture.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-facts-cwd-answered-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A whole-session read, and the task-scoped read `--latest-turn` takes. */
const READS: ReadonlyArray<[string, ParseOptions]> = [['whole session', {}], ['latest task', { taskScope: 'latest' }]]

function only(facts: SessionFacts[]): SessionFacts {
  expect(facts).toHaveLength(1)
  return facts[0]!
}

function claudeRef(name: string, rows: readonly unknown[]): SessionRef {
  const path = join(dir, `${name}.jsonl`)
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  return { harness: 'claude-code', sessionId: name, path, cwd: null, mtimeMs: 0 }
}

async function factsOf(harness: string, ref: SessionRef, options: ParseOptions = {}): Promise<SessionFacts> {
  return only(computeSessionFacts(await spansOf(harness, ref, options)))
}

function spansOf(harness: string, ref: SessionRef, options: ParseOptions = {}): Promise<OtlpSpan[]> {
  return resolveAdapter(harness)!.parse(ref, options)
}

const human = (session: string, uuid: string, timestamp: string, text: string, cwd?: string) => ({
  type: 'user',
  uuid,
  sessionId: session,
  timestamp,
  userType: 'external',
  origin: { kind: 'human' },
  ...(cwd ? { cwd } : {}),
  message: { role: 'user', content: text },
})

const agent = (session: string, uuid: string, timestamp: string, text: string, cwd?: string) => ({
  type: 'assistant',
  uuid,
  sessionId: session,
  timestamp,
  ...(cwd ? { cwd } : {}),
  message: { id: `message-${uuid}`, role: 'assistant', model: 'test-model', content: [{ type: 'text', text }] },
})

/** A Codex turn the person typed. */
const typed = (t: number, text: string): Row => ({
  t,
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
})

const typedEvent = (t: number, text: string): Row => ({
  t,
  type: 'event_msg',
  payload: { type: 'user_message', message: text, images: [], local_images: [] },
})

const reply = (t: number, text: string): Row => ({
  t,
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
})

describe('session facts: cwd', () => {
  it.each(READS)('reads the directory a Claude Code record states (%s)', async (_read, options) => {
    const ref = claudeRef('claude-cwd', [
      // The first record carries no cwd; the directory comes from the first that does.
      { type: 'file-history-snapshot', messageId: 'snap', snapshot: {}, timestamp: '2026-03-01T10:00:00Z' },
      human('claude-cwd', 'u1', '2026-03-01T10:00:01Z', 'run the tests', '/work/my-project'),
      agent('claude-cwd', 'a1', '2026-03-01T10:00:02Z', 'They pass.', '/work/my-project/sub'),
    ])
    const spans = await spansOf('claude-code', ref, options)
    const facts = only(computeSessionFacts(spans))
    // The span it names is the session root, where the adapter recorded it.
    const root = spans.find((span) => span.parent_span_id === null)!
    expect(facts.cwd).toEqual({ value: '/work/my-project', spanIds: [root.span_id], unavailable: null })
  })

  it.each(READS)('is null with its reason when a Claude Code session records none (%s)', async (_read, options) => {
    const ref = claudeRef('claude-no-cwd', [
      human('claude-no-cwd', 'u1', '2026-03-01T10:00:01Z', 'run the tests'),
      agent('claude-no-cwd', 'a1', '2026-03-01T10:00:02Z', 'They pass.'),
    ])
    const facts = await factsOf('claude-code', ref, options)
    expect(facts.cwd.value).toBeNull()
    expect(facts.cwd.spanIds).toEqual([])
    expect(facts.cwd.unavailable).toContain('traces.session.cwd')
  })

  it.each(READS)('reads the directory Codex session_meta records (%s)', async (_read, options) => {
    const withCwd = writeRollout(dir, 'codex-cwd', [
      { t: 0, type: 'session_meta', payload: { id: 'codex-cwd', cwd: '/workspace/demo' } },
      { t: 0.5, type: 'turn_context', payload: { cwd: '/workspace/elsewhere', model: 'gpt-fixture' } },
      task(1, 'task_started', 'turn-1'),
      typed(2, 'list the files'),
      typedEvent(2.001, 'list the files'),
      task(3, 'task_complete', 'turn-1'),
    ])
    expect((await factsOf('codex', withCwd, options)).cwd.value).toBe('/workspace/demo')

    const without = writeRollout(dir, 'codex-no-cwd', [
      { t: 0, type: 'session_meta', payload: { id: 'codex-no-cwd' } },
      task(1, 'task_started', 'turn-1'),
      typed(2, 'list the files'),
      typedEvent(2.001, 'list the files'),
      task(3, 'task_complete', 'turn-1'),
    ])
    const facts = await factsOf('codex', without, options)
    expect(facts.cwd.value).toBeNull()
    expect(facts.cwd.unavailable).toContain('traces.session.cwd')
  })
})

describe('session facts: answered', () => {
  it('pairs each Claude Code turn with the agent message before it', async () => {
    const ref = claudeRef('claude-answered', [
      human('claude-answered', 'u1', '2026-03-01T10:00:01Z', 'what broke?'),
      agent('claude-answered', 'a1', '2026-03-01T10:00:02Z', 'Looking at the logs.'),
      agent('claude-answered', 'a2', '2026-03-01T10:00:03Z', 'The parser broke. Should I fix it?'),
      human('claude-answered', 'u2', '2026-03-01T10:00:04Z', 'yes'),
    ])
    const [first, second] = (await factsOf('claude-code', ref)).humanTurns.value!
    // Nothing came before the first turn.
    expect(first!.answered).toBeNull()
    expect(first!.answeredSpanId).toBeNull()
    // The second answers the LAST message before it, not the first one after the turn before.
    expect(second!.text).toBe('yes')
    expect(second!.answered).toBe('The parser broke. Should I fix it?')
    expect(second!.answeredSpanId).toEqual(expect.any(String))
  })

  it('clips a long agent message and says how much it cut', async () => {
    const long = `${'a'.repeat(ANSWERED_TEXT_CAP)}${'b'.repeat(700)}`
    const ref = claudeRef('claude-clipped', [
      human('claude-clipped', 'u1', '2026-03-01T10:00:01Z', 'write the report'),
      agent('claude-clipped', 'a1', '2026-03-01T10:00:02Z', long),
      human('claude-clipped', 'u2', '2026-03-01T10:00:03Z', 'shorter please'),
    ])
    const answered = (await factsOf('claude-code', ref)).humanTurns.value![1]!.answered!
    expect(ANSWERED_TEXT_CAP).toBe(1500)
    expect(answered).toBe(`${'a'.repeat(ANSWERED_TEXT_CAP)}… [+700 chars]`)

    // A cut inside an emoji must not leave half of it: the lone high surrogate is dropped and counted hidden.
    const emoji = `${'a'.repeat(ANSWERED_TEXT_CAP - 1)}😀${'b'.repeat(10)}`
    const emojiRef = claudeRef('claude-clipped-emoji', [
      human('claude-clipped-emoji', 'u1', '2026-03-01T10:00:01Z', 'write the report'),
      agent('claude-clipped-emoji', 'a1', '2026-03-01T10:00:02Z', emoji),
      human('claude-clipped-emoji', 'u2', '2026-03-01T10:00:03Z', 'shorter please'),
    ])
    const clipped = (await factsOf('claude-code', emojiRef)).humanTurns.value![1]!.answered!
    expect(clipped).toBe(`${'a'.repeat(ANSWERED_TEXT_CAP - 1)}… [+${emoji.length - (ANSWERED_TEXT_CAP - 1)} chars]`)
  })

  it('reads the message a Codex turn answered', async () => {
    const ref = writeRollout(dir, 'codex-answered', [
      { t: 0, type: 'session_meta', payload: { id: 'codex-answered', cwd: '/workspace/demo' } },
      task(1, 'task_started', 'turn-1'),
      typed(2, 'which test fails?'),
      typedEvent(2.001, 'which test fails?'),
      reply(3, 'parser.test.ts fails on the empty input.'),
      task(4, 'task_complete', 'turn-1'),
      task(5, 'task_started', 'turn-2'),
      typed(6, 'fix it'),
      typedEvent(6.001, 'fix it'),
      task(7, 'task_complete', 'turn-2'),
    ])
    const facts = await factsOf('codex', ref)
    expect(facts.humanTurns.value!.map((turn) => [turn.text, turn.answered])).toEqual([
      ['which test fails?', null],
      ['fix it', 'parser.test.ts fails on the empty input.'],
    ])
  })

  it('is withheld with the turn text when content is not requested', async () => {
    const ref = claudeRef('claude-metadata', [
      human('claude-metadata', 'u1', '2026-03-01T10:00:01Z', 'go', '/work/private'),
      agent('claude-metadata', 'a1', '2026-03-01T10:00:02Z', 'Done with the secret plan.'),
      human('claude-metadata', 'u2', '2026-03-01T10:00:03Z', 'thanks'),
    ])
    const facts = only(computeSessionFacts(await spansOf('claude-code', ref), { includeContent: false }))
    expect(facts.humanTurns).toEqual({ value: null, spanIds: [], unavailable: 'Content was not requested.' })
    expect(facts.cwd).toEqual({ value: null, spanIds: [], unavailable: 'Content was not requested.' })
    expect(JSON.stringify(facts)).not.toContain('secret plan')
    expect(JSON.stringify(facts)).not.toContain('/work/private')
  })
})
