/**
 * A synthetic HOME with harness stores laid out the way the harnesses write
 * them, for tests that spawn the CLI with `HOME` pointed here. No session in
 * it comes from a recorded one.
 *
 * Ids are chosen so selection by id can be checked: one Claude Code session
 * and one Codex session share the 8-character prefix `0199abcd`; every other
 * 8-character prefix and suffix names one session. Codex ids are UUIDv7 whose
 * time is before the files were written, as Codex's are.
 *
 * `home/w/agent-dev-container` is a git repository whose origin is
 * {@link REPO_URL}, and `home/w/agent` is a sibling whose name it starts with.
 * Every file's mtime is set, newest first in {@link MTIME_ORDER}, inside the
 * last hour.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const IDS = {
  /** Claude Code, in `.claude/projects/-w-agent-dev-container`. Unique prefix `c1a0de01`. */
  claude: 'c1a0de01-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  /** Claude Code, sharing its 8-character prefix with `codexTwin`. */
  claudeTwin: '0199abcd-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  /** Codex, in `.codex/sessions`. Unique suffix `dec0de99`. */
  codex: '0199f00d-cccc-7ccc-8ccc-ccccdec0de99',
  /** Codex, sharing its 8-character prefix with `claudeTwin`. */
  codexTwin: '0199abcd-dddd-7ddd-8ddd-dddddddddddd',
  /** Claude Code, only in the store root `archive/host-a/home`, never in HOME. */
  archived: '5704e000-eeee-4eee-8eee-eeeeeeeeeeee',
  /** Codex, in `.codex/archived_sessions`. */
  codexArchived: '0199a1c0-1111-7111-8111-111111111111',
  /** Codex, in the sibling home `.codex-lane/sessions`. */
  codexLane: '0199b2c0-2222-7222-8222-222222222222',
  /** Codex, in the account home `.config/agent-accounts/codex/a/sessions`. */
  codexAccount: '0199c3c0-3333-7333-8333-333333333333',
  /** Codex, in a rollout whose file name does not carry its id. */
  codexUnnamed: '0199d4c0-4444-7444-8444-444444444444',
  /** Codex, recorded in a worktree of the repository that has since been removed. */
  codexReaped: '0199e5c0-5555-7555-8555-555555555555',
  /** Codex, a parent that spawned {@link IDS.child1} then {@link IDS.child2}. */
  parent: '0199f6c0-6666-7666-8666-666666666666',
  child1: '0199f6c1-7777-7777-8777-777777777771',
  child2: '0199f6c2-8888-7888-8888-888888888882',
  /** Codex, a session no reader can read: its two prompts parse to one span identity. */
  unreadable: '0199f9d0-9999-7999-8999-999999999999',
  /** OpenCode, in a WAL-mode SQLite store. */
  opencode: 'ses_f1x7ure0pencode000000001',
} as const

/** The repository `home/w/agent-dev-container` belongs to. */
export const REPO_URL = 'https://github.com/tangle-network/agent-dev-container.git'

/** HOME-store session ids, newest file mtime first. */
export const MTIME_ORDER = [
  IDS.unreadable, IDS.child2, IDS.child1, IDS.parent, IDS.opencode, IDS.codexReaped, IDS.codexUnnamed,
  IDS.codexAccount, IDS.codexLane, IDS.codexArchived, IDS.codexTwin, IDS.codex, IDS.claudeTwin, IDS.claude,
] as const

const DAY = '2026-10-14'
const at = (minute: number, second = 0): string =>
  `${DAY}T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`

const jsonl = (rows: readonly unknown[]): string => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`

/** A Claude Code transcript: a prompt, one Bash call and its result, and a final reply. */
export function claudeTranscript(id: string, cwd: string, minute: number, prompt: string): string {
  const base = { sessionId: id, cwd, version: '2.1.0', gitBranch: 'main' }
  return jsonl([
    { ...base, type: 'user', uuid: `${id}-u1`, parentUuid: null, timestamp: at(minute), message: { role: 'user', content: prompt } },
    {
      ...base,
      type: 'assistant',
      uuid: `${id}-a1`,
      parentUuid: `${id}-u1`,
      timestamp: at(minute, 5),
      message: {
        id: `msg-${id}-1`,
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'tool_use', id: `toolu-${id}`, name: 'Bash', input: { command: 'pnpm build' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      ...base,
      type: 'user',
      uuid: `${id}-u2`,
      parentUuid: `${id}-a1`,
      timestamp: at(minute, 10),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu-${id}`, content: 'built' }] },
    },
    {
      ...base,
      type: 'assistant',
      uuid: `${id}-a2`,
      parentUuid: `${id}-u2`,
      timestamp: at(minute, 15),
      message: {
        id: `msg-${id}-2`,
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'The build passes.' }],
        usage: { input_tokens: 12, output_tokens: 3 },
      },
    },
  ])
}

