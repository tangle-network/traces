/**
 * The generator is checked two ways.
 *
 * Determinism: the same seed must give the same bytes, or an arm scored today
 * and an arm scored tomorrow answered different questions.
 *
 * Gold equality: every planted fact is recomputed here by reading the generated
 * JSONL back, with no access to the generator's bookkeeping and no traces
 * adapter in the path. If the plan and the bytes ever disagree, the answer key
 * is wrong, and that has to fail here rather than silently mark a correct arm
 * wrong.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../../src/adapters/claude.js'
import { CodexAdapter } from '../../src/adapters/codex.js'
import { generateBench, writeFixtures } from './fixtures.js'
import { QUESTIONS, answerJsonSchema, promptRows } from './questions.js'
import { TIME_TOLERANCE_MS } from './score.js'

const bench = generateBench()
const fileByPath = new Map(bench.files.map((file) => [file.path, file.content]))

const operatorPath = bench.manifest.sessions.find((session) => session.id === 'codex-operator')!.path
const childPath = bench.manifest.sessions.find((session) => session.id === 'codex-child')!.path
const claudePath = bench.manifest.sessions.find((session) => session.id === 'claude')!.path

interface CodexRow {
  line: number
  timestamp: string
  type: string
  payload: Record<string, unknown>
}

function codexRows(path: string): CodexRow[] {
  return fileByPath.get(path)!.split('\n').filter((line) => line.length > 0).map((line, index) => {
    const row = JSON.parse(line) as { timestamp: string; type: string; payload: Record<string, unknown> }
    return { line: index + 1, ...row }
  })
}

const operator = codexRows(operatorPath)

/** Tool calls paired with the output record that answered them. */
interface CodexCall {
  name: string
  argument: string
  call: CodexRow
  output: string
}

function codexCalls(rows: readonly CodexRow[]): CodexCall[] {
  const pending = new Map<string, { name: string; argument: string; call: CodexRow }>()
  const calls: CodexCall[] = []
  for (const row of rows) {
    const payload = row.payload
    const type = payload.type
    if (type === 'function_call' || type === 'custom_tool_call') {
      pending.set(String(payload.call_id), {
        name: String(payload.name),
        argument: String(type === 'function_call' ? payload.arguments : payload.input),
        call: row,
      })
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const started = pending.get(String(payload.call_id))
      if (started) calls.push({ ...started, output: String(payload.output ?? '') })
    }
  }
  return calls
}

const operatorCalls = codexCalls(operator)
const commandOf = (call: CodexCall): string => String((JSON.parse(call.argument) as { cmd?: string }).cmd ?? '')
const execCalls = operatorCalls.filter((call) => call.name === 'exec_command')
const scripts = operatorCalls.filter((call) => call.name === 'exec')
const spawnCalls = operatorCalls.filter((call) => call.name === 'spawn_agent')

/** A run one launch reported as started, read from the output line that announced it. */
interface StartedRun {
  id: string
  spec: string
  variant?: string
}

/** Every launch these outputs announced, whether the command ran directly or inside a script. */
function startedRuns(calls: readonly CodexCall[]): StartedRun[] {
  return calls.flatMap((call) =>
    [...call.output.matchAll(/^started run (\S+) \(spec ([^,)]+)(?:, variant ([^)]+))?\)$/gm)]
      .map((match) => ({ id: match[1]!, spec: match[2]!, ...(match[3] ? { variant: match[3] } : {}) })),
  )
}

