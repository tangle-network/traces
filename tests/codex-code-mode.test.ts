/**
 * A Codex session whose every command ran inside a code-mode script, the way
 * current Codex records them: an `exec` call whose input is the JavaScript it
 * ran, `tools.exec_command({cmd: …})` naming each command, and a receipt that
 * says whether the script completed, not whether the command did. facts, its
 * search and analyze read the same commands from it; a failing streak among
 * them cannot be read, and facts says so instead of reporting none.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { at, script, scriptOutput, task, userEvent, userItem, type Row } from './codex-facts-fixture.js'
import { runCli } from './run-cli.js'

const ID = '0199c0de-0000-7000-8000-00000000c0de'
const COMPLETED = 'Script completed\nWall time 1.0 seconds\nOutput:\n'

function codeModeRollout(): Row[] {
  const run = (t: number, id: string, input: string, output: string): Row[] => [script(t, id, input), scriptOutput(t + 0.5, id, `${COMPLETED}${output}`)]
  return [
    { t: 0, type: 'session_meta', payload: { id: ID, cwd: '/workspace/demo' } },
    { t: 0.5, type: 'turn_context', payload: { cwd: '/workspace/demo', model: 'gpt-fixture' } },
    task(1, 'task_started', 'turn-1'),
    userItem(2, [{ type: 'input_text', text: 'Fix the parser test.' }]),
    userEvent(2.001, 'Fix the parser test.'),
    ...run(3, 'call-1', 'const r = await tools.exec_command({cmd:"pnpm test","max_output_tokens":4000}); text(r.output)', 'FAIL parse.test.ts'),
    ...run(5, 'call-2', 'const r = await tools.exec_command({cmd:"pnpm test","max_output_tokens":4000}); text(r.output)', 'FAIL parse.test.ts'),
    ...run(7, 'call-3', 'const r = await tools.exec_command({cmd:"pnpm test","max_output_tokens":4000}); text(r.output)', 'FAIL parse.test.ts'),
    ...run(9, 'call-4', "const r = await tools.exec_command({ cmd: 'git reset --hard HEAD' }); text(r.output)", 'HEAD is now at abc1234'),
    ...run(11, 'call-5', 'const n = 12; const r = await tools.exec_command({cmd:`gh pr view ${n} --json state`}); text(r.output)', '{"state":"OPEN"}'),
    ...run(13, 'call-6', 'const r = await tools.exec_command({cmd:"gh pr create --fill"}); text(r.output)', 'https://github.com/o/demo/pull/9'),
    // The script completed, but nothing it printed says the push or the create did.
    ...run(15, 'call-7', 'await tools.exec_command({cmd:"git push -u origin fix/other && gh pr create --fill"})', ''),
    ...run(17, 'call-8', 'const r = await tools.exec_command({cmd:"gh pr merge 9 --squash"}); text(r.output)', '✓ Squashed and merged pull request #9'),
    task(18, 'task_complete', 'turn-1'),
  ]
}

interface Waste {
  failingStreaks: { value: unknown[] | null; partial?: string }
  rollbacks: { value: number | null }
  repeatedCommands: { value: { commands: number; extraRuns: number } | null }
}

let env: Record<string, string>
let rollout: string
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'traces-code-mode-'))
  const sessions = join(dir, 'home', '.codex', 'sessions', '2026', '09', '08')
  await mkdir(sessions, { recursive: true })
  rollout = join(sessions, `rollout-2026-09-08T10-00-00-${ID}.jsonl`)
  await writeFile(rollout, `${codeModeRollout().map(({ t, ...row }) => JSON.stringify({ timestamp: at(t), ...row })).join('\n')}\n`)
  env = { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') }
})

const json = async <T>(argv: readonly string[]): Promise<T> => {
  const run = await runCli(argv, { env })
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as T
}

describe('the commands a Codex code-mode script ran', () => {
  it('count as rework and rollbacks, and a streak among them is named as unreadable, never as none', async () => {
    const facts = await json<{ sessions: Array<{ measurements: { waste: Waste } }> }>(['facts', rollout, '--format', 'json'])
    const waste = facts.sessions[0]!.measurements.waste
    expect(waste.repeatedCommands.value).toEqual({ commands: 1, extraRuns: 2 })
    expect(waste.rollbacks.value).toBe(1)
    expect(waste.failingStreaks.value).toEqual([])
    expect(waste.failingStreaks.partial).toBe(
      "8 of 8 command runs were inside Codex code-mode scripts, which record the script's status, not the command's exit code, " +
        'so no streak among them can be read',
    )
  })

  it('are pull requests only where the output shows it: the script completing says nothing about the command', async () => {
    const facts = await json<{ sessions: Array<{ pullRequests: { value: { created: Array<{ identifier: string }>; merged: Array<{ identifier: string }> } } }> }>(
      ['facts', rollout, '--format', 'json'],
    )
    const { created, merged } = facts.sessions[0]!.pullRequests.value
    expect(created.map((pr) => pr.identifier)).toEqual(['9'])
    expect(merged.map((pr) => pr.identifier)).toEqual(['9'])
  })

  it('are search rows, each one command, from a template literal too', async () => {
    const found = await json<{ matches: Array<{ sessionId: string; kind: string; text: string }> }>(
      ['facts', '--since', '2026-09-01T00:00:00Z', '--match', '^(git reset|gh pr view)', '--format', 'json'],
    )
    expect(found.matches.map(({ sessionId, kind, text }) => ({ sessionId, kind, text }))).toEqual([
      { sessionId: ID, kind: 'command', text: 'git reset --hard HEAD' },
      { sessionId: ID, kind: 'command', text: 'gh pr view ${n} --json state' },
    ])
  })

  it('are read again from an index written by an older build, whose rows lacked them', async () => {
    const indexDir = join(env.XDG_STATE_HOME!, 'traces', 'turn-index')
    await json(['facts', '--since', '2026-09-01T00:00:00Z', '--match', '^pnpm test', '--format', 'json'])
    // What the previous index version held for this session: its cursor, with no command row.
    const index = JSON.parse(await readFile(join(indexDir, 'index.json'), 'utf8')) as { version: number }
    await writeFile(join(indexDir, 'index.json'), JSON.stringify({ ...index, version: 1 }))
    for (const rows of await readdir(join(indexDir, 'rows'))) await writeFile(join(indexDir, 'rows', rows), '')
    const found = await json<{ matches: Array<{ text: string }> }>(['facts', '--since', '2026-09-01T00:00:00Z', '--match', '^pnpm test', '--format', 'json'])
    expect(found.matches.map((match) => match.text)).toEqual(['pnpm test', 'pnpm test', 'pnpm test'])
  })

  it('are the commands analyze reports as rework', async () => {
    const run = await runCli(['analyze', rollout], { env })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('repeated 1 command rerun, 2 extra runs · 1 revert or reset --hard')
  })
})
