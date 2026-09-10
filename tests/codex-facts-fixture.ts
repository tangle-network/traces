/**
 * Synthetic Codex rollouts for the facts an audit question asks about: the
 * commands a code-mode script ran, the files a patch changed, and which user
 * turns a person typed. No rollout here comes from a recorded session.
 *
 * `tests/codex-command-facts.test.ts` asserts against these rollouts. Keeping
 * them in their own module also lets a reader parse the same fixture with an
 * older checkout of the adapter to compare span counts.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionRef } from '../src/types.js'

export const BASE_MS = Date.UTC(2026, 8, 8, 10, 0, 0)
/** The order in which a rollout recorded the two copies of one submitted turn. */
export type RecordOrder = 'item-first' | 'event-first'

export const at = (seconds: number): string => new Date(BASE_MS + seconds * 1000).toISOString()
export const ms = (seconds: number): number => BASE_MS + seconds * 1000

export type Row = { readonly t: number } & Record<string, unknown>

export function writeRollout(dir: string, name: string, rows: readonly Row[]): SessionRef {
  const path = join(dir, `rollout-${name}.jsonl`)
  writeFileSync(path, rows.map(({ t, ...row }) => JSON.stringify({ timestamp: at(t), ...row })).join('\n'))
  return { harness: 'codex', sessionId: name, path, cwd: null, mtimeMs: 0 }
}

export const userItem = (t: number, content: unknown): Row => ({
  t,
  type: 'response_item',
  payload: { type: 'message', role: 'user', content },
})
export const userEvent = (t: number, message: string): Row => ({
  t,
  type: 'event_msg',
  payload: { type: 'user_message', message, images: [], local_images: [] },
})
/** The current rollout shape for a submitted turn: an `item_completed` UserMessage item. */
export const userItemCompleted = (t: number, id: string, text: string): Row => ({
  t,
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    thread_id: 'facts-session',
    turn_id: 'turn-1',
    started_at_ms: ms(t),
    completed_at_ms: ms(t),
    item: { type: 'UserMessage', id, content: [{ type: 'text', text }] },
  },
})
export const task = (t: number, kind: 'task_started' | 'task_complete', turnId: string): Row => ({
  t,
  type: 'event_msg',
  payload: { type: kind, turn_id: turnId },
})
export const tokens = (t: number, input: number): Row => ({
  t,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      last_token_usage: { input_tokens: input, output_tokens: 20 },
      total_token_usage: { input_tokens: input * 2, output_tokens: 40 },
    },
  },
})
export const script = (t: number, callId: string, input: string): Row => ({
  t,
  type: 'response_item',
  payload: { type: 'custom_tool_call', call_id: callId, name: 'exec', input },
})
export const scriptOutput = (t: number, callId: string, output: string): Row => ({
  t,
  type: 'response_item',
  payload: { type: 'custom_tool_call_output', call_id: callId, output },
})
export const command = (
  t: number,
  item: Record<string, unknown>,
  window: { start?: number; end?: number } = {},
): Row => ({
  t,
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    thread_id: 'facts-session',
    turn_id: 'turn-1',
    ...(window.start === undefined ? {} : { started_at_ms: ms(window.start) }),
    ...(window.end === undefined ? {} : { completed_at_ms: ms(window.end) }),
    item: { type: 'CommandExecution', ...item },
  },
})
export const commandItem = (
  id: string,
  processId: string,
  script: string,
  exitCode: number,
  output: string,
): Record<string, unknown> => ({
  id,
  process_id: processId,
  command: ['/bin/zsh', '-lc', script],
  cwd: '/workspace/demo',
  parsed_cmd: [{ type: 'unknown', cmd: script }],
  source: 'agent',
  status: exitCode === 0 ? 'completed' : 'failed',
  stdout: output,
  stderr: '',
  aggregated_output: output,
  exit_code: exitCode,
  duration: { secs: 0, nanos: 800_000_000 },
  formatted_output: output,
})

export const AGENTS_BLOCK = '# AGENTS.md instructions for /workspace/demo\n\n<INSTRUCTIONS>\nUse pnpm.\n</INSTRUCTIONS>'
export const ENVIRONMENT_BLOCK = '<environment_context>\n  <cwd>/workspace/demo</cwd>\n  <shell>zsh</shell>\n</environment_context>'
export const FIRST_REQUEST = 'Open a PR for the parser fix, merge PR 3, then tell me what git status reports.'
export const SCRIPT_INPUT = [
  'const created = await tools.exec_command({ cmd: "gh pr create --fill" })',
  'const merged = await tools.exec_command({ cmd: "gh-drew pr merge 3 --squash" })',
  'const status = await tools.exec_command({ cmd: "git status --short" })',
  'text([created.output, merged.output, status.output].join("\\n"))',
].join('\n')
export const PATCH_INPUT = [
  'await tools.apply_patch(`*** Begin Patch',
  '*** Update File: src/parser.ts',
  '@@',
  '-export const mode = "old"',
  '+export const mode = "new"',
  '*** Add File: tests/parser.test.ts',
  '+test("mode", () => {})',
  '*** End Patch`)',
].join('\n')

