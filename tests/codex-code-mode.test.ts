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

/**
 * Pull requests a code-mode script created, the way current Codex records the
 * results it printed: each `text(await tools.exec_command(…))` is one JSON
 * object, `exit_code` once the command ended or `session_id` while it still
 * runs, with the command's output as an escaped string. A create that is still
 * running prints its URL only to a later script's `write_stdin` poll of that
 * session. Both URLs reach the spans; neither is on a line of its own.
 */
const PR_ID = '0199c0de-0000-7000-8000-0000000000a2'
const result = (fields: Record<string, unknown>): string => JSON.stringify({ chunk_id: 'c0ffee', wall_time_seconds: 1.0, ...fields, original_token_count: 9 })

function codeModePullRequests(): Row[] {
  const run = (t: number, id: string, input: string, output: string): Row[] => [script(t, id, input), scriptOutput(t + 0.5, id, `${COMPLETED}${output}`)]
  return [
    { t: 0, type: 'session_meta', payload: { id: PR_ID, cwd: '/workspace/demo' } },
    { t: 0.5, type: 'turn_context', payload: { cwd: '/workspace/demo', model: 'gpt-fixture' } },
    task(1, 'task_started', 'turn-1'),
    userItem(2, [{ type: 'input_text', text: 'Open both pull requests.' }]),
    userEvent(2.001, 'Open both pull requests.'),
    // Backgrounded: the create is still running when the script returns.
    ...run(3, 'call-a', 'text(await tools.exec_command({cmd:"git push -u origin feat/a && /usr/local/bin/gh-drew pr create --base main --head feat/a --title \'feat: a\' --body-file /tmp/a.md",yield_time_ms:1000}))',
      result({ session_id: 59242, output: '' })),
    ...run(5, 'call-poll', 'text(await tools.write_stdin({session_id:59242,chars:"",yield_time_ms:1000}))',
      result({ exit_code: 0, output: 'https://github.com/o/demo/pull/14\n' })),
    // Finished within the call: its URL is inside the escaped output.
    ...run(7, 'call-b', 'text(await tools.exec_command({cmd:"gh-drew pr create --base main --head feat/b --title \'feat: b\' --body-file /tmp/b.md"}))',
      result({ exit_code: 0, output: "remote: Create a pull request for 'feat/b' on GitHub\nhttps://github.com/o/demo/pull/15\n" })),
    task(9, 'task_complete', 'turn-1'),
  ]
}

describe('pull requests a Codex code-mode script created', () => {
  let prEnv: Record<string, string>
  let prRollout: string
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-code-mode-prs-'))
    const sessions = join(dir, 'home', '.codex', 'sessions', '2026', '09', '08')
    await mkdir(sessions, { recursive: true })
    prRollout = join(sessions, `rollout-2026-09-08T10-00-00-${PR_ID}.jsonl`)
    await writeFile(prRollout, `${codeModePullRequests().map(({ t, ...row }) => JSON.stringify({ timestamp: at(t), ...row })).join('\n')}\n`)
    prEnv = { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') }
  })

  it('are read from the results the script printed, and from a later poll of a create still running, on both paths', async () => {
    for (const argv of [[prRollout], [prRollout, '--latest-turn']]) {
      const run = await runCli(['facts', ...argv, '--format', 'json'], { env: prEnv })
      expect(run.stderr).toBe('')
      expect(run.code).toBe(0)
      const { created } = (JSON.parse(run.stdout) as { sessions: Array<{ pullRequests: { value: { created: Array<{ number: string; headBranch: string; at: string }> } } }> })
        .sessions[0]!.pullRequests.value
      expect(created.map(({ number, headBranch, at: when }) => ({ number, headBranch, at: when }))).toEqual([
        { number: '14', headBranch: 'feat/a', at: at(3) },
        { number: '15', headBranch: 'feat/b', at: at(7) },
      ])
    }
  })
})

/**
 * Processes a code-mode script started in a loop, the way current Codex
 * records one: an `exec` call whose JavaScript runs `tools.exec_command` once
 * per element of an array literal, with the command a template literal over
 * the loop variable, and a receipt holding only what the script printed. Next
 * to it, the same program run straight from `exec_command`, whose output names
 * its exit code. facts counts each run by program, and the search lists each
 * command the loop ran, not the template.
 */
const LOOP_ID = '0199c0de-0000-7000-8000-0000000100f0'
const direct = (t: number, id: string, cmd: string, exitCode: number, output: string): Row[] => [
  { t, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd, workdir: '/workspace/demo', yield_time_ms: 10000 }), call_id: id } },
  {
    t: t + 0.5,
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: id, output: `Chunk ID: 8518b0\nWall time: 1.0 seconds\nProcess exited with code ${exitCode}\nOriginal token count: 9\nOutput:\n${output}\n` },
  },
]

