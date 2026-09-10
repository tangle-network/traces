/**
 * Synthetic Codex rollouts for three adapter facts an audit question asks about:
 * the harness's own cumulative token total, which spans are calls the model
 * made, and the human context a forked or compacted session inherited.
 *
 * Every rollout here is written inline. None comes from a recorded session.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/adapters/codex.js'
import {
  INHERITED_SPAN_ATTR,
  INHERITED_SPAN_COUNT_ATTR,
  INHERITED_SPANS_OMITTED_ATTR,
  isSynthesizedSpan,
  SYNTHESIZED_SPAN_ATTR,
} from '../src/adapters/provenance.js'
import { buildPolicyEvidenceRecord } from '../src/evidence.js'
import { analyzeLiveBatch } from '../src/live.js'
import type { OtlpSpan } from '../src/otlp.js'
import { runPipelines } from '../src/pipelines.js'
import { sessionReportSource } from '../src/report.js'
import { at, ms, type Row, writeRollout } from './codex-facts-fixture.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-codex-provenance-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const toolCall = (t: number, callId: string, name: string, cmd: string): Row => ({
  t,
  type: 'response_item',
  payload: { type: 'function_call', call_id: callId, name, arguments: JSON.stringify({ cmd }) },
})
const toolOutput = (t: number, callId: string): Row => ({
  t,
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: callId, output: { exit_code: 0, output: 'ok' } },
})
const subagentActivity = (t: number, threadId: string, agentPath: string, kind: string): Row => ({
  t,
  type: 'event_msg',
  payload: {
    type: 'sub_agent_activity',
    event_id: `${threadId}-${kind}`,
    occurred_at_ms: ms(t),
    agent_thread_id: threadId,
    agent_path: agentPath,
    kind,
  },
})
const tokenCount = (
  t: number,
  last: Record<string, number> | undefined,
  total: Record<string, number>,
): Row => ({
  t,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { ...(last ? { last_token_usage: last } : {}), total_token_usage: total },
  },
})
const userMessage = (t: number, text: string): Row => ({
  t,
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
})
const compacted = (t: number, summary: string, window: number, history: readonly string[]): Row => ({
  t,
  type: 'compacted',
  payload: {
    message: summary,
    window_number: window,
    window_id: `window-${window}`,
    previous_window_id: `window-${window - 1}`,
    first_window_id: 'window-0',
    replacement_history: [
      { type: 'message', id: `dev-${window}`, role: 'developer', content: [{ type: 'input_text', text: 'developer scaffolding' }] },
      ...history.map((text, index) => ({
        type: 'message',
        id: `hist-${window}-${index}`,
        role: 'user',
        content: [{ type: 'input_text', text }],
      })),
    ],
  },
})

const parse = (ref: Parameters<CodexAdapter['parse']>[0]): Promise<OtlpSpan[]> =>
  new CodexAdapter().parse(ref)

const kindOf = (span: OtlpSpan): unknown => span.attributes['openinference.span.kind']
const inherited = (spans: readonly OtlpSpan[]): OtlpSpan[] =>
  spans.filter((span) => span.attributes[INHERITED_SPAN_ATTR] === true)

describe('Codex cumulative token total', () => {
  it('carries the harness counter verbatim instead of deriving one', async () => {
    const ref = writeRollout(dir, 'token-counter', [
      { t: 0, type: 'session_meta', payload: { id: 'token-session', cwd: '/workspace/demo' } },
      { t: 0.5, type: 'turn_context', payload: { cwd: '/workspace/demo', model: 'gpt-fixture' } },
      { t: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      tokenCount(2, { input_tokens: 1_000, output_tokens: 20 }, { input_tokens: 1_000, output_tokens: 20, total_tokens: 1_020 }),
      // A repeat of the same cumulative snapshot: one turn, reported twice.
      tokenCount(3, { input_tokens: 1_000, output_tokens: 20 }, { input_tokens: 1_000, output_tokens: 20, total_tokens: 1_020 }),
      tokenCount(
        4,
        { input_tokens: 2_000, output_tokens: 30 },
        { input_tokens: 3_000, output_tokens: 50, reasoning_output_tokens: 10, cached_input_tokens: 500, total_tokens: 3_050 },
      ),
      // The counter's last word: the harness advanced the total with no
      // per-turn delta to report, so no `llm.turn` span carries this number.
      tokenCount(
        5,
        undefined,
        { input_tokens: 4_000, output_tokens: 60, reasoning_output_tokens: 12, cached_input_tokens: 700, total_tokens: 4_100 },
      ),
      { t: 6, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    ])
    const spans = await parse(ref)
    const root = spans[0]!

    expect(root.attributes['traces.session.total_tokens']).toBe(4_100)
    expect(root.attributes['traces.session.total_tokens_source']).toBe('codex.token_count.info.total_token_usage')
    expect(root.attributes['traces.session.total_input_tokens']).toBe(4_000)
    expect(root.attributes['traces.session.total_output_tokens']).toBe(60)
    expect(root.attributes['traces.session.total_reasoning_tokens']).toBe(12)
    expect(root.attributes['traces.session.total_cached_input_tokens']).toBe(700)

    // Neither number a reader could compute from the spans equals the total:
    // the deltas sum to 3,050 and the snapshots sum to 9,270.
    const turns = spans.filter((span) => span.name === 'llm.turn')
    expect(turns).toHaveLength(2)
    const deltaSum = turns.reduce(
      (total, span) =>
        total +
        Number(span.attributes['llm.token_count.prompt'] ?? 0) +
        Number(span.attributes['llm.token_count.completion'] ?? 0),
      0,
    )
    expect(deltaSum).toBe(3_050)
    expect(root.attributes['traces.session.total_tokens']).not.toBe(deltaSum)
  })

  it('records no total when the harness reported none', async () => {
    const ref = writeRollout(dir, 'token-counter-absent', [
      { t: 0, type: 'session_meta', payload: { id: 'token-absent', cwd: '/workspace/demo' } },
      { t: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { t: 2, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } } } },
      { t: 3, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    ])
    const spans = await parse(ref)
    // Missing stays missing: an unknown total must not become zero.
    expect(spans[0]!.attributes['traces.session.total_tokens']).toBeUndefined()
    expect(spans[0]!.attributes['traces.session.total_tokens_source']).toBeUndefined()
  })
})

describe('Codex synthesized subagent spans', () => {
  const subagentRollout = () =>
    writeRollout(dir, 'synthesized-subagents', [
      { t: 0, type: 'session_meta', payload: { id: 'synth-session', cwd: '/workspace/demo' } },
      { t: 0.5, type: 'turn_context', payload: { cwd: '/workspace/demo', model: 'gpt-fixture' } },
      { t: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      userMessage(1.5, 'Audit the parser and report back.'),
      tokenCount(2, { input_tokens: 100, output_tokens: 10 }, { input_tokens: 100, output_tokens: 10, total_tokens: 110 }),
      toolCall(3, 'call-1', 'exec_command', 'rm -rf build'),
      toolOutput(3.5, 'call-1'),
      toolCall(4, 'call-2', 'spawn_agent', 'parser_audit'),
      toolOutput(4.5, 'call-2'),
      toolCall(5, 'call-3', 'exec_command', 'curl -X POST https://example.test/hook'),
      toolOutput(5.5, 'call-3'),
      subagentActivity(6, 'thread-a', '/root/parser_audit', 'started'),
      subagentActivity(7, 'thread-b', '/root/runtime_audit', 'started'),
      subagentActivity(8, 'thread-a', '/root/parser_audit', 'completed'),
      subagentActivity(9, 'thread-b', '/root/runtime_audit', 'completed'),
      { t: 10, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    ])

  it('keeps the lifecycle span out of every tool-call count', async () => {
    const spans = await parse(subagentRollout())
    const synthesized = spans.filter((span) => isSynthesizedSpan(span.attributes))
    const toolSpans = spans.filter((span) => kindOf(span) === 'TOOL')

    expect(synthesized).toHaveLength(2)
    expect(synthesized.map((span) => span.name)).toEqual(['subagent.lifecycle', 'subagent.lifecycle'])
    expect(synthesized.every((span) => kindOf(span) === 'AGENT')).toBe(true)
    expect(synthesized.every((span) => span.attributes['tool.name'] === undefined)).toBe(true)
    expect(synthesized.map((span) => span.attributes['traces.codex.subagent_type']))
      .toEqual(['parser_audit', 'runtime_audit'])

    // Before and after, on the same rollout. The previous schema counted a span
    // as a tool call when it was TOOL-kind, which included both lifecycle spans.
    const countedBefore = spans.filter(
      (span) => kindOf(span) === 'TOOL' || isSynthesizedSpan(span.attributes),
    ).length
    const countedAfter = toolSpans.length
    expect(countedBefore - countedAfter).toBe(synthesized.length)
    expect(countedAfter).toBe(3)
    expect(toolSpans.map((span) => span.attributes['tool.name']))
      .toEqual(['exec_command', 'spawn_agent', 'exec_command'])
  })

  it('reports the model-issued count through the evidence, live, and pipeline paths', async () => {
    const ref = subagentRollout()
    const spans = await parse(ref)

    const record = await buildPolicyEvidenceRecord(ref, spans)
    expect(record.metrics.toolCallCount).toBe(3)
    expect(record.metrics.tools.map((tool) => tool.name).sort()).toEqual(['exec_command', 'spawn_agent'])
    expect(record.metrics.tools.find((tool) => tool.name === 'Agent')).toBeUndefined()

    expect(analyzeLiveBatch(spans).toolCallCount).toBe(3)

    const pipelines = await runPipelines(spans)
    expect(pipelines.toolUse.reduce((total, run) => total + run.totalCalls, 0)).toBe(3)
  })
})

describe('Codex inherited context', () => {
  const CHILD_ID = 'child-thread-1'
  const PARENT_ASK = 'Start with the parser, not the reporter.'
  const PARENT_FOLLOW_UP = 'Keep the fixture list short.'

  const forkRollout = () =>
    writeRollout(dir, 'fork-inherited', [
      {
        t: 0,
        type: 'session_meta',
        payload: {
          id: CHILD_ID,
          cwd: '/workspace/demo',
          thread_source: 'subagent',
          source: { subagent: { thread_spawn: { parent_thread_id: 'parent-thread-1', depth: 1, agent_path: '/root/parser_audit' } } },
        },
      },
      { t: 0.5, type: 'turn_context', payload: { cwd: '/workspace/demo', model: 'gpt-fixture' } },
      // The parent's task, copied into the fork's prefix.
      { t: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 'parent-turn-1' } },
      userMessage(2, PARENT_ASK),
      { t: 3, type: 'event_msg', payload: { type: 'user_message', message: PARENT_FOLLOW_UP } },
      compacted(4, 'Summary of the first window.', 1, [PARENT_ASK, PARENT_FOLLOW_UP]),
      // A second compaction repeats the same retained turns.
      compacted(5, 'Summary of the second window.', 2, [PARENT_ASK, 'and keep the budget under an hour.']),
      toolCall(6, 'parent-call-1', 'exec_command', 'rm -rf parent-build'),
      toolOutput(6.5, 'parent-call-1'),
      // The fork boundary: everything below is this session's own scope.
      { t: 10, type: 'event_msg', payload: { type: 'task_started', turn_id: CHILD_ID } },
      userMessage(11, 'Audit the parser and report back.'),
      tokenCount(12, { input_tokens: 100, output_tokens: 10 }, { input_tokens: 100, output_tokens: 10, total_tokens: 110 }),
      toolCall(13, 'child-call-1', 'exec_command', 'rm -rf child-build'),
      toolOutput(13.5, 'child-call-1'),
      { t: 14, type: 'event_msg', payload: { type: 'task_complete', turn_id: CHILD_ID } },
    ])

  it('keeps the pre-fork prefix and compacted history as marked spans', async () => {
    const ref = forkRollout()
    const spans = await new CodexAdapter().parse(ref, { captureSources: true })
    const root = spans[0]!
    expect(root.attributes['traces.codex.task_scope']).toBe('fork-current')

    const inheritedSpans = inherited(spans)
    expect(root.attributes[INHERITED_SPAN_COUNT_ATTR]).toBe(inheritedSpans.length)

    const inheritedPrompts = inheritedSpans.filter((span) => span.name === 'user.prompt')
    // The human's words reach a span, once each, however many records repeat them.
    expect(inheritedPrompts.map((span) => span.attributes.content)).toEqual([
      PARENT_ASK,
      PARENT_FOLLOW_UP,
      'and keep the budget under an hour.',
    ])
    expect(inheritedPrompts.every((span) => span.attributes['tangle.actor'] === 'human')).toBe(true)
    expect(inheritedPrompts.map((span) => span.attributes['traces.session.inherited_source'])).toEqual([
      'pre-task-prefix',
      'pre-task-prefix',
      'compacted',
    ])
    // Every inherited quote cites the record it came from.
    expect(inheritedPrompts.every((span) => typeof span.attributes['traces.source_record.content'] === 'string')).toBe(true)

    const compactions = inheritedSpans.filter((span) => span.name === 'session.compacted')
    expect(compactions.map((span) => span.attributes.content)).toEqual([
      'Summary of the first window.',
      'Summary of the second window.',
    ])
    expect(compactions.map((span) => span.attributes['traces.codex.compaction_window_number'])).toEqual([1, 2])
    expect(compactions[0]!.attributes['traces.codex.compaction_window_id']).toBe('window-1')
  })

  it('leaves this scope own counts and identity untouched', async () => {
    const ref = forkRollout()
    const spans = await parse(ref)

    const ownPrompts = spans.filter(
      (span) => span.name === 'user.prompt' && span.attributes[INHERITED_SPAN_ATTR] !== true,
    )
    expect(ownPrompts.map((span) => span.attributes.content)).toEqual(['Audit the parser and report back.'])
    // A forked child received its brief from its parent agent, not a person.
    expect(ownPrompts[0]!.attributes['tangle.actor']).toBe('agent')

    // The prefix's tool call belongs to the parent's turn and is not parsed.
    const toolSpans = spans.filter((span) => kindOf(span) === 'TOOL')
    expect(toolSpans.map((span) => span.attributes['input.value'])).toEqual([
      JSON.stringify({ cmd: 'rm -rf child-build' }),
    ])

    const record = await buildPolicyEvidenceRecord(ref, spans)
    expect(record.metrics.toolCallCount).toBe(1)
    // The acted-in window starts at the fork, not at the parent's first record.
    expect(record.metrics.firstSpanAt).toBe(at(10))

    // The report subject names what THIS scope was asked to do.
    expect(sessionReportSource(ref, spans).subject).toBe('Audit the parser and report back.')
  })

  it('counts the inherited records its per-session cap dropped', async () => {
    const rows: Row[] = [
      { t: 0, type: 'session_meta', payload: { id: 'cap-session', cwd: '/workspace/demo' } },
      { t: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    ]
    // 260 distinct inherited turns against a cap of 200.
    for (let index = 0; index < 260; index += 1) {
      rows.push(userMessage(2 + index * 0.001, `inherited turn ${index}`))
    }
    rows.push({ t: 3, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } })
    rows.push({ t: 4, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } })
    rows.push(userMessage(5, 'the turn in scope'))
    rows.push({ t: 6, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } })
    const ref = writeRollout(dir, 'inherited-cap', rows)

    const spans = await new CodexAdapter().parse(ref, { taskScope: 'latest' })
    const root = spans[0]!
    expect(root.attributes[INHERITED_SPAN_COUNT_ATTR]).toBe(200)
    // What the cap turned away is reported, not silently dropped.
    expect(root.attributes[INHERITED_SPANS_OMITTED_ATTR]).toBe(60)
    expect(inherited(spans)).toHaveLength(200)
  })

  it('keeps a compacted record inside the parsed scope as inherited context', async () => {
    const ref = writeRollout(dir, 'compaction-in-scope', [
      { t: 0, type: 'session_meta', payload: { id: 'compaction-session', cwd: '/workspace/demo' } },
      { t: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      userMessage(2, 'Ship the parser fix.'),
      compacted(3, 'Summary of the first window.', 1, ['Ship the parser fix.', 'and add a regression test.']),
      toolCall(4, 'call-1', 'exec_command', 'rm -rf build'),
      toolOutput(4.5, 'call-1'),
      { t: 5, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    ])
    const spans = await parse(ref)
    const inheritedSpans = inherited(spans)

    expect(inheritedSpans.map((span) => span.name)).toEqual([
      'session.compacted',
      'user.prompt',
      'user.prompt',
    ])
    expect(inheritedSpans.every((span) => span.attributes['traces.session.inherited_source'] === 'compacted')).toBe(true)
    // The turn this scope actually received keeps its own span.
    const ownPrompts = spans.filter(
      (span) => span.name === 'user.prompt' && span.attributes[INHERITED_SPAN_ATTR] !== true,
    )
    expect(ownPrompts.map((span) => span.attributes.content)).toEqual(['Ship the parser fix.'])
    expect(spans.filter((span) => span.attributes[SYNTHESIZED_SPAN_ATTR] === true)).toHaveLength(0)
  })
})
