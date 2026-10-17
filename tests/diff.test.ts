/**
 * U14: `traces diff` says what differs, across worktrees.
 *
 * Claude Code sessions run one task from different worktrees of one repo. Each
 * reads a file under its cwd, stages its worktree's manifest in a temp
 * directory of its own, shows a commit by its hex id, runs one pnpm command and
 * edits a file. Their paths, temp directories and ids all differ; what they did
 * differs only where a test says so.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runCli } from './run-cli.js'

interface Call {
  readonly name: 'Bash' | 'Read' | 'Edit'
  readonly input: Record<string, unknown>
  readonly failed?: true
}

interface Run {
  readonly id: string
  /** The worktree the session ran in; its cwd is the package below it. */
  readonly worktree: string
  readonly tmp: string
  readonly sha: string
  readonly pnpm: string
  /** The file the first call reads, under the cwd. */
  readonly readme?: string
  readonly pnpmFails?: true
  /** A reply between the second and third call: a model step, which diff never compares. */
  readonly extraReply?: true
}

const at = (second: number): string => new Date(Date.UTC(2026, 9, 17, 9, 0, second)).toISOString()

function calls(run: Run, cwd: string): Call[] {
  return [
    { name: 'Read', input: { file_path: `${cwd}/${run.readme ?? 'README.md'}` } },
    { name: 'Bash', input: { command: `mkdir -p ${run.tmp} && cp ${run.worktree}/package.json ${run.tmp}/package.json`, description: 'Stage the manifest' } },
    { name: 'Bash', input: { command: `git show --stat ${run.sha}`, description: 'Show the base commit' } },
    { name: 'Bash', input: { command: run.pnpm }, ...(run.pnpmFails ? { failed: true as const } : {}) },
    { name: 'Edit', input: { file_path: `${cwd}/src/index.ts`, old_string: 'return 1', new_string: 'return 2' } },
  ]
}

/** A Claude Code transcript: the prompt, each call with its result, and a final reply. */
function transcript(run: Run, cwd: string): string {
  const base = { sessionId: run.id, cwd, version: '2.1.0', gitBranch: 'feat/play' }
  const rows: unknown[] = [{ ...base, type: 'user', uuid: `${run.id}-u0`, parentUuid: null, timestamp: at(0), message: { role: 'user', content: 'Make index return 2 and check it.' } }]
  let parent = `${run.id}-u0`
  let second = 1
  const assistant = (content: unknown[]): void => {
    const uuid = `${run.id}-a${second}`
    rows.push({
      ...base,
      type: 'assistant',
      uuid,
      parentUuid: parent,
      timestamp: at(second),
      message: { id: `msg-${uuid}`, role: 'assistant', model: 'claude-opus-5-5', content, usage: { input_tokens: 10, output_tokens: 5 } },
    })
    parent = uuid
    second += 1
  }
  for (const [index, call] of calls(run, cwd).entries()) {
    if (run.extraReply && index === 2) assistant([{ type: 'text', text: 'The manifest is staged; next, the base commit.' }])
    const toolId = `toolu-${run.id}-${index}`
    assistant([{ type: 'tool_use', id: toolId, name: call.name, input: call.input }])
    const uuid = `${run.id}-r${index}`
    rows.push({
      ...base,
      type: 'user',
      uuid,
      parentUuid: parent,
      timestamp: at(second),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: call.failed ? 'exit 1' : 'ok', ...(call.failed ? { is_error: true } : {}) }] },
    })
    parent = uuid
    second += 1
  }
  assistant([{ type: 'text', text: 'Done.' }])
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
}

const RUNS = {
  /** From worktree play-a, temp dir under /tmp. */
  a: { id: 'd1ff0a11-1111-4111-8111-111111111111', worktree: 'play-a', tmp: '/tmp/tmp.Xa81Qz7', sha: '3f9c2e1a7b5d', pnpm: 'pnpm test --filter pkg' },
  /** From worktree play-b, a macOS temp dir and another commit: and `pnpm build` where A ran `pnpm test`. */
  b: { id: 'd1ff0b22-2222-4222-8222-222222222222', worktree: 'play-b', tmp: '/var/folders/q2/xk3l9n0bd5/T/tmp.Pq73Lm', sha: '8d04b6c2e5f1', pnpm: 'pnpm build --filter pkg' },
  /** From worktree play-c, with one more model reply: otherwise A's calls. */
  c: { id: 'd1ff0c33-3333-4333-8333-333333333333', worktree: 'play-c', tmp: '/private/tmp/tmp.Rr19Kd', sha: 'c0ffee12ab34', pnpm: 'pnpm test --filter pkg', extraReply: true },
  /** A's calls from worktree play-d, reading another file under its cwd. */
  d: { id: 'd1ff0d44-4444-4444-8444-444444444444', worktree: 'play-d', tmp: '/tmp/tmp.Dd40Wq', sha: '5e6f7a8b9c0d', pnpm: 'pnpm test --filter pkg', readme: 'CHANGELOG.md' },
  /** A's calls from worktree play-e, where `pnpm test` fails. */
  e: { id: 'd1ff0e55-5555-4555-8555-555555555555', worktree: 'play-e', tmp: '/tmp/tmp.Ee50Vb', sha: '6a7b8c9d0e1f', pnpm: 'pnpm test --filter pkg', pnpmFails: true },
} as const satisfies Record<string, Run>

