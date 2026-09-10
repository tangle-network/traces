/**
 * A synthetic Codex rollout whose facts are known by hand.
 *
 * Every record here is invented for this test. The shape follows the rollout
 * format the Codex adapter parses — `session_meta`, `turn_context`,
 * `response_item` calls and outputs, `event_msg` token counts and subagent
 * activity — so the facts sheet is exercised through the real adapter rather
 * than against spans a test built directly.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAdapter } from '../src/adapters/codex.js'
import type { OtlpSpan } from '../src/otlp.js'

export const FIXTURE_SESSION_ID = 'facts-fixture-session'
export const FIXTURE_AGENT_PATH = '/root/uploader_audit'
export const FIXTURE_THREAD_ID = 'facts-fixture-child'

/** What the fixture's human typed, verbatim, in order. */
export const FIXTURE_HUMAN_TURNS = [
  'add a retry to the uploader and keep the tests green',
  'also make the backoff configurable',
] as const

export const FIXTURE_FINAL_ASSISTANT = 'Backoff is configurable now and the suite is green.'
export const FIXTURE_FINAL_SUBAGENT_TEXT =
  'Message Type: FINAL_ANSWER\nThe uploader retries three times and never swallows a 4xx.'

/** Paths the fixture's patches touch, and how. */
export const FIXTURE_CHANGED_FILES = [
  { path: '/fixture/src/retry.ts', operations: ['add'] },
  { path: '/fixture/src/upload.ts', operations: ['update'] },
] as const

function at(second: number): string {
  return new Date(Date.UTC(2026, 8, 9, 12, 0, second)).toISOString()
}

export const FIXTURE_FIRST_RECORD_AT = at(0)

/**
 * Records of the fixture session.
 *
 * `extraTools` appends N further `exec_command` calls with padded arguments, to
 * build a session whose serialized spans exceed the trace tools' byte ceiling
 * while the hand-written facts stay exactly derivable.
 */
export function fixtureRecords(extraTools = 0): unknown[] {
  const records: unknown[] = [
    { type: 'session_meta', timestamp: at(0), payload: { id: FIXTURE_SESSION_ID, cwd: '/fixture' } },
    { type: 'turn_context', timestamp: at(1), payload: { model: 'gpt-5.4-codex' } },
    {
      type: 'response_item',
      timestamp: at(2),
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: FIXTURE_HUMAN_TURNS[0] }] },
    },
    {
      type: 'event_msg',
      timestamp: at(3),
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 900, output_tokens: 80 }, total_token_usage: { input_tokens: 900, output_tokens: 80, total_tokens: 980 } },
      },
    },
    // A plain shell call.
    {
      type: 'response_item',
      timestamp: at(4),
      payload: { type: 'function_call', call_id: 'call-shell', name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls src' }) },
    },
    { type: 'response_item', timestamp: at(5), payload: { type: 'function_call_output', call_id: 'call-shell', output: JSON.stringify({ exit_code: 0, output: 'upload.ts' }) } },
    // A verification call: the adapter names it `exec_command.verify`, which is
    // the category the measured analyst kept subtracting by hand.
    {
      type: 'response_item',
      timestamp: at(6),
      payload: { type: 'function_call', call_id: 'call-verify', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pnpm test' }) },
    },
    { type: 'response_item', timestamp: at(7), payload: { type: 'function_call_output', call_id: 'call-verify', output: JSON.stringify({ exit_code: 0 }) } },
    // A patch naming one updated and one added file.
    {
      type: 'response_item',
      timestamp: at(8),
      payload: {
        type: 'function_call',
        call_id: 'call-patch',
        name: 'apply_patch',
        arguments: JSON.stringify({
          input: [
            '*** Begin Patch',
            '*** Update File: /fixture/src/upload.ts',
            '@@',
            '-  await send(body)',
            '+  await withRetry(() => send(body))',
            '*** Add File: /fixture/src/retry.ts',
            '+export const withRetry = async () => {}',
            '*** End Patch',
          ].join('\n'),
        }),
      },
    },
    { type: 'response_item', timestamp: at(9), payload: { type: 'function_call_output', call_id: 'call-patch', output: JSON.stringify({ exit_code: 0 }) } },
    // A subagent spawn, with the task name the adapter promotes to an attribute.
    {
      type: 'response_item',
      timestamp: at(10),
      payload: {
        type: 'function_call',
        call_id: 'call-spawn',
        name: 'spawn_agent',
        arguments: JSON.stringify({ task_name: FIXTURE_AGENT_PATH, message: 'audit the uploader' }),
      },
    },
    { type: 'response_item', timestamp: at(11), payload: { type: 'function_call_output', call_id: 'call-spawn', output: JSON.stringify({ task_name: FIXTURE_AGENT_PATH }) } },
    // The lifecycle events that make the adapter synthesize a `tool.Agent` span.
    {
      type: 'event_msg',
      timestamp: at(12),
      payload: {
        type: 'sub_agent_activity',
        event_id: 'call-spawn',
        kind: 'started',
        agent_thread_id: FIXTURE_THREAD_ID,
        agent_path: FIXTURE_AGENT_PATH,
        occurred_at_ms: Date.parse(at(12)),
      },
    },
    {
      type: 'response_item',
      timestamp: at(13),
      payload: { type: 'agent_message', author: FIXTURE_AGENT_PATH, recipient: 'root', content: FIXTURE_FINAL_SUBAGENT_TEXT },
    },
    {
      type: 'event_msg',
      timestamp: at(14),
      payload: {
        type: 'sub_agent_activity',
        event_id: 'call-spawn',
        kind: 'completed',
        agent_thread_id: FIXTURE_THREAD_ID,
        agent_path: FIXTURE_AGENT_PATH,
        occurred_at_ms: Date.parse(at(14)),
      },
    },
    {
      type: 'response_item',
      timestamp: at(15),
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Retry added; running the suite.' }] },
    },
    {
      type: 'response_item',
      timestamp: at(16),
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: FIXTURE_HUMAN_TURNS[1] }] },
    },
  ]
  for (let index = 0; index < extraTools; index += 1) {
    const callId = `call-bulk-${index}`
    records.push({
      type: 'response_item',
      timestamp: at(17),
      payload: {
        type: 'function_call',
        call_id: callId,
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: `rg --files-with-matches token ${'padding/'.repeat(40)}${index}` }),
      },
    })
    records.push({
      type: 'response_item',
      timestamp: at(17),
      payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ exit_code: 0, output: 'x'.repeat(400) }) },
    })
  }
  records.push({
    type: 'response_item',
    timestamp: at(18),
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: FIXTURE_FINAL_ASSISTANT }] },
  })
  return records
}

export const FIXTURE_LAST_RECORD_AT = at(18)

/** Parse the fixture through the real Codex adapter. */
export async function fixtureSpans(extraTools = 0): Promise<OtlpSpan[]> {
  const dir = await mkdtemp(join(tmpdir(), 'traces-facts-fixture-'))
  const path = join(dir, `${FIXTURE_SESSION_ID}.jsonl`)
  await writeFile(path, `${fixtureRecords(extraTools).map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  return new CodexAdapter().parse({
    harness: 'codex',
    sessionId: FIXTURE_SESSION_ID,
    path,
    cwd: '/fixture',
    mtimeMs: 0,
  })
}
