/**
 * A synthetic HOME with harness stores laid out the way the harnesses write
 * them, for tests that spawn the CLI with `HOME` pointed here. No session in
 * it comes from a recorded one.
 *
 * Ids are chosen so selection by id can be checked: one Claude Code session
 * and one Codex session share the 8-character prefix `0199abcd`; every other
 * 8-character prefix and suffix names one session.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
} as const

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
export function codexRollout(id: string, cwd: string, minute: number, prompt: string): string {
  return jsonl([
    {
      timestamp: at(minute),
      type: 'session_meta',
      payload: { id, timestamp: at(minute), cwd, originator: 'codex_cli_rs', cli_version: '0.150.0' },
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

export interface FixtureHome {
  /** A scratch directory holding the home, the store root and loose files. */
  readonly root: string
  readonly home: string
  /** A trace archive's copy of another host's home: a store root. */
  readonly storeRoot: string
  readonly paths: {
    readonly claude: string
    readonly codex: string
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
  const projects = join(home, '.claude', 'projects')
  const claude = await put(join(projects, claudeProject(repo), `${IDS.claude}.jsonl`), claudeTranscript(IDS.claude, repo, 0, 'Fix the build.'))
  await put(join(projects, claudeProject(sibling), `${IDS.claudeTwin}.jsonl`), claudeTranscript(IDS.claudeTwin, sibling, 5, 'Tidy the README.'))
  const rollouts = join(home, '.codex', 'sessions', '2026', '10', '14')
  const codex = await put(join(rollouts, `rollout-${DAY}T10-10-00-${IDS.codex}.jsonl`), codexRollout(IDS.codex, repo, 10, 'Run the tests.'))
  await put(join(rollouts, `rollout-${DAY}T10-15-00-${IDS.codexTwin}.jsonl`), codexRollout(IDS.codexTwin, sibling, 15, 'Check the lint.'))
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
    paths: { claude, codex },
    env: {
      HOME: home,
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(root, 'cache'),
    },
  }
}