let env: Record<string, string>
const files: Record<string, string> = {}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'traces-diff-'))
  const home = join(root, 'home')
  for (const [key, run] of Object.entries(RUNS) as [keyof typeof RUNS, Run][]) {
    const worktree = join(home, 'w', '_wt', run.worktree)
    const cwd = join(worktree, 'pkg')
    const placed = { ...run, worktree }
    const path = join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${run.id}.jsonl`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, transcript(placed, cwd), 'utf8')
    files[key] = path
  }
  env = { HOME: home, XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache') }
})

interface Report {
  a: { steps: { name: string; text: string | null; fields: { status: string } }[]; cwds: string[] }
  b: { steps: { name: string; text: string | null; fields: { status: string } }[] }
  diff: { firstDivergence: { index: number; kind: string; differences: { field: string }[] } | null; commonPrefixLen: number }
}

const json = async (a: string, b: string): Promise<Report> => {
  const run = await runCli(['diff', a, b, '--format', 'json'], { env })
  expect(run.stderr).toBe('')
  return JSON.parse(run.stdout) as Report
}

describe('traces diff, across worktrees', () => {
  it('names the one Bash call that differs and prints both commands; cwd, worktree, temp dirs and hex ids do not count', async () => {
    const run = await runCli(['diff', files.a!, files.b!], { env })
    expect(run.code).toBe(1)
    expect(run.stderr).toBe('')
    expect(run.stdout).toContain('first difference at step 4 (argument); steps 1-3 agree:')
    expect(run.stdout).toContain('  A  Bash  pnpm test --filter pkg\n')
    expect(run.stdout).toContain('  B  Bash  pnpm build --filter pkg\n')

    const report = await json(files.a!, files.b!)
    expect(report.diff.firstDivergence).toMatchObject({ index: 3, kind: 'changed', differences: [{ field: 'args' }] })
    // The steps before it agree because each run's places became the same placeholders.
    expect(report.a.steps.map((step) => step.text)).toEqual([
      '<cwd>/README.md',
      'mkdir -p <tmp> && cp <worktree>/package.json <tmp>/package.json',
      'git show --stat <hex>',
      'pnpm test --filter pkg',
      '<cwd>/src/index.ts',
    ])
    expect(report.b.steps.slice(0, 3).map((step) => step.text)).toEqual(report.a.steps.slice(0, 3).map((step) => step.text))
    expect(report.a.cwds).toHaveLength(1)
    expect(report.a.cwds[0]).toMatch(/\/w\/_wt\/play-a\/pkg$/)
  })

  it('exits 0 for the same calls from another worktree, with a model reply more', async () => {
    const run = await runCli(['diff', files.a!, files.c!], { env })
    expect(run.stdout).toContain('no difference: all 5 tool calls agree on tool, status and argument')
    expect(run.code).toBe(0)
  })

  it('exits 0 for a run against itself', async () => {
    const run = await runCli(['diff', files.a!, files.a!], { env })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('no difference')
  })

  it('takes session ids, prefixes and suffixes as refs', async () => {
    const byPath = await json(files.a!, files.b!)
    const byId = await json(RUNS.a.id, RUNS.b.id)
    const byAffix = await json(RUNS.a.id.slice(0, 8), RUNS.b.id.slice(-8))
    for (const report of [byId, byAffix]) {
      expect(report.diff).toEqual(byPath.diff)
      expect(report.a.steps).toEqual(byPath.a.steps)
      expect(report.b.steps).toEqual(byPath.b.steps)
    }
    expect((await runCli(['diff', RUNS.a.id.slice(0, 8), RUNS.a.id.slice(0, 8)], { env })).code).toBe(0)
  })

  it('still counts a different file under the cwd, and a call that failed in one run only', async () => {
    const file = await runCli(['diff', files.a!, files.d!], { env })
    expect(file.code).toBe(1)
    expect(file.stdout).toContain('first difference at step 1 (argument); no step before it:')
    expect(file.stdout).toContain('  A  Read  <cwd>/README.md\n')
    expect(file.stdout).toContain('  B  Read  <cwd>/CHANGELOG.md\n')

    const status = await runCli(['diff', files.a!, files.e!], { env })
    expect(status.code).toBe(1)
    expect(status.stdout).toContain('first difference at step 4 (status); steps 1-3 agree:')
    expect(status.stdout).toContain('  B  Bash [ERROR]  pnpm test --filter pkg\n')
  })

  it('exits 2 with code unreadable when a side cannot be read', async () => {
    const run = await runCli(['diff', files.a!, join(dirname(files.a!), 'missing.jsonl'), '--format', 'json'], { env })
    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
    expect((JSON.parse(run.stderr) as { code: string }).code).toBe('unreadable')
  })
})