/**
 * One operator session: injected context, a substantive request logged twice,
 * a code-mode script around three commands, a command that outlives its call,
 * a patch applied inside `exec`, two item shapes the adapter cannot represent,
 * and a short last typed turn followed by one more injected block.
 */
export function operatorRollout(dir: string, name: string, order: RecordOrder = 'item-first'): SessionRef {
  const request = order === 'item-first'
    ? [userItem(2, [{ type: 'input_text', text: FIRST_REQUEST }]), userEvent(2.001, FIRST_REQUEST)]
    : [userEvent(2, FIRST_REQUEST), userItem(2.001, [{ type: 'input_text', text: FIRST_REQUEST }])]
  const followUp = order === 'item-first'
    ? [userItem(21, [{ type: 'input_text', text: 'ya?' }]), userEvent(21.001, 'ya?')]
    : [userEvent(21, 'ya?'), userItem(21.001, [{ type: 'input_text', text: 'ya?' }])]
  return writeRollout(dir, name, [
    { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
    { t: 0.5, type: 'turn_context', payload: { cwd: '/workspace/demo', model: 'gpt-fixture' } },
    userItem(0.6, [{ type: 'input_text', text: AGENTS_BLOCK }]),
    userItem(0.7, [{ type: 'input_text', text: ENVIRONMENT_BLOCK }]),
    task(1, 'task_started', 'turn-1'),
    ...request,
    tokens(3, 1000),
    script(4, 'call-script', SCRIPT_INPUT),
    command(5, commandItem('item-create', '41001', 'gh pr create --fill', 0, 'https://example.test/demo/pull/7\n'), { start: 4.1, end: 5 }),
    command(6, commandItem('item-merge', '41002', 'gh-drew pr merge 3 --squash', 1, 'X Pull request #3 is not mergeable\n'), { start: 5.1, end: 6 }),
    command(6.5, commandItem('item-status', '41003', 'git status --short', 0, ' M src/parser.ts\n'), { start: 6.1, end: 6.5 }),
    scriptOutput(7, 'call-script', 'Script completed\nWall time 3.0 seconds\nOutput:\nhttps://example.test/demo/pull/7'),
    command(9, commandItem('item-watch', '41004', 'pnpm test --watch=false', 0, 'Tests 12 passed\n'), { start: 6.8, end: 9 }),
    tokens(9.5, 1400),
    script(10, 'call-patch', PATCH_INPUT),
    {
      t: 10.5,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'facts-session',
        turn_id: 'turn-1',
        started_at_ms: ms(10.2),
        completed_at_ms: ms(10.5),
        item: {
          type: 'FileChange',
          id: 'item-patch',
          changes: {
            '/workspace/demo/src/parser.ts': {
              type: 'update',
              unified_diff: '@@ -1 +1 @@\n-export const mode = "old"\n+export const mode = "new"\n',
              move_path: null,
            },
            '/workspace/demo/tests/parser.test.ts': { type: 'add', content: 'test("mode", () => {})\n' },
          },
          status: 'completed',
          stdout: 'Success. Updated the following files:\nM src/parser.ts\nA tests/parser.test.ts\n',
          stderr: '',
        },
      },
    },
    scriptOutput(11, 'call-patch', 'Script completed\nWall time 0.3 seconds\nOutput:\nSuccess.'),
    command(11.5, { id: 'item-broken', status: 'completed', exit_code: 0 }, { start: 11.2, end: 11.5 }),
    { t: 11.6, type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', completed_at_ms: ms(11.6), item: { type: 'FixtureFutureItem', id: 'item-future' } } },
    task(12, 'task_complete', 'turn-1'),
    userItem(19, [{ type: 'input_text', text: ENVIRONMENT_BLOCK.replace('zsh', 'bash') }]),
    task(20, 'task_started', 'turn-2'),
    ...followUp,
    tokens(22, 1500),
    // Injected after the last typed turn: a reader that trusts the user role
    // reports this block as the session's last human turn.
    userItem(22.5, [{ type: 'input_text', text: ENVIRONMENT_BLOCK.replace('zsh', 'fish') }]),
    task(23, 'task_complete', 'turn-2'),
  ])
}
