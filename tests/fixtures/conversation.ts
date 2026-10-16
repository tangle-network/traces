/**
 * A synthetic HOME holding sessions whose turns were written by different
 * hands, for the tests of `traces facts` turns, signals, `--match`, jsonl and
 * who acted. Every record is written here by hand; none comes from a recorded
 * session.
 *
 * {@link CONVERSATION.claude} is a Claude Code session, in order:
 *
 *   t+00  human     "Fix the build and tell me when it is ready."
 *   t+05  agent     Bash: `cd <cwd> && traces facts c0a7e2a1 --format json && tangle traces list`
 *   t+15  agent     "Done: the build is ready."                       (a completion claim)
 *   t+20  harness   <task-notification>
 *   t+25  fleet     "[fleet-message-id: …] … sentinel-zebra …"
 *   t+30  fleet     "Another Claude session sent you a message: …"
 *   t+35  human     /model opus                                       (a harness command)
 *   t+40  human     "That is not ready, the sentinel-zebra test still fails."
 *   t+45  agent     Bash: `rm -rf build`, which the person rejects
 *   t+51  harness   [Request interrupted by user for tool use]
 *   t+55  human     "Do not delete the build directory."
 *   t+60  agent     "Understood, I left it in place; sentinel-zebra noted."
 *   t+65  relay     a long, markdown-heavy paste of another agent's report
 *   t+70  agent     "Read the relay."
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const CONVERSATION = {
  /** Claude Code: the session above, with a session identity record. */
  claude: 'c0a7e2a1-1111-4111-8111-111111111111',
  /** Claude Code: no identity record; the directives log names its variant. */
  logged: 'c0a7e2a2-2222-4222-8222-222222222222',
  /** Claude Code: no source names who acted. */
  unknown: 'c0a7e2a3-3333-4333-8333-333333333333',
  /** Codex: a fork the person made, then typed into. */
  fork: '0199f7c0-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  /** Codex: the thread {@link CONVERSATION.fork} was forked from. */
  forkParent: '0199a000-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
} as const

/** The record the SessionStart hook writes for {@link CONVERSATION.claude}. */
export const IDENTITY = {
  'agent.harness': 'claude-code',
  'agent.model': 'claude-opus-5-5[1m]',
  'agent.profile.name': 'dotfiles',
  'agent.profile.digest': `sha256:${'5843'.padEnd(60, '0')}ca56`,
  'agent.skills.digest': `sha256:${'d'.repeat(64)}`,
  'agent.directive.variant': 'evidence-lead-v1',
} as const

export const TEXT = {
  ask: 'Fix the build and tell me when it is ready.',
  claim: 'Done: the build is ready.',
  fleet: '[fleet-message-id: f-1] Lane B finished the sentinel-zebra work; merge when green.',
  session: 'Another Claude session sent you a message: please rebase onto main.',
  correction: 'That is not ready, the sentinel-zebra test still fails.',
  stop: 'Do not delete the build directory.',
  understood: 'Understood, I left it in place; sentinel-zebra noted.',
  relayReply: 'Read the relay.',
  refusal:
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, " +
    'the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.',
} as const

/** Another agent's report, pasted: over 1,500 characters, with more than 8 bullets. */
export const RELAY = [
  '## Report from the review lane',
  '',
  ...Array.from({ length: 14 }, (_, index) => `- Finding ${index + 1}: the parser drops a record when two writers append at the same instant, and the retry does not re-read it.`),
  '',
  '## Next',
  '',
  'Merge the fix after the gate passes and re-run the corpus check on both hosts.',
].join('\n')