function codeModeLoop(): Row[] {
  return [
    { t: 0, type: 'session_meta', payload: { id: LOOP_ID, cwd: '/workspace/demo' } },
    { t: 0.5, type: 'turn_context', payload: { cwd: '/workspace/demo', model: 'gpt-fixture' } },
    task(1, 'task_started', 'turn-1'),
    userItem(2, [{ type: 'input_text', text: 'Start the probe runs.' }]),
    userEvent(2.001, 'Start the probe runs.'),
    ...direct(3, 'call-v1', 'labctl run beta-probe --variant v1', 0, 'started run b-01 (spec beta-probe, variant v1)'),
    ...direct(5, 'call-g', 'labctl run gamma-grid', 1, 'error: config gamma-grid.yaml: missing required field seed'),
    script(7, 'call-loop', 'for (const variant of ["v3", "v4"]) {\n  const run = await tools.exec_command({ cmd: `labctl run beta-probe --variant ${variant}` })\n  text(run.output)\n}'),
    scriptOutput(8, 'call-loop', `${COMPLETED}started run b-03 (spec beta-probe, variant v3)\nstarted run b-04 (spec beta-probe, variant v4)\n`),
    ...direct(9, 'call-c', 'cd /workspace/demo && labctl cancel b-9', 2, 'error: no such run: b-9'),
    task(11, 'task_complete', 'turn-1'),
  ]
}

describe('processes a Codex code-mode script started in a loop', () => {
  let loopEnv: Record<string, string>
  let loopRollout: string
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-code-mode-loop-'))
    const sessions = join(dir, 'home', '.codex', 'sessions', '2026', '09', '08')
    await mkdir(sessions, { recursive: true })
    loopRollout = join(sessions, `rollout-2026-09-08T10-00-00-${LOOP_ID}.jsonl`)
    await writeFile(loopRollout, `${codeModeLoop().map(({ t, ...row }) => JSON.stringify({ timestamp: at(t), ...row })).join('\n')}\n`)
    loopEnv = { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') }
  })

  it('count once per element, by program, with the failures their own exit codes show, on both read paths', async () => {
    for (const argv of [[loopRollout], [loopRollout, '--latest-turn']]) {
      const run = await runCli(['facts', ...argv, '--format', 'json'], { env: loopEnv })
      expect(run.stderr).toBe('')
      expect(run.code).toBe(0)
      const { commands } = (JSON.parse(run.stdout) as { sessions: Array<{ commands: { value: Array<Record<string, unknown>> } }> }).sessions[0]!
      expect(commands.value.map(({ command, runs, failed, inScripts }) => ({ command, runs, failed, inScripts }))).toEqual([
        { command: 'labctl run', runs: 4, failed: 1, inScripts: 2 },
        { command: 'labctl cancel', runs: 1, failed: 1, inScripts: 0 },
      ])
    }
  })

  it('are a line of the text sheet, next to the tool calls that failed', async () => {
    const run = await runCli(['facts', loopRollout], { env: loopEnv })
    expect(run.code).toBe(0)
    const lines = run.stdout.split('\n')
    expect(lines.find((line) => line.startsWith('tools '))).toBe('tools 4 (exec_command 4 (2 failed)) · subagents 0')
    expect(lines).toContain('commands 5: labctl run 4 (1 failed, 2 in scripts), labctl cancel 1 (1 failed)')
  })

  it('are search rows, one per command the loop ran', async () => {
    const run = await runCli(['facts', loopRollout, '--match', '^labctl run', '--format', 'json'], { env: loopEnv })
    expect(run.code).toBe(0)
    expect((JSON.parse(run.stdout) as { matches: Array<{ text: string }> }).matches.map((match) => match.text)).toEqual([
      'labctl run beta-probe --variant v1',
      'labctl run gamma-grid',
      'labctl run beta-probe --variant v3',
      'labctl run beta-probe --variant v4',
    ])
  })

  it('are withheld with the conversation under --no-content', async () => {
    const run = await runCli(['facts', loopRollout, '--no-content', '--format', 'json'], { env: loopEnv })
    expect(run.code).toBe(0)
    expect((JSON.parse(run.stdout) as { sessions: Array<{ commands: unknown }> }).sessions[0]!.commands).toEqual({
      value: null, spanIds: [], unavailable: 'Content was not requested.',
    })
  })
})
