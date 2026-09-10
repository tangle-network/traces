/**
 * Codex rollout facts that audit questions ask about: the commands a code-mode
 * script ran, the files a patch changed, and which user turns a person typed.
 * Every rollout comes from `tests/codex-facts-fixture.ts` and is synthetic.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/adapters/codex.js'
import { buildPolicyEvidenceRecord } from '../src/evidence.js'
import type { OtlpSpan } from '../src/otlp.js'
import { runPipelines } from '../src/pipelines.js'
import { describeSessionRelationship } from '../src/session-relationship.js'
import {
  at,
  command,
  commandItem,
  ENVIRONMENT_BLOCK,
  FIRST_REQUEST,
  operatorRollout,
  type RecordOrder,
  type Row,
  script,
  scriptOutput,
  task,
  userEvent,
  userItem,
  userItemCompleted,
  writeRollout as writeRolloutIn,
} from './codex-facts-fixture.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-codex-facts-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const rollout = (name: string, order?: RecordOrder) => operatorRollout(dir, name, order)
const writeRollout = (name: string, rows: readonly Row[]) => writeRolloutIn(dir, name, rows)

const kindOf = (item: OtlpSpan) => item.attributes['openinference.span.kind']
const byName = (spans: readonly OtlpSpan[], name: string) => spans.filter((item) => item.name === name)
const inner = (spans: readonly OtlpSpan[]) => spans.filter((item) => item.attributes['traces.tool_call.level'] === 'inner')
const humanTurns = (spans: readonly OtlpSpan[]) =>
  byName(spans, 'user.prompt').filter((item) => item.attributes['tangle.actor'] === 'human')

/**
 * The same fixture parsed by the adapter this branch changes, at origin/main
 * (7633ebc): no inner spans, and the two `<environment_context>` blocks plus the
 * AGENTS.md block counted as human turns. Measured by running
 * `tests/codex-facts-fixture.ts` against that checkout.
 */
const BASELINE = { total: 12, outerTools: 2, inner: 0, userPrompts: 6, humanTurns: 5 } as const

function spanCounts(spans: readonly OtlpSpan[]) {
  return {
    total: spans.length,
    outerTools: spans.filter((item) => kindOf(item) === 'TOOL').length,
    inner: inner(spans).length,
    userPrompts: byName(spans, 'user.prompt').length,
    humanTurns: humanTurns(spans).length,
  }
}

