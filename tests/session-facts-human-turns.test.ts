/**
 * Which `user.prompt` turns are turns a person typed into THIS session.
 *
 * The measured gap this closes: on a private battery of thirteen Codex
 * sessions the free facts sheet counted every span whose actor was `human`,
 * including the history a forked session copies from its parent and the turns a
 * compaction replays. It scored 0.076 on "how many user messages are there, and
 * what do the first and last say?" while the spans already carried the answer.
 *
 * The rule the tests hold the sheet to is the one an auditor applies by hand: a
 * user message is one the human typed. Instruction files, environment-context
 * blocks, subagent notifications and skill expansions are the harness feeding
 * the model; a turn recorded twice is one turn; and history a session carries
 * but did not receive is not a turn of this session.
 *
 * Every rollout below is written here by hand.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/adapters/codex.js'
import type { OtlpSpan } from '../src/otlp.js'
import { computeSessionFacts, type SessionFacts } from '../src/session-facts.js'
import {
  AGENTS_BLOCK,
  ENVIRONMENT_BLOCK,
  ms,
  type Row,
  task,
  userItem,
  userItemCompleted,
  writeRollout as writeRolloutIn,
} from './codex-facts-fixture.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-facts-turns-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const writeRollout = (name: string, rows: readonly Row[]) => writeRolloutIn(dir, name, rows)

/** A user-role response item carrying Codex's own per-item labelling. */
const labelled = (t: number, texts: readonly string[], kinds: readonly string[]): Row => ({
  t,
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: texts.map((text) => ({ type: 'input_text', text })),
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-1', content_item_kinds: kinds },
  },
})

async function factsFor(name: string, rows: readonly Row[]): Promise<SessionFacts> {
  const [facts, ...rest] = computeSessionFacts(await new CodexAdapter().parse(writeRollout(name, rows)))
  expect(rest).toEqual([])
  return facts!
}

const texts = (facts: SessionFacts) => facts.humanTurns.value!.map((turn) => turn.text)
const excludedFor = (facts: SessionFacts, fragment: string) =>
  facts.excludedTurns.value!.filter((entry) => entry.reason.includes(fragment))

const TYPED = 'rerun the parser tests and tell me which one still fails'
const FOLLOW_UP = 'do it'