const at = (second: number): string => new Date(Date.parse('2026-10-14T10:00:00.000Z') + second * 1000).toISOString()
const jsonl = (rows: readonly unknown[]): string => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`

function claudeSession(id: string, cwd: string): string {
  const base = { sessionId: id, cwd, version: '2.1.0', gitBranch: 'main', userType: 'external' }
  let previous: string | null = null
  let n = 0
  const record = (second: number, type: 'user' | 'assistant', message: unknown, extra: Record<string, unknown> = {}) => {
    n += 1
    const uuid = `${id.slice(0, 8)}-r${n}`
    const row = { ...base, ...extra, type, uuid, parentUuid: previous, timestamp: at(second), message }
    previous = uuid
    return row
  }
  const user = (second: number, text: string, extra: Record<string, unknown> = {}) =>
    record(second, 'user', { role: 'user', content: text }, extra)
  const say = (second: number, text: string) =>
    record(second, 'assistant', {
      id: `msg-${id.slice(0, 8)}-${second}`, role: 'assistant', model: 'claude-opus-5-5',
      content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 4 },
    })
  const bash = (second: number, call: string, command: string) =>
    record(second, 'assistant', {
      id: `msg-${id.slice(0, 8)}-${second}`, role: 'assistant', model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id: call, name: 'Bash', input: { command } }], usage: { input_tokens: 10, output_tokens: 4 },
    })
  const result = (second: number, call: string, content: string, isError = false) =>
    record(second, 'user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content, is_error: isError }] })
  return jsonl([
    user(0, TEXT.ask),
    bash(5, 'toolu-1', `cd ${cwd} && traces facts c0a7e2a1 --format json && tangle traces list`),
    result(10, 'toolu-1', 'ok'),
    say(15, TEXT.claim),
    user(20, '<task-notification>\n<task-id>t-1</task-id>\n<status>completed</status>\n</task-notification>'),
    user(25, TEXT.fleet),
    user(30, TEXT.session),
    user(35, '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'),
    user(40, TEXT.correction),
    bash(45, 'toolu-2', 'rm -rf build'),
    result(50, 'toolu-2', TEXT.refusal, true),
    user(51, '[Request interrupted by user for tool use]'),
    user(55, TEXT.stop),
    say(60, TEXT.understood),
    user(65, RELAY),
    say(70, TEXT.relayReply),
  ])
}

/** A short Claude Code session: one ask and one reply. */
function claudeShort(id: string, cwd: string, ask: string): string {
  const base = { sessionId: id, cwd, version: '2.1.0', gitBranch: 'main', userType: 'external' }
  return jsonl([
    { ...base, type: 'user', uuid: `${id}-u1`, parentUuid: null, timestamp: at(100), message: { role: 'user', content: ask } },
    {
      ...base, type: 'assistant', uuid: `${id}-a1`, parentUuid: `${id}-u1`, timestamp: at(105),
      message: { id: `msg-${id}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'On it.' }], usage: { input_tokens: 5, output_tokens: 2 } },
    },
  ])
}

/**
 * A Codex fork the person made: its session_meta names the thread it came from
 * and says the person started it (`thread_source: user`), then the person types
 * into it and the agent replies.
 */
function codexUserFork(cwd: string): string {
  const id = CONVERSATION.fork
  return jsonl([
    {
      timestamp: at(200), type: 'session_meta',
      payload: { id, forked_from_id: CONVERSATION.forkParent, thread_source: 'user', source: 'cli', timestamp: at(200), cwd, originator: 'codex_cli_rs', cli_version: '0.163.0' },
    },
    { timestamp: at(201), type: 'event_msg', payload: { type: 'task_started', turn_id: '0199f7c1-cccc-7ccc-8ccc-cccccccccccc' } },
    {
      timestamp: at(202), type: 'response_item',
      payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Try the other approach in this fork.' }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] },
      },
    },
    { timestamp: at(203), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Trying it.' }] } },
    { timestamp: at(204), type: 'event_msg', payload: { type: 'task_complete', turn_id: '0199f7c1-cccc-7ccc-8ccc-cccccccccccc' } },
  ])
}

export interface ConversationHome {
  readonly root: string
  readonly home: string
  readonly cwd: string
  readonly paths: { readonly claude: string; readonly logged: string; readonly unknown: string; readonly fork: string }
  readonly env: Readonly<Record<string, string>>
}

async function put(path: string, text: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
  return path
}

export async function makeConversationHome(): Promise<ConversationHome> {
  const root = await mkdtemp(join(tmpdir(), 'traces-conversation-home-'))
  const home = join(root, 'home')
  const cwd = join(home, 'w', 'app')
  await mkdir(cwd, { recursive: true })
  const project = join(home, '.claude', 'projects', cwd.replace(/[/.]/gu, '-'))
  const claude = await put(join(project, `${CONVERSATION.claude}.jsonl`), claudeSession(CONVERSATION.claude, cwd))
  const logged = await put(join(project, `${CONVERSATION.logged}.jsonl`), claudeShort(CONVERSATION.logged, cwd, 'Summarize the run.'))
  const unknown = await put(join(project, `${CONVERSATION.unknown}.jsonl`), claudeShort(CONVERSATION.unknown, cwd, 'List the open PRs.'))
  const fork = await put(
    join(home, '.codex', 'sessions', '2026', '10', '14', `rollout-2026-10-14T10-03-20-${CONVERSATION.fork}.jsonl`),
    codexUserFork(cwd),
  )
  await put(
    join(home, '.local', 'state', 'session-identity', 'claude-code', `${CONVERSATION.claude}.json`),
    JSON.stringify({ session_id: CONVERSATION.claude, updated_at: at(1), attributes: IDENTITY }),
  )
  await put(
    join(home, '.claude', 'directives-log.jsonl'),
    jsonl([
      { ts: at(99), session: CONVERSATION.logged, variant: 'evidence-lead-rhythm-v1', cwd },
      { ts: at(150), session: CONVERSATION.logged, variant: 'a-later-variant', cwd },
    ]),
  )
  return {
    root,
    home,
    cwd,
    paths: { claude, logged, unknown, fork },
    env: {
      HOME: home,
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(root, 'cache'),
    },
  }
}