/** The same session as `claude -p --output-format stream-json --verbose` prints it. */
export function claudeStreamJson(id: string, cwd: string, minute: number): string {
  return jsonl([
    { type: 'system', subtype: 'init', session_id: id, cwd, model: 'claude-opus-5-5', tools: ['Bash', 'Read'], timestamp: at(minute) },
    {
      type: 'assistant',
      session_id: id,
      uuid: `${id}-a1`,
      timestamp: at(minute, 5),
      message: {
        id: `msg-${id}-1`,
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'tool_use', id: `toolu-${id}`, name: 'Bash', input: { command: 'ls' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: 'user',
      session_id: id,
      uuid: `${id}-u2`,
      timestamp: at(minute, 10),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu-${id}`, content: 'files' }] },
    },
    { type: 'result', subtype: 'success', is_error: false, session_id: id, result: 'done', timestamp: at(minute, 15) },
  ])
}

/** A Codex rollout: session metadata, a prompt, one shell call and its output, and a final reply. */
export function codexRollout(id: string, cwd: string, minute: number, prompt: string, meta: Record<string, unknown> = {}): string {
  return jsonl([
    {
      timestamp: at(minute),
      type: 'session_meta',
      payload: { id, timestamp: at(minute), cwd, originator: 'codex_cli_rs', cli_version: '0.150.0', ...meta },
    },
    { timestamp: at(minute, 1), type: 'event_msg', payload: { type: 'task_started', turn_id: `${id}-t1` } },
    {
      timestamp: at(minute, 2),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
    },
    {
      timestamp: at(minute, 3),
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', call_id: `call-${id}`, arguments: JSON.stringify({ command: ['pnpm', 'test'] }) },
    },
    {
      timestamp: at(minute, 8),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: `call-${id}`, output: JSON.stringify({ output: 'ok', metadata: { exit_code: 0 } }) },
    },
    {
      timestamp: at(minute, 9),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests pass.' }] },
    },
    { timestamp: at(minute, 10), type: 'event_msg', payload: { type: 'task_complete', turn_id: `${id}-t1` } },
  ])
}

/**
 * A Codex parent that spawns two children by task path and gets each child's
 * id back, opens a pull request, and reports. Its own records: 3 tool calls.
 */
export function codexParentRollout(cwd: string, minute: number): string {
  const spawn = (call: string, path: string, child: string, second: number) => [
    {
      timestamp: at(minute, second),
      type: 'response_item',
      payload: { type: 'function_call', name: 'spawn_agent', call_id: call, arguments: JSON.stringify({ task_name: path, message: `Do ${path}.` }) },
    },
    {
      timestamp: at(minute, second + 1),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: call, output: JSON.stringify({ agent_id: child, task_name: path }) },
    },
  ]
  return jsonl([
    { timestamp: at(minute), type: 'session_meta', payload: { id: IDS.parent, timestamp: at(minute), cwd, originator: 'codex_cli_rs', cli_version: '0.150.0' } },
    { timestamp: at(minute, 1), type: 'event_msg', payload: { type: 'task_started', turn_id: 'parent-t1' } },
    { timestamp: at(minute, 2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Split the release work.' }] } },
    ...spawn('call-lint', '/root/lint', IDS.child1, 3),
    ...spawn('call-test', '/root/test', IDS.child2, 5),
    {
      timestamp: at(minute, 40),
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', call_id: 'call-pr', arguments: JSON.stringify({ command: ['bash', '-lc', 'gh pr create --title Selection --body Done'] }) },
    },
    {
      timestamp: at(minute, 41),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-pr', output: JSON.stringify({ output: 'https://github.com/tangle-network/traces/pull/7\n', metadata: { exit_code: 0 } }) },
    },
    { timestamp: at(minute, 42), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Both children ran; PR #7 is open.' }] } },
    { timestamp: at(minute, 43), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 80, total_tokens: 980 } } } },
    { timestamp: at(minute, 44), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'parent-t1' } },
  ])
}

/** A child the parent spawned: its session_meta names the parent and the task path. */
function codexChildRollout(id: string, path: string, cwd: string, minute: number): string {
  return codexRollout(id, cwd, minute, `Do ${path}.`, {
    parent_thread_id: IDS.parent,
    agent_path: path,
    source: { subagent: { thread_spawn: { parent_thread_id: IDS.parent, depth: 1, agent_path: path } } },
  })
}

/** Two prompts in Codex's older plain-string form at one instant: they read as one span identity twice. */
function unreadableRollout(cwd: string, minute: number): string {
  return jsonl([
    { timestamp: at(minute), type: 'session_meta', payload: { id: IDS.unreadable, timestamp: at(minute), cwd, originator: 'codex_cli_rs' } },
    { timestamp: at(minute, 1), type: 'response_item', payload: { type: 'message', role: 'user', content: 'Same words.' } },
    { timestamp: at(minute, 1), type: 'response_item', payload: { type: 'message', role: 'user', content: 'Same words.' } },
  ])
}

/** An OpenCode store in WAL mode holding one session: a prompt and a one-step reply. */
async function opencodeStore(path: string, cwd: string, updatedMs: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  const created = Date.parse(at(50))
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);`)
  db.prepare('INSERT INTO session VALUES (?, NULL, ?, ?, ?)').run(IDS.opencode, cwd, created, updatedMs)
  const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
  const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)')
  message.run('msg_1', IDS.opencode, created, JSON.stringify({ role: 'user', time: { created } }))
  part.run('prt_1', 'msg_1', created, JSON.stringify({ type: 'text', text: 'Plan the release.' }))
  message.run('msg_2', IDS.opencode, created + 1000, JSON.stringify({
    role: 'assistant', providerID: 'anthropic', modelID: 'claude-opus-5-5', time: { created: created + 1000, completed: created + 5000 },
  }))
  part.run('prt_2', 'msg_2', created + 1000, JSON.stringify({ type: 'step-start', time: { start: created + 1000 } }))
  part.run('prt_3', 'msg_2', created + 2000, JSON.stringify({ type: 'text', text: 'The plan is ready.' }))
  part.run('prt_4', 'msg_2', created + 5000, JSON.stringify({ type: 'step-finish', reason: 'stop', tokens: { input: 20, output: 6 } }))
  db.close()
}

export interface FixtureHome {
  /** A scratch directory holding the home, the store root and loose files. */
  readonly root: string
  readonly home: string
  /** A trace archive's copy of another host's home: a store root. */
  readonly storeRoot: string
  /** `home/w/agent-dev-container`, a git repository. */
  readonly repo: string
  /** `home/w/agent`, a sibling directory whose name the repository's starts with. */
  readonly sibling: string
  /** The removed worktree {@link IDS.codexReaped} recorded as its cwd. */
  readonly reapedWorktree: string
  readonly paths: {
    readonly claude: string
    readonly codex: string
    readonly parent: string
    readonly unnamed: string
  }
  /** The environment a CLI run sees: HOME and every state directory point inside `root`. */
  readonly env: Readonly<Record<string, string>>
}

async function put(path: string, text: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
  return path
}

const claudeProject = (cwd: string): string => cwd.replace(/[/.]/gu, '-')

export async function makeFixtureHome(): Promise<FixtureHome> {
  const root = await mkdtemp(join(tmpdir(), 'traces-fixture-home-'))
  const home = join(root, 'home')
  const repo = join(home, 'w', 'agent-dev-container')
  const sibling = join(home, 'w', 'agent')
  const reapedWorktree = join(home, 'w', '_wt', 'agent-dev-container-selection')
  await mkdir(repo, { recursive: true })
  await mkdir(sibling, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  git('-c', 'init.defaultBranch=main', 'init', '-q')
  git('remote', 'add', 'origin', REPO_URL)

  const files = new Map<string, string>()
  const write = async (id: string, path: string, text: string): Promise<string> => {
    files.set(id, await put(path, text))
    return path
  }
  const projects = join(home, '.claude', 'projects')
  const claude = await write(IDS.claude, join(projects, claudeProject(repo), `${IDS.claude}.jsonl`), claudeTranscript(IDS.claude, repo, 0, 'Fix the build.'))
  await write(IDS.claudeTwin, join(projects, claudeProject(sibling), `${IDS.claudeTwin}.jsonl`), claudeTranscript(IDS.claudeTwin, sibling, 5, 'Tidy the README.'))
  const day = join('2026', '10', '14')
  const rollouts = join(home, '.codex', 'sessions', day)
  const rollout = (dir: string, minute: number, id: string): string =>
    join(dir, `rollout-${DAY}T10-${String(minute).padStart(2, '0')}-00-${id}.jsonl`)
  const codex = await write(IDS.codex, rollout(rollouts, 10, IDS.codex), codexRollout(IDS.codex, repo, 10, 'Run the tests.'))
  await write(IDS.codexTwin, rollout(rollouts, 15, IDS.codexTwin), codexRollout(IDS.codexTwin, sibling, 15, 'Check the lint.'))
  await write(IDS.codexArchived, rollout(join(home, '.codex', 'archived_sessions', day), 16, IDS.codexArchived), codexRollout(IDS.codexArchived, repo, 16, 'An archived task.'))
  await write(IDS.codexLane, rollout(join(home, '.codex-lane', 'sessions', day), 17, IDS.codexLane), codexRollout(IDS.codexLane, repo, 17, 'A lane task.'))
  await write(IDS.codexAccount, rollout(join(home, '.config', 'agent-accounts', 'codex', 'a', 'sessions', day), 18, IDS.codexAccount), codexRollout(IDS.codexAccount, repo, 18, 'An account task.'))
  const unnamed = await write(IDS.codexUnnamed, join(rollouts, `rollout-${DAY}T10-19-00-renamed.jsonl`), codexRollout(IDS.codexUnnamed, repo, 19, 'A renamed rollout.'))
  await write(IDS.codexReaped, rollout(rollouts, 20, IDS.codexReaped), codexRollout(IDS.codexReaped, reapedWorktree, 20, 'Work in a worktree.', {
    git: { commit_hash: 'a'.repeat(40), branch: 'feat/selection', repository_url: REPO_URL },
  }))
  const opencode = join(home, '.local', 'share', 'opencode', 'opencode.db')
  const parent = await write(IDS.parent, rollout(rollouts, 30, IDS.parent), codexParentRollout(repo, 30))
  await write(IDS.child1, rollout(rollouts, 31, IDS.child1), codexChildRollout(IDS.child1, '/root/lint', repo, 31))
  await write(IDS.child2, rollout(rollouts, 33, IDS.child2), codexChildRollout(IDS.child2, '/root/test', repo, 33))
  await write(IDS.unreadable, rollout(rollouts, 40, IDS.unreadable), unreadableRollout(repo, 40))

  // Newest first in MTIME_ORDER, a minute apart, all inside the last hour.
  const now = Date.now()
  const mtimeOf = (id: string): number => now - 60_000 * (5 + MTIME_ORDER.indexOf(id as (typeof MTIME_ORDER)[number]))
  await opencodeStore(opencode, repo, mtimeOf(IDS.opencode))
  files.set(IDS.opencode, opencode)
  for (const [id, path] of files) {
    const when = new Date(mtimeOf(id))
    await utimes(path, when, when)
  }

  const storeRoot = join(root, 'archive', 'host-a', 'home')
  const remote = '/home/drew/w/discovery-lab'
  await put(
    join(storeRoot, '.claude', 'projects', claudeProject(remote), `${IDS.archived}.jsonl`),
    claudeTranscript(IDS.archived, remote, 20, 'Summarize the run.'),
  )
  return {
    root,
    home,
    storeRoot,
    repo,
    sibling,
    reapedWorktree,
    paths: { claude, codex, parent, unnamed },
    env: {
      HOME: home,
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(root, 'cache'),
    },
  }
}