describe('session facts: human turns', () => {
  it('counts the typed turns and no injected block, whatever the block is', async () => {
    const facts = await factsFor('injected', [
      { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
      { t: 0.5, type: 'turn_context', payload: { cwd: '/workspace/demo', model: 'gpt-fixture' } },
      // An AGENTS.md file and an environment block, both recorded as user-role
      // messages, both labelled by Codex as what they are.
      labelled(0.6, [AGENTS_BLOCK], ['agents_md.instructions']),
      labelled(0.7, [ENVIRONMENT_BLOCK], ['environments.environment_context']),
      task(1, 'task_started', 'turn-1'),
      labelled(2, [TYPED], ['user.text']),
      {
        t: 3,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one fails' }] },
      },
      // A block the harness added after the last typed turn: a reader that
      // trusts the user role reports this as the session's last human message.
      labelled(4, [ENVIRONMENT_BLOCK.replace('zsh', 'fish')], ['environments.environment_context']),
      task(5, 'task_complete', 'turn-1'),
    ])

    expect(texts(facts)).toEqual([TYPED])
    expect(facts.humanTurns.value![0]!.at).toBe(new Date(ms(2)).toISOString())
    expect(excludedFor(facts, 'harness-injected content')).toEqual([
      expect.objectContaining({ turns: 3 }),
    ])
    // Every excluded span is named, so the exclusion can be checked or undone.
    expect(excludedFor(facts, 'harness-injected content')[0]!.spanIds).toHaveLength(3)
    expect(facts.turnsByActor.value).toEqual([
      expect.objectContaining({ actor: 'human', turns: 1 }),
      expect.objectContaining({ actor: 'injected', turns: 3 }),
    ])
  })

  it('counts a turn once when the rollout records it twice', async () => {
    const facts = await factsFor('twice', [
      { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
      task(1, 'task_started', 'turn-1'),
      // Codex logs one submitted turn as a response item and as an
      // `item_completed` UserMessage. Both records describe the same typing.
      labelled(2, [TYPED], ['user.text']),
      userItemCompleted(2.001, 'item-user-1', TYPED),
      task(3, 'task_complete', 'turn-1'),
      task(4, 'task_started', 'turn-2'),
      userItemCompleted(5, 'item-user-2', FOLLOW_UP),
      labelled(5.001, [FOLLOW_UP], ['user.text']),
      task(6, 'task_complete', 'turn-2'),
    ])
    expect(texts(facts)).toEqual([TYPED, FOLLOW_UP])
  })

  it('collapses a duplicate the adapter did not pair, and says it did', async () => {
    const spans = await new CodexAdapter().parse(writeRollout('backstop', [
      { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
      task(1, 'task_started', 'turn-1'),
      labelled(2, [TYPED], ['user.text']),
      task(3, 'task_complete', 'turn-1'),
    ]))
    const turn = spans.find((span) => span.name === 'user.prompt')!
    // A second record of the same submission, from a harness whose two logs the
    // adapter could not pair: one instant, one text, nothing in between.
    const echo: OtlpSpan = {
      ...turn,
      span_id: `${turn.span_id}-echo`,
      attributes: { ...turn.attributes, step: Number(turn.attributes.step) + 0.5 },
    }
    const [facts] = computeSessionFacts([...spans, echo])
    expect(texts(facts!)).toEqual([TYPED])
    expect(excludedFor(facts!, 'a second record of the turn before it')).toEqual([
      { reason: expect.stringContaining('a second record'), turns: 1, spanIds: [echo.span_id] },
    ])
  })

  it('keeps a repeated message the person actually sent twice', async () => {
    const facts = await factsFor('repeat', [
      { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
      task(1, 'task_started', 'turn-1'),
      labelled(2, [FOLLOW_UP], ['user.text']),
      {
        t: 3,
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls' }) },
      },
      { t: 3.5, type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'src\n' } },
      task(4, 'task_complete', 'turn-1'),
      task(5, 'task_started', 'turn-2'),
      labelled(6, [FOLLOW_UP], ['user.text']),
      task(7, 'task_complete', 'turn-2'),
    ])
    expect(texts(facts)).toEqual([FOLLOW_UP, FOLLOW_UP])
    expect(excludedFor(facts, 'a second record of the turn before it')).toEqual([])
  })

  it('keeps a message queued twice while the agent was still working', async () => {
    // Measured on a real session: a person typed "continue" twice, 1.8 s apart,
    // with nothing recorded in between because the agent was mid-turn. A
    // duplicate rule that allowed any short gap counted that as one turn.
    const facts = await factsFor('queued', [
      { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
      task(1, 'task_started', 'turn-1'),
      labelled(2, ['continue'], ['user.text']),
      labelled(3.8, ['continue'], ['user.text']),
      task(4, 'task_complete', 'turn-1'),
    ])
    expect(texts(facts)).toEqual(['continue', 'continue'])
    expect(excludedFor(facts, 'a second record of the turn before it')).toEqual([])
  })

  it('does not count history a forked session copied from its parent', async () => {
    const facts = await factsFor('fork', [
      {
        t: 0,
        type: 'session_meta',
        payload: {
          id: 'child-session',
          cwd: '/workspace/demo',
          parent_thread_id: 'parent-session',
          thread_source: 'subagent',
        },
      },
      // The parent's history, rewritten into the child's rollout with the fork
      // time. A person typed it — into the parent thread, not into this session.
      labelled(0.6, ['what is slow about the uploader?'], ['user.text']),
      labelled(0.7, ['and what did you try already?'], ['user.text']),
      // The child's own task begins here.
      task(1, 'task_started', 'child-session'),
      {
        t: 2,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'retries dominate' }] },
      },
      task(3, 'task_complete', 'child-session'),
    ])

    expect(facts.humanTurns.value).toEqual([])
    const inherited = excludedFor(facts, 'context this session carries but did not receive')
    expect(inherited).toEqual([expect.objectContaining({ turns: 2 })])
    expect(inherited[0]!.reason).toContain('pre-task-prefix')
    // The words are still in the trace; only the count excludes them.
    expect(facts.turnsByActor.value).toEqual([expect.objectContaining({ actor: 'human', turns: 2 })])
  })

  it("takes Codex's own item labelling over what the text looks like", async () => {
    const brief = `You are the reviewer for this change. ${'Read every file. '.repeat(120)}`
    const labelledFacts = await factsFor('brief-labelled', [
      { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
      task(1, 'task_started', 'turn-1'),
      labelled(2, [brief], ['user.text']),
      task(3, 'task_complete', 'turn-1'),
    ])
    // Long, and it opens like an agent brief — but Codex recorded it as the
    // person's own text, and that is what the session log says happened.
    expect(labelledFacts.humanTurns.value).toHaveLength(1)

    const unlabelledFacts = await factsFor('brief-unlabelled', [
      { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
      task(1, 'task_started', 'turn-1'),
      userItem(2, [{ type: 'input_text', text: brief }]),
      task(3, 'task_complete', 'turn-1'),
    ])
    // Without the labelling there is nothing structural to go on, so the text
    // heuristic still calls a first-turn agent brief an injected prompt.
    expect(unlabelledFacts.humanTurns.value).toEqual([])
    expect(excludedFor(unlabelledFacts, 'harness-injected content')).toHaveLength(1)
  })
})
