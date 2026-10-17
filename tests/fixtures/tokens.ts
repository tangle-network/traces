/**
 * Two synthetic sessions whose token usage exercises every rule of the token
 * owner (`src/execution.ts`), laid out in a HOME the way the harnesses write
 * them. No session in it comes from a recorded one.
 *
 * Claude Code: a response written as two records that repeat its message id
 * and usage (counted once), cache reads and writes on every call, a
 * `<synthetic>` notice that used no tokens, an Agent call that spawns a
 * subagent, and a pull request.
 *
 * Codex: a cumulative counter that repeats once without a new response
 * (counted once), cached tokens inside `input_tokens`, reasoning tokens, and a
 * pull request.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const TOKEN_IDS = {
  claude: '7c1a0de0-aaaa-4aaa-8aaa-aaaaaaaaaa77',
  codex: '0199f7c0-dddd-7ddd-8ddd-dddddddddd77',
} as const

const at = (second: number): string => `2026-10-14T11:00:${String(second).padStart(2, '0')}.000Z`
const jsonl = (rows: readonly unknown[]): string => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`

/** The Claude Code transcript: one human turn, two spawned-or-shell calls, a final reply. */
export function claudeTokensTranscript(id: string, cwd: string): string {
  const base = { sessionId: id, cwd, version: '2.1.0', gitBranch: 'main' }
  const assistant = (uuid: string, second: number, messageId: string, model: string, content: unknown[], usage: Record<string, number>) => ({
    ...base,
    type: 'assistant',
    uuid,
    timestamp: at(second),
    message: { id: messageId, role: 'assistant', model, content, usage },
  })
  const result = (uuid: string, second: number, toolUseId: string, content: string) => ({
    ...base,
    type: 'user',
    uuid,
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  })
  const first = { input_tokens: 3, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 200 }
  return jsonl([
    { ...base, type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'Survey the repo and open the PR.' } },
    // One response, two records: Claude Code repeats the id and the usage so far.
    assistant('a1', 2, 'msg_1', 'claude-opus-5-5', [{ type: 'text', text: 'Surveying first.' }], { ...first, output_tokens: 7 }),
    assistant('a1b', 3, 'msg_1', 'claude-opus-5-5', [
      { type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { subagent_type: 'Explore', description: 'Survey the repo', prompt: 'List the packages.' } },
    ], { ...first, output_tokens: 40 }),
    result('u2', 9, 'toolu_agent', 'Three packages.'),
    assistant('a2', 11, 'msg_2', 'claude-opus-5-5', [
      { type: 'tool_use', id: 'toolu_pr', name: 'Bash', input: { command: 'gh pr create --title Survey --body Done' } },
    ], { input_tokens: 5, cache_read_input_tokens: 1_300, cache_creation_input_tokens: 50, output_tokens: 20 }),
    result('u3', 15, 'toolu_pr', 'https://github.com/acme/widgets/pull/12'),
    assistant('a3', 16, 'msg_3', '<synthetic>', [{ type: 'text', text: 'No response requested.' }], { input_tokens: 0, output_tokens: 0 }),
    assistant('a4', 18, 'msg_4', 'claude-opus-5-5', [{ type: 'text', text: 'Opened PR #12.' }], {
      input_tokens: 2, cache_read_input_tokens: 1_400, cache_creation_input_tokens: 0, output_tokens: 15,
    }),
  ])
}

/** The Codex rollout: one human turn, one shell call that opens a PR, two responses. */
export function codexTokensRollout(id: string, cwd: string): string {
  const tokenCount = (second: number, last: Record<string, number> | null, total: Record<string, number>) => ({
    timestamp: at(second),
    type: 'event_msg',
    payload: { type: 'token_count', info: { ...(last ? { last_token_usage: last } : {}), total_token_usage: total } },
  })
  const firstCall = { input_tokens: 1_200, cached_input_tokens: 1_000, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 1_230 }
  const total = { input_tokens: 2_700, cached_input_tokens: 2_100, output_tokens: 70, reasoning_output_tokens: 22, total_tokens: 2_770 }
  return jsonl([
    { timestamp: at(0), type: 'session_meta', payload: { id, timestamp: at(0), cwd, originator: 'codex_cli_rs', cli_version: '0.150.0' } },
    { timestamp: at(1), type: 'event_msg', payload: { type: 'task_started', turn_id: `${id}-t1` } },
    { timestamp: at(1), type: 'turn_context', payload: { cwd, model: 'gpt-6.1-sol' } },
    { timestamp: at(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Open the release PR.' }] } },
    {
      timestamp: at(3),
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', call_id: 'call-pr', arguments: JSON.stringify({ command: ['bash', '-lc', 'gh pr create --title Release --body Done'] }) },
    },
    tokenCount(4, firstCall, firstCall),
    {
      timestamp: at(6),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-pr', output: JSON.stringify({ output: 'https://github.com/acme/widgets/pull/13\n', metadata: { exit_code: 0 } }) },
    },
    { timestamp: at(8), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Opened PR #13.' }] } },
    tokenCount(9, { input_tokens: 1_500, cached_input_tokens: 1_100, output_tokens: 40, reasoning_output_tokens: 12, total_tokens: 1_540 }, total),
    // A rate-limit refresh repeats the counter without a new response.
    tokenCount(10, null, total),
    { timestamp: at(11), type: 'event_msg', payload: { type: 'task_complete', turn_id: `${id}-t1` } },
  ])
}

export interface TokenHome {
  readonly home: string
  readonly claude: string
  readonly codex: string
  readonly env: Readonly<Record<string, string>>
}

async function put(path: string, text: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
  return path
}

/** A HOME holding both sessions where Claude Code and Codex write them. */
export async function makeTokenHome(): Promise<TokenHome> {
  const root = await mkdtemp(join(tmpdir(), 'traces-token-home-'))
  const home = join(root, 'home')
  const cwd = join(home, 'w', 'widgets')
  await mkdir(cwd, { recursive: true })
  const claude = await put(
    join(home, '.claude', 'projects', cwd.replace(/[/.]/gu, '-'), `${TOKEN_IDS.claude}.jsonl`),
    claudeTokensTranscript(TOKEN_IDS.claude, cwd),
  )
  const codex = await put(
    join(home, '.codex', 'sessions', '2026', '10', '14', `rollout-2026-10-14T11-00-00-${TOKEN_IDS.codex}.jsonl`),
    codexTokensRollout(TOKEN_IDS.codex, cwd),
  )
  return {
    home,
    claude,
    codex,
    env: {
      HOME: home,
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(root, 'cache'),
    },
  }
}