describe('Codex command and file-change spans', () => {
  it('emits each command inside a script with its own times, exit code, and process', async () => {
    const spans = await new CodexAdapter().parse(rollout('commands'))
    const scriptSpan = spans.find((item) => item.attributes['traces.codex.source_span_id'] === 'tool:call-script')!
    const commands = byName(spans, 'command.execution')

    const joined = commands.filter((item) => item.parent_span_id === scriptSpan.span_id)
    expect(joined.map((item) => ({
      input: JSON.parse(String(item.attributes['input.value'])).command.at(-1),
      start: item.start_time,
      end: item.end_time,
      exit: item.attributes['process.exit_code'],
      pid: item.attributes['traces.codex.process_id'],
      status: item.status.code,
      join: item.attributes['traces.codex.item_join'],
    }))).toEqual([
      { input: 'gh pr create --fill', start: at(4.1), end: at(5), exit: 0, pid: '41001', status: 'OK', join: 'call' },
      { input: 'gh-drew pr merge 3 --squash', start: at(5.1), end: at(6), exit: 1, pid: '41002', status: 'ERROR', join: 'call' },
      { input: 'git status --short', start: at(6.1), end: at(6.5), exit: 0, pid: '41003', status: 'OK', join: 'call' },
    ])
    expect(joined[1]!.attributes['output.value']).toBe('X Pull request #3 is not mergeable\n')
    expect(joined[1]!.status.message).toBe('command exited 1')
    for (const item of commands) {
      expect(kindOf(item)).toBe('CHAIN')
      expect(item.attributes['span.type']).toBe('tool.execution')
      expect(item.attributes['tool.name']).toBeUndefined()
      expect(item.trace_id).toBe(scriptSpan.trace_id)
    }
  })

  it('keeps a command that outlives its call under the session root', async () => {
    const spans = await new CodexAdapter().parse(rollout('unmatched'))
    const root = spans.find((item) => item.parent_span_id === null)!
    const watch = byName(spans, 'command.execution')
      .find((item) => String(item.attributes['input.value']).includes('pnpm test --watch=false'))!
    expect(watch.parent_span_id).toBe(root.span_id)
    expect(watch.attributes['traces.codex.item_join']).toBe('unmatched')
    expect([watch.start_time, watch.end_time]).toEqual([at(6.8), at(9)])
  })

  it('leaves a command inside two overlapping calls under the session root', async () => {
    const spans = await new CodexAdapter().parse(writeRollout('ambiguous', [
      { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
      task(1, 'task_started', 'turn-1'),
      script(2, 'call-a', 'await tools.exec_command({ cmd: "pnpm test" })'),
      script(3, 'call-b', 'await tools.exec_command({ cmd: "pnpm build" })'),
      command(4, commandItem('item-shared', '42001', 'pnpm test', 0, 'ok\n'), { start: 3.5, end: 4 }),
      scriptOutput(5, 'call-a', 'Script completed\nWall time 1.0 seconds\nOutput:\nok'),
      scriptOutput(6, 'call-b', 'Script completed\nWall time 1.0 seconds\nOutput:\nok'),
      task(7, 'task_complete', 'turn-1'),
    ]))
    const root = spans.find((item) => item.parent_span_id === null)!
    const shared = byName(spans, 'command.execution')
    expect(shared).toHaveLength(1)
    expect(shared[0]!.attributes['traces.codex.item_join']).toBe('ambiguous')
    expect(shared[0]!.parent_span_id).toBe(root.span_id)
  })

  it('emits the paths an apply_patch inside exec changed', async () => {
    const spans = await new CodexAdapter().parse(rollout('patch'))
    const patchCall = spans.find((item) => item.attributes['traces.codex.source_span_id'] === 'tool:call-patch')!
    const files = byName(spans, 'file.change')
    expect(files.map((item) => ({
      input: JSON.parse(String(item.attributes['input.value'])),
      kind: item.attributes['traces.codex.file_change_kind'],
      parent: item.parent_span_id,
      status: item.status.code,
    }))).toEqual([
      { input: { kind: 'update', path: '/workspace/demo/src/parser.ts' }, kind: 'update', parent: patchCall.span_id, status: 'OK' },
      { input: { kind: 'add', path: '/workspace/demo/tests/parser.test.ts' }, kind: 'add', parent: patchCall.span_id, status: 'OK' },
    ])
    expect(files.every((item) => item.start_time === at(10.2) && item.end_time === at(10.5))).toBe(true)
  })

  it('separates an item type it models no span for from an item it dropped', async () => {
    const spans = await new CodexAdapter().parse(rollout('skipped'))
    const root = spans.find((item) => item.parent_span_id === null)!
    expect(JSON.parse(String(root.attributes['traces.codex.unmodeled_item_counts']))).toEqual({ FixtureFutureItem: 1 })
    expect(JSON.parse(String(root.attributes['traces.codex.dropped_item_counts']))).toEqual({
      'CommandExecution:malformed': 1,
    })
    expect(spans.some((item) => item.attributes['traces.codex.item_id'] === 'item-broken')).toBe(false)
  })

  it('marks a script whose receipt omits the Wall time colon as successful', async () => {
    const spans = await new CodexAdapter().parse(rollout('receipt'))
    const scriptSpan = spans.find((item) => item.attributes['traces.codex.source_span_id'] === 'tool:call-script')!
    expect(scriptSpan.status.code).toBe('OK')
  })

  it('adds only inner spans: outer tool counts, evidence tool counts, and loop input stay unchanged', async () => {
    const spans = await new CodexAdapter().parse(rollout('counts'))
    expect(spanCounts(spans)).toEqual({ ...BASELINE, total: BASELINE.total + 6, inner: 6, humanTurns: 2 })

    const ref = rollout('counts-evidence')
    const outerOnly = spans.filter((item) => item.attributes['traces.tool_call.level'] !== 'inner')
    const evidence = await buildPolicyEvidenceRecord(ref, spans, { generatedAt: at(0) })
    const outerEvidence = await buildPolicyEvidenceRecord(ref, outerOnly, { generatedAt: at(0) })
    expect(evidence.metrics).toMatchObject({ spanCount: BASELINE.total + 6, toolCallCount: 2, erroredToolCallCount: 0 })
    expect(evidence.metrics.tools).toEqual([
      { name: 'apply_patch', calls: 1, errors: 0 },
      { name: 'exec_command.verify', calls: 1, errors: 0 },
    ])
    const { spanCount: _all, ...toolMetrics } = evidence.metrics
    const { spanCount: _outer, ...outerToolMetrics } = outerEvidence.metrics
    expect(toolMetrics).toEqual(outerToolMetrics)
    expect(evidence.signals).toEqual(outerEvidence.signals)
    // agent-eval counts a failed inner command as one more execution error.
    expect(evidence.execution.execution.executionErrors.events)
      .toBe(outerEvidence.execution.execution.executionErrors.events + 1)
    const [pipelines, outerPipelines] = await Promise.all([runPipelines(spans), runPipelines(outerOnly)])
    expect(pipelines.toolUse).toEqual(outerPipelines.toolUse)
    expect(pipelines.stuckLoops.findings).toEqual(outerPipelines.stuckLoops.findings)
    expect(pipelines.toolUse[0]).toMatchObject({ totalCalls: 2 })
  })
})

describe('Codex human turns', () => {
  it.each(['item-first', 'event-first'] as const)(
    'records each human turn once with its text and timestamp (%s)',
    async (order) => {
      const spans = await new CodexAdapter().parse(rollout(`turns-${order}`, order))
      const turns = humanTurns(spans)
      expect(turns.map((item) => [item.attributes.content, item.start_time])).toEqual([
        [FIRST_REQUEST, at(2)],
        ['ya?', at(21)],
      ])
      expect(turns.every((item) => item.attributes['traces.codex.user_message_event'] === true)).toBe(true)
      expect(byName(spans, 'user.prompt').filter((item) => item.attributes.content === FIRST_REQUEST)).toHaveLength(1)
    },
  )

  it('labels injected context blocks as non-human', async () => {
    const spans = await new CodexAdapter().parse(rollout('injected'))
    const injected = byName(spans, 'user.prompt')
      .filter((item) => String(item.attributes.content).startsWith('<environment_context>'))
    expect(injected).toHaveLength(3)
    expect(injected.every((item) => item.attributes['tangle.actor'] === 'injected')).toBe(true)
    expect(humanTurns(spans).at(-1)?.attributes.content).toBe('ya?')
  })

  it('treats a user-role message with no user_message event as injected once the event stream exists', async () => {
    const spans = await new CodexAdapter().parse(writeRollout('unknown-wrapper', [
      { t: 0, type: 'session_meta', payload: { id: 'wrapper-session', cwd: '/workspace/demo' } },
      task(1, 'task_started', 'turn-1'),
      userItem(2, 'Please add a changelog entry.'),
      userEvent(2.001, 'Please add a changelog entry.'),
      userItem(3, '<fixture_wrapper>harness text</fixture_wrapper>'),
      task(4, 'task_complete', 'turn-1'),
    ]))
    expect(byName(spans, 'user.prompt').map((item) => [item.attributes.content, item.attributes['tangle.actor']])).toEqual([
      ['Please add a changelog entry.', 'human'],
      ['<fixture_wrapper>harness text</fixture_wrapper>', 'injected'],
    ])
  })

  it('records a turn reported as an item_completed UserMessage once', async () => {
    const spans = await new CodexAdapter().parse(writeRollout('item-completed-turns', [
      { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
      userItem(0.5, [{ type: 'input_text', text: ENVIRONMENT_BLOCK }]),
      task(1, 'task_started', 'turn-1'),
      userItem(2, [{ type: 'input_text', text: 'Rerun the parser tests.' }]),
      userItemCompleted(2.001, 'item-turn-1', 'Rerun the parser tests.'),
      task(3, 'task_complete', 'turn-1'),
    ]))
    expect(byName(spans, 'user.prompt').map((item) => [item.attributes.content, item.attributes['tangle.actor']])).toEqual([
      [ENVIRONMENT_BLOCK, 'injected'],
      ['Rerun the parser tests.', 'human'],
    ])
    expect(humanTurns(spans)[0]!.start_time).toBe(at(2))
    expect(humanTurns(spans)[0]!.attributes['traces.codex.user_message_event']).toBe(true)
    const root = spans.find((item) => item.parent_span_id === null)!
    expect(root.attributes['traces.codex.dropped_item_counts']).toBeUndefined()
  })

  it('pairs the two records of a turn whose message record carries a context prefix', async () => {
    const typed = 'Fix the parser and rerun the tests.'
    const prefixed = `${ENVIRONMENT_BLOCK}\n\n## My request for Codex:\n\n${typed}`
    const spans = await new CodexAdapter().parse(writeRollout('prefixed-turn', [
      { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
      task(1, 'task_started', 'turn-1'),
      userItem(2, [{ type: 'input_text', text: prefixed }]),
      userEvent(2.001, typed),
      task(3, 'task_complete', 'turn-1'),
    ]))
    expect(byName(spans, 'user.prompt')).toHaveLength(1)
    expect(humanTurns(spans).map((item) => [item.attributes.content, item.start_time])).toEqual([[prefixed, at(2)]])
    // Without the pairing, this span exists but carries no record of its own.
    expect(humanTurns(spans)[0]!.attributes['traces.codex.user_message_event']).toBe(true)
  })

  it('keeps text heuristics for rollouts that never recorded user_message events', async () => {
    const spans = await new CodexAdapter().parse(writeRollout('legacy-turns', [
      { t: 0, type: 'session_meta', payload: { id: 'legacy-session', cwd: '/workspace/demo' } },
      task(1, 'task_started', 'turn-1'),
      userItem(2, 'Please add a changelog entry.'),
      task(3, 'task_complete', 'turn-1'),
    ]))
    expect(humanTurns(spans).map((item) => item.attributes.content)).toEqual(['Please add a changelog entry.'])
  })
})

describe('Codex child relationships', () => {
  it('does not list the parent among the children a forked child messages', async () => {
    const parentId = '019f0000-0000-7000-8000-00000000aaaa'
    const childId = '019f0000-0000-7000-8000-00000000bbbb'
    const siblingId = '019f0000-0000-7000-8000-00000000cccc'
    const ref = writeRollout('forked-child', [
      {
        t: 0,
        type: 'session_meta',
        payload: {
          id: childId,
          parent_thread_id: parentId,
          thread_source: 'subagent',
          cwd: '/workspace/demo',
          source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: '/root/worker' } } },
        },
      },
      task(1, 'task_started', 'child-turn'),
      userItem(2, 'Check the parser and report back.'),
      {
        t: 3,
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'call-report', name: 'send_message', arguments: JSON.stringify({ target: parentId, message: 'done' }) },
      },
      { t: 4, type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-report', output: '{"ok":true}' } },
      {
        t: 5,
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'call-sibling', name: 'send_message', arguments: JSON.stringify({ target: siblingId, message: 'fyi' }) },
      },
      { t: 6, type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-sibling', output: '{"ok":true}' } },
      task(7, 'task_complete', 'child-turn'),
    ])
    const relationship = describeSessionRelationship({ ...ref, sessionId: childId }, await new CodexAdapter().parse(ref))
    expect(relationship.parentSessionId).toBe(parentId)
    expect(relationship.childSessionIds).toEqual([siblingId])
    expect(relationship.resumedChildSessionIds).toEqual([siblingId])
  })
})