/** Pull request numbers a merge confirmation names in a tool output. */
const mergedIn = (text: string): number[] =>
  [...text.matchAll(/Squashed and merged pull request [^#]+#(\d+)/g)].map((match) => Number(match[1]))

const directLaunches = execCalls.filter((call) => commandOf(call).startsWith('labctl run '))
const failedLaunches = directLaunches.filter((call) => /Process exited with code (?!0)/.test(call.output))
const launches = startedRuns([...execCalls, ...scripts])

/** Text of a user message, or undefined for any other record. */
function userText(row: CodexRow): string | undefined {
  if (row.payload.type !== 'message' || row.payload.role !== 'user') return undefined
  const content = row.payload.content as Array<{ text?: string }>
  return content.map((part) => part.text ?? '').join('')
}

/** A human turn is a user message the harness did not inject. */
const humanTurns = operator
  .map((row) => ({ row, text: userText(row) }))
  .filter((item): item is { row: CodexRow; text: string } => item.text !== undefined)
  .filter((item) => !item.text.startsWith('<') && !item.text.startsWith('#'))

/** Every gold value the scorer compares as a time, wherever it sits in an answer. */
const scoredTimes = QUESTIONS.flatMap((question) => {
  const gold = bench.gold[question.id]!
  return Object.entries(question.schema).flatMap(([name, field]) => {
    if (field.kind === 'time') return [String(gold[name])]
    if (field.kind !== 'records') return []
    const rows = gold[name] as Array<Record<string, unknown>>
    return Object.entries(field.fields)
      .filter(([, subfield]) => subfield.kind === 'time')
      .flatMap(([subfield]) => rows.map((row) => row[subfield]).filter((value) => value != null).map(String))
  })
})

describe('audit benchmark generator', () => {
  it('produces the same bytes on every run', () => {
    const again = generateBench()
    expect(again.files).toEqual(bench.files)
    expect(again.manifest).toEqual(bench.manifest)
    expect(again.gold).toEqual(bench.gold)
  })

  it('writes exactly the manifest files, byte for byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'traces-bench-write-'))
    try {
      await writeFixtures(root, bench)
      for (const path of bench.manifest.files) {
        expect(await readFile(join(root, path), 'utf8')).toBe(fileByPath.get(path))
      }
      expect(bench.manifest.files).toEqual([...bench.manifest.files].sort())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('asks exactly the questions the gold answers', () => {
    expect(QUESTIONS.map((question) => question.id).sort()).toEqual(Object.keys(bench.gold).sort())
    expect(new Set(QUESTIONS.map((question) => question.id)).size).toBe(QUESTIONS.length)
    for (const question of QUESTIONS) {
      const schema = answerJsonSchema(question) as { required: string[] }
      expect(schema.required.sort()).toEqual(Object.keys(bench.gold[question.id]!).sort())
    }
  })

  it('keeps every scored time further apart than the scorer tolerates', () => {
    // The 1 s tolerance is only safe while no other record in the same file carries a time
    // within 1 s of a scored one; otherwise a neighbor's time would be accepted as correct.
    const codexTimes = [operatorPath, childPath].map((path) => codexRows(path).map((row) => Date.parse(row.timestamp)))
    expect(scoredTimes.length).toBeGreaterThan(5)
    for (const value of scoredTimes) {
      const at = Date.parse(value)
      const times = codexTimes.find((list) => list.includes(at))
      expect(times, `${value} is not the timestamp of any record`).toBeDefined()
      expect(times!.filter((other) => other !== at && Math.abs(other - at) <= TIME_TOLERANCE_MS)).toEqual([])
    }
  })

  it('gives every question wording a prompt naming its session', () => {
    const rows = promptRows(bench.manifest)
    expect(rows).toHaveLength(QUESTIONS.reduce((sum, question) => sum + 1 + question.paraphrases.length, 0))
    for (const row of rows) {
      expect(row.prompt).toContain(row.sessionPath)
      expect(row.heldOut).toBe(row.variant > 0)
    }
  })
})

describe('planted facts in the operator session', () => {
  it('is long enough that no single read covers it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'traces-bench-spans-'))
    try {
      await writeFixtures(root, bench)
      const spans = await new CodexAdapter().parse({
        harness: 'codex',
        sessionId: bench.manifest.sessions[0]!.sessionId,
        path: join(root, operatorPath),
        cwd: null,
        mtimeMs: 0,
      })
      expect(spans.length).toBeGreaterThan(600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('repeats one command past any single page of matches', () => {
    const polls = execCalls.filter((call) => commandOf(call).startsWith('labctl status '))
    expect(polls.length).toBeGreaterThan(500)
    expect(bench.gold['op.status-polls']).toEqual({ status_commands: polls.length })
  })

  it('spawns sixteen agents, one of which fails', () => {
    expect(spawnCalls).toHaveLength(16)
    expect(spawnCalls.filter((call) => call.output.startsWith('spawn_agent failed'))).toHaveLength(1)
    const succeeded = spawnCalls.filter((call) => !call.output.startsWith('spawn_agent failed'))
    const names = [...new Set(succeeded.map((call) => String((JSON.parse(call.argument) as { task_name: string }).task_name)))].sort()
    expect(bench.gold['op.subagents']).toEqual({ spawn_calls: 16, failed_spawns: 1, task_names: names })
  })

  it('opens three pull requests three different ways', () => {
    const numbersIn = (text: string): number[] => [...text.matchAll(/\/pull\/(\d+)/g)].map((match) => Number(match[1]))
    const stdinCalls = operatorCalls.filter((call) => call.name === 'write_stdin')
    // One inside an exec script, one straight from exec_command, one that only a later poll reveals.
    expect(scripts.flatMap((call) => numbersIn(call.output))).toEqual([41])
    expect(execCalls.filter((call) => commandOf(call).startsWith('gh pr create')).flatMap((call) => numbersIn(call.output))).toEqual([42])
    expect(stdinCalls.flatMap((call) => numbersIn(call.output))).toEqual([43])
    const create43 = execCalls.find((call) => commandOf(call).includes('docs(retry): budget guide'))
    expect(create43).toBeDefined()
    expect(numbersIn(create43!.output)).toEqual([])
    expect((bench.gold['op.pull-requests']!.prs as Array<{ number: number }>).map((pr) => pr.number)).toEqual([41, 42, 43])
  })

  it('merges three pull requests three different ways', () => {
    expect(execCalls.flatMap((call) => mergedIn(call.output))).toEqual([41])
    expect(operatorCalls.filter((call) => call.name === 'write_stdin').flatMap((call) => mergedIn(call.output))).toEqual([42])
    expect(scripts.flatMap((call) => mergedIn(call.output))).toEqual([43])
    const prs = bench.gold['op.pull-requests']!.prs as Array<{ number: number; merged_at?: string }>
    expect(prs.filter((pr) => pr.merged_at)).toHaveLength(3)
    // A merge that the harness refused must not count as the merge.
    expect(execCalls.some((call) => commandOf(call) === 'gh pr merge 41 --squash' && call.output.includes('not mergeable'))).toBe(true)
  })

  it('repeats and cancels run commands', () => {
    // A direct launch either announced a run or exited nonzero; nothing else is a launch,
    // so the announcements and the failures together account for every `labctl run` call.
    expect(startedRuns(execCalls).length + failedLaunches.length).toBe(directLaunches.length)
    // Two more launches happen inside an exec script, where no `labctl run` call record exists.
    expect(startedRuns(scripts).length).toBeGreaterThan(0)
    const specs = launches.map((run) => run.spec)
    expect(new Set(specs).size).toBeLessThan(specs.length)
    const cancels = execCalls.filter((call) => commandOf(call).startsWith('labctl cancel '))
    const cancelled = cancels.filter((call) => call.output.includes('Process exited with code 0'))
    expect(cancels.length).toBeGreaterThan(cancelled.length)
    expect(bench.gold['op.runs']).toEqual({
      launched: launches.length,
      failed_launches: failedLaunches.length,
      cancelled: cancelled.length,
      specs: [...new Set(specs)].sort(),
      beta_probe_variants: [...new Set(launches.filter((run) => run.spec === 'beta-probe').map((run) => run.variant!))].sort(),
    })
  })

  it('acted as an operator, in the merges, launches and spawns the bytes show', () => {
    // What makes this session the operator rather than an observer: it carries typed human
    // turns, no parent thread claims it, and it merged, launched and spawned work itself.
    expect(operator[0]!.payload.parent_thread_id).toBeUndefined()
    expect(humanTurns.length).toBeGreaterThan(3)
    expect(bench.gold['op.role']).toEqual({
      role: 'operator',
      merged_prs: operatorCalls.flatMap((call) => mergedIn(call.output)).length,
      launched_runs: launches.length,
      spawn_calls: spawnCalls.length,
    })
  })

  it('ends with a short human turn after a substantive one, then injected text', () => {
    const last = humanTurns.at(-1)!
    const previous = humanTurns.at(-2)!
    expect(last.text.length).toBeLessThan(8)
    expect(previous.text.length).toBeGreaterThan(40)
    const injectedAfter = operator.filter((row) => row.line > last.row.line && userText(row)?.startsWith('<'))
    expect(injectedAfter.length).toBeGreaterThan(0)
    expect(bench.gold['op.last-human-turn']).toEqual({
      last: { text: last.text, cite: `${operatorPath}:${last.row.line}` },
      last_at: last.row.timestamp,
      previous: { text: previous.text, cite: `${operatorPath}:${previous.row.line}` },
    })
  })

  it('runs apply_patch inside an exec script as well as on its own', () => {
    expect(scripts.some((call) => call.argument.includes('tools.apply_patch('))).toBe(true)
    const paths = new Set<string>()
    for (const call of operatorCalls) {
      const text = call.name === 'apply_patch' ? call.argument : call.name === 'exec' ? call.argument : ''
      for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.add(match[1]!)
    }
    expect(bench.gold['op.changed-files']).toEqual({ paths: [...paths].sort() })
  })

  it('holds one tool output past sixteen kibibytes', () => {
    const large = operatorCalls.filter((call) => Buffer.byteLength(call.output) > 16 * 1024)
    expect(large).toHaveLength(1)
    const lastLine = large[0]!.output.trimEnd().split('\n').at(-1)
    expect((bench.gold['op.large-output']!.last_line as { text: string }).text).toBe(lastLine)
  })

  it('records the counts the gold reports for exits, tokens and time bounds', () => {
    const exits = execCalls
      .map((call) => Number(/Process exited with code (-?\d+)/.exec(call.output)?.[1] ?? 0))
      .filter((code) => code !== 0)
    expect(bench.gold['op.exit-codes']).toEqual({
      nonzero_exec_commands: exits.length,
      codes: [...new Set(exits)].sort((a, b) => a - b),
    })
    const totals = operator
      .filter((row) => row.payload.type === 'token_count')
      .map((row) => (row.payload.info as { total_token_usage: Record<string, number> }).total_token_usage)
      .at(-1)!
    expect(bench.gold['op.tokens']).toEqual({
      input_tokens: totals.input_tokens,
      cached_input_tokens: totals.cached_input_tokens,
      output_tokens: totals.output_tokens,
    })
    expect(bench.gold['op.time-bounds']).toEqual({
      first_record_at: operator[0]!.timestamp,
      last_record_at: operator.at(-1)!.timestamp,
    })
  })

  it('quotes every correction at the record it was typed in', () => {
    const corrections = bench.gold['op.corrections']!.corrections as Array<{ text: string; cite: string }>
    expect(corrections.length).toBeGreaterThan(1)
    for (const correction of corrections) {
      const line = Number(correction.cite.split(':').at(-1))
      expect(userText(operator[line - 1]!)).toBe(correction.text)
    }
  })
})

describe('planted facts in the forked child session', () => {
  const child = codexRows(childPath)
  const meta = child[0]!.payload as Record<string, unknown>

  it('names its parent and repeats the parent history it forked from', () => {
    expect(meta.parent_thread_id).toBe(bench.manifest.sessions[0]!.sessionId)
    expect(bench.gold['child.lineage']).toEqual({ parent_session_id: meta.parent_thread_id, agent_path: meta.agent_path })
    const inherited = child.slice(1).filter((row) => row.timestamp === child[0]!.timestamp)
    expect(inherited.length).toBeGreaterThan(10)
    const parentBodies = new Set(operator.map((row) => JSON.stringify(row.payload)))
    for (const row of inherited) expect(parentBodies.has(JSON.stringify(row.payload))).toBe(true)
  })

  it('counts only the work it did after the fork', () => {
    const own = child.filter((row) => row.timestamp !== child[0]!.timestamp)
    const calls = own.filter((row) => row.payload.type === 'function_call' || row.payload.type === 'custom_tool_call')
    const failed = codexCalls(own).filter((call) => /Process exited with code (?!0)/.test(call.output))
    expect(bench.gold['child.own-work']).toEqual({
      task_started_at: own.find((row) => row.payload.type === 'task_started')!.timestamp,
      own_tool_calls: calls.length,
      failed_commands: failed.length,
    })
    expect(bench.gold['child.spawned']).toEqual({ spawned_session_ids: [] })
  })
})

describe('planted facts in the Claude session', () => {
  interface ClaudeRow {
    line: number
    type: string
    isSidechain: boolean
    message: { content: unknown }
  }
  const read = (path: string): ClaudeRow[] =>
    fileByPath.get(path)!.split('\n').filter((line) => line.length > 0)
      .map((line, index) => ({ line: index + 1, ...(JSON.parse(line) as Omit<ClaudeRow, 'line'>) }))
  const main = read(claudePath)
  const subagentFiles = bench.manifest.files.filter((path) => path.includes('/subagents/') && path.endsWith('.jsonl'))
  const blocks = (rows: readonly ClaudeRow[]): Array<Record<string, unknown>> =>
    rows.flatMap((row) => (Array.isArray(row.message.content) ? row.message.content as Array<Record<string, unknown>> : []))

  it('launches Task subagents that each get their own transcript', () => {
    const tasks = blocks(main).filter((block) => block.type === 'tool_use' && block.name === 'Task')
    expect(tasks).toHaveLength(3)
    expect(subagentFiles).toHaveLength(3)
    expect(bench.gold['claude.tasks']).toEqual({
      task_calls: tasks.length,
      subagent_types: [...new Set(tasks.map((task) => (task.input as { subagent_type: string }).subagent_type))].sort(),
      descriptions: tasks.map((task) => (task.input as { description: string }).description).sort(),
    })
    for (const row of subagentFiles.flatMap(read)) expect(row.isSidechain).toBe(true)
  })

  it('counts Bash errors in the main transcript and inside the subagents', () => {
    const bashIds = (rows: readonly ClaudeRow[]): Set<string> =>
      new Set(blocks(rows).filter((block) => block.type === 'tool_use' && block.name === 'Bash').map((block) => String(block.id)))
    const errors = (rows: readonly ClaudeRow[], ids: ReadonlySet<string>): number =>
      blocks(rows).filter((block) => block.type === 'tool_result' && block.is_error === true && ids.has(String(block.tool_use_id))).length
    const subagentRows = subagentFiles.flatMap(read)
    const mainIds = bashIds(main)
    const subIds = bashIds(subagentRows)
    const subErrors = errors(subagentRows, subIds)
    expect(bench.gold['claude.bash']).toEqual({
      bash_calls: mainIds.size + subIds.size,
      failed_bash_calls: errors(main, mainIds) + subErrors,
      failed_in_subagents: subErrors,
    })
    expect(subErrors).toBeGreaterThan(0)
  })

  it('quotes the first failing Bash output from the record that carries it', () => {
    const quote = bench.gold['claude.first-bash-error']!.output as { text: string; cite: string }
    const line = Number(quote.cite.split(':').at(-1))
    const results = blocks([main[line - 1]!]).filter((block) => block.is_error === true)
    expect(results).toHaveLength(1)
    expect(results[0]!.content).toBe(quote.text)
  })
})

describe('the Claude adapter reads the generated session', () => {
  let root: string | undefined
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('parses the main transcript into spans', async () => {
    root = await mkdtemp(join(tmpdir(), 'traces-bench-claude-'))
    await writeFixtures(root, bench)
    const session = bench.manifest.sessions.find((item) => item.harness === 'claude-code')!
    const spans = await new ClaudeAdapter().parse({
      harness: 'claude-code',
      sessionId: session.sessionId,
      path: join(root, session.path),
      cwd: null,
      mtimeMs: 0,
    })
    expect(spans.length).toBeGreaterThan(0)
  })
})
