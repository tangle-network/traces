/**
 * The waste measures and skill counts of `traces facts` (U4), through the built
 * CLI, against oracles read from the planted raw records rather than from facts:
 * failing-command streaks, `git revert` and `reset --hard`, stalls of 10
 * minutes or more that no turn sent in ended, active minutes with each gap
 * capped at 10, rework the way `reflect/scripts/self-audit` counts it, and
 * skill use by the classifier `traces skills` applies to the same store.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { serializeSpans, span } from '../src/otlp.js'
import { runCli } from './run-cli.js'

const CLAUDE_ID = 'f0cafe01-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CODEX_ID = '0199fa11-cccc-7ccc-8ccc-cccccccccccc'
const CWD = '/w/measured-repo'
const START = Date.parse('2026-10-14T10:00:00.000Z')
const at = (minute: number, second = 0): string => new Date(START + minute * 60_000 + second * 1000).toISOString()

type Row = Record<string, unknown>
const jsonl = (rows: readonly Row[]): string => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`

/** A Claude Code session that loops on a failing test, rolls back, waits, uses skills and idles. */
function claudeSession(): Row[] {
  let n = 0
  const base = { sessionId: CLAUDE_ID, cwd: CWD, version: '2.1.0', gitBranch: 'main' }
  const user = (time: string, content: unknown, extra: Row = {}): Row =>
    ({ ...base, type: 'user', uuid: `u${++n}`, parentUuid: null, timestamp: time, message: { role: 'user', content }, ...extra })
  const assistant = (time: string, content: unknown[]): Row => ({
    ...base, type: 'assistant', uuid: `a${++n}`, parentUuid: null, timestamp: time,
    message: { id: `msg-${n}`, role: 'assistant', model: 'claude-opus-5-5', content, usage: { input_tokens: 10, output_tokens: 2 } },
  })
  const call = (time: string, id: string, name: string, input: Row): Row => assistant(time, [{ type: 'tool_use', id, name, input }])
  const result = (time: string, id: string, text: string, isError = false): Row =>
    user(time, [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }])
  const say = (time: string, text: string): Row => assistant(time, [{ type: 'text', text }])
  return [
    user(at(0), 'Fix the tests.'),
    call(at(1), 't1', 'Bash', { command: 'pnpm test' }), result(at(2), 't1', 'FAIL a.test.ts', true),
    call(at(3), 'e1', 'Edit', { file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' }), result(at(3, 30), 'e1', 'ok'),
    call(at(4), 't2', 'Bash', { command: 'pnpm test' }), result(at(5), 't2', 'FAIL a.test.ts', true),
    call(at(6), 't3', 'Bash', { command: 'pnpm   test' }), result(at(7), 't3', 'FAIL a.test.ts', true),
    call(at(8), 't4', 'Bash', { command: 'pnpm test' }), result(at(9), 't4', 'PASS'),
    call(at(10), 'r1', 'Bash', { command: 'git reset --hard HEAD~1' }), result(at(10, 10), 'r1', 'HEAD is now at abc1234'),
    call(at(11), 'r2', 'Bash', { command: `git -C ${CWD} revert --no-edit abc1234` }), result(at(11, 10), 'r2', '[main d00d] Revert'),
    // Fifteen minutes on one command: a stall the command's result ends.
    call(at(12), 'w1', 'Bash', { command: 'sleep 900 && pnpm build' }), result(at(27), 'w1', 'built'),
    call(at(28), 's1', 'Skill', { skill: 'verify' }), result(at(28, 5), 's1', 'Launching skill: verify'),
    // Claude Code records a skill when it loads one: reading the document is not a use there.
    call(at(29), 'd1', 'Bash', { command: 'cat /h/.claude/skills/simplify/SKILL.md' }), result(at(29, 5), 'd1', '# Simplify'),
    say(at(31), 'Done: the tests pass.'),
    // Two hours later the person writes: their time, not a stall.
    user(at(151), 'Thanks. Now reflect on it.'),
    // Fourteen minutes before the agent answers: an idle stall.
    say(at(165), 'Reflecting.'),
    user(at(170), '<command-message>reflect</command-message>\n<command-name>/reflect</command-name>', { uuid: 'slash-1' }),
    user(at(170, 1), [{ type: 'text', text: 'Base directory for this skill: /h/.claude/skills/reflect\n\nReflect on the session.' }], {
      uuid: 'slash-1-expansion', parentUuid: 'slash-1', isMeta: true,
    }),
    say(at(171), 'Reflected.'),
    // A background build: twenty minutes until its notice arrives is waiting on a command.
    call(at(172), 'b1', 'Bash', { command: 'pnpm build', run_in_background: true }), result(at(172, 5), 'b1', 'Command running in background with ID: b1'),
    say(at(172, 10), 'Waiting for the build.'),
    user(at(192, 10), '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>'),
    say(at(193), 'The build passed.'),
    // Forty minutes until another session sends a message: the session waited for input, no stall.
    user(at(233), '[fleet-message-id: f-1] Ship it.'),
    say(at(234), 'Shipped.'),
  ]
}

/** A Codex rollout that reads skill documents, sweeps a catalog, repeats a command and rolls back. */
function codexRollout(): Row[] {
  let call = 0
  const shell = (minute: number, command: string, output: string, exitCode = 0): Row[] => {
    const id = `call-${++call}`
    return [
      { timestamp: at(minute), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: id, arguments: JSON.stringify({ command: ['bash', '-lc', command] }) } },
      { timestamp: at(minute, 2), type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify({ output, metadata: { exit_code: exitCode } }) } },
    ]
  }
  return [
    { timestamp: at(0), type: 'session_meta', payload: { id: CODEX_ID, timestamp: at(0), cwd: CWD, originator: 'codex_cli_rs', cli_version: '0.150.0' } },
    { timestamp: at(0, 1), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: at(0, 2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Simplify the module.' }] } },
    ...shell(1, 'cat /h/.agents/skills/simplify/SKILL.md', '# Simplify'),
    // One command that reads three skills is a catalog sweep: it counts for none.
    ...shell(2, 'cat a/SKILL.md b/SKILL.md c/SKILL.md', '# A\n# B\n# C'),
    ...shell(3, 'cat /h/.agents/skills/missing/SKILL.md', 'cat: /h/.agents/skills/missing/SKILL.md: No such file or directory', 1),
    ...shell(4, 'git status', 'clean'),
    ...shell(5, 'git status', 'clean'),
    ...shell(6, 'git reset --hard origin/main', 'HEAD is now at 1234abc'),
    { timestamp: at(7), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Simplified.' }] } },
    { timestamp: at(7, 1), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
  ]
}

interface Fact<T> { value: T | null; spanIds: string[]; unavailable: string | null }
interface Measured {
  sessionId: string
  measurements: {
    skills: Record<string, { model: number; slash: number; read: number }>
    activeMinutes: Fact<number>
    waste: {
      minutes: number | null
      unavailable: string | null
      failingStreaks: Fact<Array<{ command: string | null; tool: string; runs: number; minutes: number; spanIds: string[] }>>
      stalls: Fact<Array<{ minutes: number; kind: string }>>
      rollbacks: Fact<number>
      repeatedCommands: Fact<{ commands: number; extraRuns: number }>
    }
  }
}

let env: Record<string, string>
let claudeFile: string
let codexFile: string
let claudeRows: Row[]
let codexRows: Row[]
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'traces-facts-measures-'))
  const home = join(root, 'home')
  env = { HOME: home, XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache') }
  const project = join(home, '.claude', 'projects', CWD.replace(/\//gu, '-'))
  const codexDay = join(home, '.codex', 'sessions', '2026', '10', '14')
  await mkdir(project, { recursive: true })
  await mkdir(codexDay, { recursive: true })
  claudeRows = claudeSession()
  codexRows = codexRollout()
  claudeFile = join(project, `${CLAUDE_ID}.jsonl`)
  codexFile = join(codexDay, `rollout-2026-10-14T10-00-00-${CODEX_ID}.jsonl`)
  await writeFile(claudeFile, jsonl(claudeRows))
  await writeFile(codexFile, jsonl(codexRows))
})

async function measured(argv: readonly string[]): Promise<Measured> {
  const run = await runCli(['facts', ...argv, '--format', 'json'], { env })
  expect(run.stderr).not.toMatch(/^error:/mu)
  expect(run.code).toBe(0)
  return (JSON.parse(run.stdout) as { sessions: Measured[] }).sessions[0]!
}

/** The shell commands of a Claude Code session's raw records, as self-audit reads them. */
function claudeCommands(rows: readonly Row[]): string[] {
  return rows.flatMap((row) => row.type !== 'assistant' ? [] : ((row.message as { content: Row[] }).content)
    .filter((part) => part.type === 'tool_use' && typeof (part.input as Row).command === 'string')
    .map((part) => String((part.input as Row).command).replace(/\s+/gu, ' ').trim()))
}

/** self-audit's rework: commands run more than once, and the runs beyond each one's first. */
function rework(commands: readonly string[]): { commands: number; extraRuns: number } {
  const counts = new Map<string, number>()
  for (const command of commands) counts.set(command, (counts.get(command) ?? 0) + 1)
  const repeated = [...counts.values()].filter((count) => count > 1)
  return { commands: repeated.length, extraRuns: repeated.reduce((sum, count) => sum + count - 1, 0) }
}

/** Minutes between consecutive record times, each gap capped at 10. */
function cappedMinutes(rows: readonly Row[]): number {
  const times = rows.map((row) => Date.parse(String(row.timestamp))).filter(Number.isFinite).sort((a, b) => a - b)
  let total = 0
  for (let i = 1; i < times.length; i++) total += Math.min(times[i]! - times[i - 1]!, 600_000)
  return Math.round(total / 6_000) / 10
}

describe('facts waste measures', () => {
  // Both read paths are held equal on single-turn sessions in dual-path.test.ts; this one has
  // several turns, so `--latest-turn` would read only the last.
  it('reads streaks, rollbacks, stalls and active minutes from a Claude Code session',
    async () => {
      const { waste, activeMinutes } = (await measured([claudeFile])).measurements
      expect(waste.failingStreaks.value!.map(({ command, tool, runs, minutes }) => ({ command, tool, runs, minutes }))).toEqual([
        { command: 'pnpm test', tool: 'Bash', runs: 3, minutes: 6 },
      ])
      expect(waste.failingStreaks.value![0]!.spanIds).toHaveLength(3)
      expect(waste.rollbacks.value).toBe(2)
      expect(waste.repeatedCommands.value).toEqual(rework(claudeCommands(claudeRows)))
      expect(waste.repeatedCommands.value).toEqual({ commands: 1, extraRuns: 3 })
      expect(waste.stalls.value!.map(({ minutes, kind }) => ({ minutes, kind }))).toEqual([
        { minutes: 15, kind: 'waiting on a command' },
        { minutes: 14, kind: 'idle' },
        { minutes: 20, kind: 'waiting on a command' },
      ])
      expect(activeMinutes.value).toBe(cappedMinutes(claudeRows))
      expect(activeMinutes.value).toBe(75)
      // The streak and the three stalls do not overlap: 6 + 15 + 14 + 20 minutes.
      expect(waste.minutes).toBe(55)
      expect(waste.unavailable).toBeNull()
    },
  )

  it('counts rework and rollbacks in a Codex rollout, and no stall in a session with no gap', async () => {
    const { waste } = (await measured([codexFile])).measurements
    expect(waste.rollbacks.value).toBe(1)
    expect(waste.repeatedCommands.value).toEqual({ commands: 1, extraRuns: 1 })
    expect(waste.stalls.value).toEqual([])
    expect(waste.minutes).toBe(0)
  })

  it('prints the time lost, the active time and the skills on the text sheet', async () => {
    const run = await runCli(['facts', claudeFile], { env })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('\nwaste 55 min: `pnpm test` failed 3× in a row (6 min) · 3 stalls ≥ 10 min (49 min) · reverts 2\n')
    expect(run.stdout).toMatch(/ · active 1\.3 h$/mu)
    expect(run.stdout).toContain('\nskills reflect 1, verify 1\n')
  })

  it('withholds a streak command under --no-content and keeps its counts', async () => {
    const run = await runCli(['facts', claudeFile, '--no-content', '--format', 'json'], { env })
    expect(run.code).toBe(0)
    const { waste } = (JSON.parse(run.stdout) as { sessions: Measured[] }).sessions[0]!.measurements
    expect(waste.failingStreaks.value).toEqual([expect.objectContaining({ command: null, runs: 3 })])
    expect(run.stdout).not.toContain('pnpm test')
    const text = await runCli(['facts', claudeFile, '--no-content'], { env })
    expect(text.stdout).toContain('\nwaste 55 min: a Bash command failed 3× in a row (6 min) · ')
    expect(text.stdout).not.toContain('pnpm test')
  })

  it('says a command measure is unknown, not zero, when no tool call kept its arguments', async () => {
    const file = join(env.HOME!, 'metadata-only.otlp.jsonl')
    const trace = 'a'.repeat(32)
    await writeFile(file, serializeSpans([
      span({ traceId: trace, spanId: '1'.repeat(16), name: 'session', kind: 'AGENT', startTime: at(0), endTime: at(2), service: 'claude-code' }),
      span({ traceId: trace, spanId: '2'.repeat(16), parentSpanId: '1'.repeat(16), name: 'tool.Bash', kind: 'TOOL', tool: 'Bash', startTime: at(1), endTime: at(1, 30), service: 'claude-code' }),
    ]))
    const { waste } = (await measured([file])).measurements
    expect(waste.repeatedCommands).toMatchObject({ value: null, unavailable: expect.stringContaining('arguments') })
    expect(waste.rollbacks.value).toBeNull()
    expect(waste.minutes).toBeNull()
    expect(waste.unavailable).toContain('arguments')
  })
})

describe('facts skill counts', () => {
  it('counts what traces skills counts for the same session: a loaded skill and an expanded slash command', async () => {
    const facts = await measured([claudeFile])
    expect(facts.measurements.skills).toEqual({
      verify: { model: 1, slash: 0, read: 0 },
      reflect: { model: 0, slash: 1, read: 0 },
    })
    const skills = await runCli(['skills', '--since', '2026-10-01T00:00:00Z', '--format', 'json'], { env })
    expect(skills.code).toBe(0)
    const rows = (JSON.parse(skills.stdout) as { rows: Array<{ skill: string; model: number; slash: number; read: number }> }).rows
    const claudeRows = Object.fromEntries(rows.filter((row) => row.skill !== 'simplify').map(({ skill, model, slash, read }) => [skill, { model, slash, read }]))
    expect(claudeRows).toEqual(facts.measurements.skills)
  })

  it('counts a Codex skill-document read, not a catalog sweep or a missing document', async () => {
    const facts = await measured([codexFile])
    expect(facts.measurements.skills).toEqual({ simplify: { model: 0, slash: 0, read: 1 } })
  })
})
