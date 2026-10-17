/**
 * The three arms that answer the benchmark (spec U11).
 *
 * - `facts`: `traces facts --format json` over the three sessions, mapped to the
 *   19 answers by fixed rules. $0 and deterministic; `pnpm test` holds its score
 *   to `facts-score.json`, which may only rise.
 * - `raw-files`: one headless agent per question over a copy of the fixture
 *   tree, with no `traces` on PATH and a fixed budget.
 * - `traces`: the same agent, prompt and budget, with `traces` on PATH and the
 *   `inspect-agent-traces` skill installed the way a user installs it: in
 *   `.claude/skills/` of the agent's own HOME, where Claude Code reads user skills.
 *
 * Every arm writes the answers file `cli.ts score` grades. `traces` always runs
 * with HOME set to a store home over the fixture copy, so it can read the
 * fixtures as a home's session stores and can never read the machine's own.
 */

import { spawn } from 'node:child_process'
import { access, cp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BenchManifest, BenchSessionId } from './fixtures.js'
import { LARGE_QUESTIONS } from './large.js'
import { type PromptRow, promptRows } from './questions.js'
import type { AnswerRow, AnswersFile } from './score.js'

export type ArmName = 'facts' | 'raw-files' | 'traces'
export const ARMS: readonly ArmName[] = ['facts', 'raw-files', 'traces']

export interface ArmOptions {
  readonly arm: ArmName
  /** The generated fixture tree; it is never written to. */
  readonly root: string
  readonly manifest: BenchManifest
  /** The traces CLI to run (`dist/cli.js`). */
  readonly cli: string
  /** The traces arm: the directory holding `inspect-agent-traces/SKILL.md` (the package's `skills/`). */
  readonly skills?: string
  /** Scratch space: question copies, store homes and agent transcripts. */
  readonly work: string
  /** Model arms only. */
  readonly model?: string
  /** Model arms only: the most one question may spend. */
  readonly budgetUsd?: number
  readonly questions?: readonly string[]
  /** Canonical wordings only (the default), or every held-out paraphrase too. */
  readonly variants?: 'canonical' | 'all'
  readonly concurrency?: number
  readonly log?: (line: string) => void
}

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run a command to completion; past `timeoutMs` its whole process group (an agent and its shells) is stopped. */
function run(command: string, argv: readonly string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    const timer = options.timeoutMs ? setTimeout(() => process.kill(-child.pid!, 'SIGTERM'), options.timeoutMs) : undefined
    child.on('error', reject)
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

/** A home whose Codex and Claude Code stores are the fixture tree's, so traces reads the fixtures and nothing else. */
async function storeHome(root: string, dir: string): Promise<NodeJS.ProcessEnv> {
  await mkdir(join(dir, 'home', '.codex'), { recursive: true })
  await mkdir(join(dir, 'home', '.claude'), { recursive: true })
  await symlink(join(root, 'codex', 'sessions'), join(dir, 'home', '.codex', 'sessions'))
  await symlink(join(root, 'claude', 'projects'), join(dir, 'home', '.claude', 'projects'))
  return {
    HOME: join(dir, 'home'),
    XDG_STATE_HOME: join(dir, 'state'),
    XDG_CACHE_HOME: join(dir, 'cache'),
    XDG_CONFIG_HOME: join(dir, 'config'),
  }
}

// ---------------------------------------------------------------------------
// The facts arm
// ---------------------------------------------------------------------------

interface Fact<T> { value: T | null }
interface ToolRow { name: string; calls: number; outcomes: { ok: number; error: number; unset: number } }
interface PullRequest { number: string | null; at: string }
interface Sheet {
  sessionId: string
  parentSessionId: string | null
  toolCalls: Fact<number>
  toolCallsByName: Fact<Record<string, number>>
  subagents: Fact<Array<{ taskName: string | null; status: string }>>
  pullRequests: Fact<{ created: PullRequest[]; merged: PullRequest[] }>
  humanTurns: Fact<Array<{ at: string; text: string; spanId: string; signals: string[] }>>
  changedFiles: Fact<Array<{ path: string }>>
  firstRecordAt: Fact<string>
  lastRecordAt: Fact<string>
  firstFailure: { status: string; name?: string; message?: string; spanId?: string }
  tokens: { input: number | null; output: number | null; cacheRead: number | null }
  measurements: {
    tools: ToolRow[]
    relationship: { agentPath?: string | null; spawnedChildSessionIds?: string[]; taskStartedAt?: string }
  }
}
interface Match { kind: string; at: string; spanId: string; text: string }

/** What the facts arm reads: each session's sheet, and the command rows of a few searches. */
interface FactsReading {
  sheet(session: BenchSessionId): Sheet
  commands(session: BenchSessionId, pattern: string): Match[]
}

async function readFacts(options: ArmOptions): Promise<FactsReading> {
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NO_COLOR: '1', ...await storeHome(options.root, join(options.work, 'facts')) }
  const facts = async (argv: readonly string[]): Promise<unknown> => {
    const result = await run(process.execPath, [options.cli, 'facts', ...argv, '--format', 'json'], { env, timeoutMs: 120_000 })
    if (result.code !== 0) throw new Error(`traces facts ${argv.join(' ')} exited ${result.code}: ${result.stderr.trim()}`)
    return JSON.parse(result.stdout) as unknown
  }
  const pathOf = (session: BenchSessionId): string => join(options.root, options.manifest.sessions.find((item) => item.id === session)!.path)
  const sheets = new Map<BenchSessionId, Sheet>()
  for (const session of options.manifest.sessions) {
    sheets.set(session.id, (await facts([pathOf(session.id)]) as { sessions: Sheet[] }).sessions[0]!)
  }
  const searches = new Map<string, Match[]>()
  const patterns: Array<[BenchSessionId, string]> = [['codex-operator', '^labctl status\\b']]
  for (const [session, pattern] of patterns) {
    const { matches } = await facts([pathOf(session), '--match', pattern]) as { matches: Match[] }
    searches.set(`${session}\0${pattern}`, matches.filter((match) => match.kind === 'command'))
  }
  return {
    sheet: (session) => sheets.get(session)!,
    commands: (session, pattern) => searches.get(`${session}\0${pattern}`) ?? [],
  }
}

const tool = (sheet: Sheet, name: string): ToolRow | undefined => sheet.measurements.tools.find((row) => row.name === name)
/** Codex names a command that checks work `exec_command.verify`; both are exec_command calls. */
const execRows = (sheet: Sheet): ToolRow[] => sheet.measurements.tools.filter((row) => row.name === 'exec_command' || row.name === 'exec_command.verify')
const sum = (rows: readonly ToolRow[], read: (row: ToolRow) => number): number => rows.reduce((total, row) => total + read(row), 0)
const quote = (text: string | undefined, spanId: string | undefined) => (text !== undefined && spanId ? { text, cite: spanId } : null)

/**
 * Each question's answer from the sheets alone. A leaf the sheet has no field
 * for is null ("not in trace"), never a guess: the arm measures facts.
 */
const FACTS_ANSWERS: Readonly<Record<string, (facts: FactsReading) => Record<string, unknown>>> = {
  'op.subagents': (facts) => {
    const spawns = facts.sheet('codex-operator').subagents.value ?? []
    return {
      spawn_calls: spawns.length,
      failed_spawns: spawns.filter((spawn) => spawn.status === 'ERROR').length,
      task_names: [...new Set(spawns.filter((spawn) => spawn.status !== 'ERROR').map((spawn) => spawn.taskName).filter((name) => name !== null))],
    }
  },
  'op.pull-requests': (facts) => {
    const prs = facts.sheet('codex-operator').pullRequests.value
    return {
      prs: (prs?.created ?? []).filter((pr) => pr.number !== null).map((pr) => ({
        number: Number(pr.number),
        created_at: pr.at,
        merged_at: prs!.merged.find((merged) => merged.number === pr.number)?.at ?? null,
        reviewed_before_merge: null,
      })),
    }
  },
  'op.runs': () => ({ launched: null, failed_launches: null, cancelled: null, specs: null, beta_probe_variants: null }),
  'op.last-human-turn': (facts) => {
    const turns = facts.sheet('codex-operator').humanTurns.value ?? []
    const [previous, last] = turns.slice(-2)
    return { last: quote(last?.text, last?.spanId), last_at: last?.at ?? null, previous: quote(previous?.text, previous?.spanId) }
  },
  'op.role': (facts) => {
    const sheet = facts.sheet('codex-operator')
    const merged = sheet.pullRequests.value?.merged.length ?? null
    return {
      role: merged === null ? null : merged > 0 ? 'operator' : 'observer',
      merged_prs: merged,
      launched_runs: null,
      spawn_calls: sheet.subagents.value?.length ?? null,
    }
  },
  'op.local-copy': () => ({ path: null }),
  'op.corrections': (facts) => ({
    corrections: (facts.sheet('codex-operator').humanTurns.value ?? []).filter((turn) => turn.signals.length > 0).map((turn) => quote(turn.text, turn.spanId)),
  }),
  'op.time-bounds': (facts) => {
    const sheet = facts.sheet('codex-operator')
    return { first_record_at: sheet.firstRecordAt.value, last_record_at: sheet.lastRecordAt.value }
  },
  'op.exit-codes': (facts) => ({ nonzero_exec_commands: sum(execRows(facts.sheet('codex-operator')), (row) => row.outcomes.error), codes: null }),
  'op.changed-files': (facts) => ({ paths: facts.sheet('codex-operator').changedFiles.value?.map((file) => file.path) ?? null }),
  'op.status-polls': (facts) => ({ status_commands: facts.commands('codex-operator', '^labctl status\\b').length }),
  'op.large-output': () => ({ last_line: null }),
  'op.tokens': (facts) => {
    const { tokens } = facts.sheet('codex-operator')
    return { input_tokens: tokens.input, cached_input_tokens: tokens.cacheRead, output_tokens: tokens.output }
  },
  'child.lineage': (facts) => {
    const sheet = facts.sheet('codex-child')
    return { parent_session_id: sheet.parentSessionId, agent_path: sheet.measurements.relationship.agentPath ?? null }
  },
  'child.own-work': (facts) => {
    const sheet = facts.sheet('codex-child')
    return { task_started_at: sheet.measurements.relationship.taskStartedAt ?? null, own_tool_calls: sheet.toolCalls.value, failed_commands: sum(execRows(sheet), (row) => row.outcomes.error) }
  },
  'child.spawned': (facts) => ({ spawned_session_ids: facts.sheet('codex-child').measurements.relationship.spawnedChildSessionIds ?? null }),
  'claude.tasks': (facts) => {
    const sheet = facts.sheet('claude')
    return {
      task_calls: sheet.toolCallsByName.value?.Task ?? null,
      subagent_types: null,
      descriptions: sheet.subagents.value?.map((spawn) => spawn.taskName) ?? null,
    }
  },
  'claude.bash': (facts) => {
    const bash = tool(facts.sheet('claude'), 'Bash')
    return { bash_calls: bash?.calls ?? null, failed_bash_calls: bash?.outcomes.error ?? null, failed_in_subagents: null }
  },
  'claude.first-bash-error': (facts) => {
    const failure = facts.sheet('claude').firstFailure
    return { output: failure.status === 'found' && failure.name === 'tool.Bash' ? quote(failure.message, failure.spanId) : null }
  },
}

async function factsArm(options: ArmOptions, rows: readonly PromptRow[]): Promise<AnswerRow[]> {
  const facts = await readFacts(options)
  return rows.map((row) => ({
    question: row.question,
    variant: row.variant,
    answer: FACTS_ANSWERS[row.question]!(facts),
    model_calls: 0,
    cost_usd: 0,
    cost_basis: 'observed',
  }))
}

// ---------------------------------------------------------------------------
// The model arms
// ---------------------------------------------------------------------------

/** One question's wall-clock limit; the budget usually ends a run first. */
const QUESTION_TIMEOUT_MS = 600_000

/**
 * The traces arm's agent HOME: the skill where Claude Code reads a user's
 * installed skills, and nothing else of the machine's user settings. Its one
 * setting leaves Claude Code's bundled skills out of the Skill tool, so the
 * arms differ by traces and its skill, not by a listing of unrelated skills
 * every question would pay for. Claude Code reads its login from the macOS
 * login keychain under HOME (or `~/.claude/.credentials.json` elsewhere), so
 * that one entry is linked in.
 */
async function agentHome(dir: string, skills: string): Promise<string> {
  const home = join(dir, 'agent-home')
  await mkdir(join(home, '.claude', 'skills'), { recursive: true })
  await cp(join(skills, 'inspect-agent-traces'), join(home, '.claude', 'skills', 'inspect-agent-traces'), { recursive: true })
  await writeFile(join(home, '.claude', 'settings.json'), `${JSON.stringify({ disableBundledSkills: true }, null, 2)}\n`)
  if (process.platform === 'darwin') {
    await mkdir(join(home, 'Library'), { recursive: true })
    await symlink(join(homedir(), 'Library', 'Keychains'), join(home, 'Library', 'Keychains'))
  } else {
    const credentials = join(homedir(), '.claude', '.credentials.json')
    if (await access(credentials).then(() => true, () => false)) await symlink(credentials, join(home, '.claude', '.credentials.json'))
  }
  return home
}

/** Read by the traces arm only; the raw-files arm gets the same prompt with no tool named. */
const TRACES_NOTE = 'The traces CLI is on PATH. It reads Claude Code and Codex session files and answers questions about them, so you need not parse them yourself: run `traces --help`, then `traces <command> --help`.'

/** The first JSON object in a reply: the whole reply, or a fenced or embedded object. */
function answerFromReply(text: string): unknown {
  const candidates = [text.trim(), /```(?:json)?\s*([\s\S]*?)```/u.exec(text)?.[1]?.trim(), text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const value = JSON.parse(candidate) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      // Try the next form.
    }
  }
  return null
}

interface AgentResult {
  answer: unknown
  costUsd: number | null
  modelCalls: number
  toolCalls: number
  /** Skills the agent loaded, and the `traces` commands it ran, by subcommand (`--help` counted as `help`). */
  skills: string[]
  traces: string[]
  /** Tool calls that named a session store outside the question's copy, or searched from `/`. */
  outside: number
  error: string | null
}

interface StreamBlock { type?: string; text?: string; input?: unknown }

/**
 * `claude -p --output-format stream-json`: every assistant message, its tool
 * calls, and a result event per reply. The answer is the last JSON object an
 * assistant text holds: a background command that ends after the answer gets
 * a reply of its own, and that reply is not the answer. The cost is the last
 * result's, which counts the whole run.
 */
function parseClaudeStream(stdout: string, dir: string): AgentResult {
  const messages = new Set<string>()
  const texts: string[] = []
  let toolCalls = 0
  let outside = 0
  const skills: string[] = []
  const traces: string[] = []
  let result: { subtype?: string; total_cost_usd?: number; is_error?: boolean } | undefined
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let event: { type?: string; message?: { id?: string; content?: StreamBlock[] } } & Record<string, unknown>
    try {
      event = JSON.parse(line) as typeof event
    } catch {
      continue
    }
    if (event.type === 'assistant' && event.message?.id) {
      messages.add(event.message.id)
      for (const block of event.message.content ?? []) {
        if (block.type === 'text' && block.text) texts.push(block.text)
        if (block.type !== 'tool_use') continue
        toolCalls += 1
        const input = (block.input ?? {}) as { skill?: unknown; command?: unknown }
        if (typeof input.skill === 'string') skills.push(input.skill)
        if (typeof input.command === 'string') {
          for (const [, sub, rest] of input.command.matchAll(/(?:^|[;&|(\s])traces\s+(--help|-h|[a-z]+)([^;&|\n]*)/gu)) {
            traces.push(sub === '-h' || sub === '--help' ? 'help' : /(?:^|\s)(?:--help|-h)(?:\s|$)/u.test(rest!) ? `${sub}:help` : sub!)
          }
        }
        const named = JSON.stringify(block.input ?? '').replaceAll(dir, '<q>').replace(/<q>[^\s"'\\]*/gu, '<q>')
        if (/(?:^|[^\w<])\.(?:claude|codex)[\w-]*\/(?!projects\/[^"]*\/tool-results\/)|\bfind\s+\/(?:\s|\\")/u.test(named)) outside += 1
      }
    }
    if (event.type === 'result') result = event as typeof result
  }
  const answer = texts.reverse().map(answerFromReply).find((value) => value !== null) ?? null
  return {
    answer,
    costUsd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null,
    modelCalls: messages.size,
    toolCalls,
    skills,
    traces,
    outside,
    error: !result ? 'no result event' : result.is_error || result.subtype !== 'success' ? `claude ended with ${result.subtype ?? 'an error'}`
      : answer === null ? 'the reply held no JSON object' : null,
  }
}

async function agentAnswer(options: ArmOptions, row: PromptRow): Promise<{ answer: AnswerRow; outside: number }> {
  const dir = join(options.work, options.arm, `${row.question}#${row.variant}`)
  const tree = join(dir, 'tree')
  await cp(options.root, tree, { recursive: true })
  const bin = join(dir, 'bin')
  await mkdir(bin, { recursive: true })
  // A stub keeps any other `traces` on the machine's PATH out of the raw-files arm.
  const traces = options.arm === 'traces'
    ? `#!/bin/sh\nexec env ${Object.entries(await storeHome(tree, join(dir, 'traces'))).map(([key, value]) => `${key}='${value}'`).join(' ')} '${process.execPath}' '${options.cli}' "$@"\n`
    : '#!/bin/sh\necho "traces: command not found" >&2\nexit 127\n'
  await writeFile(join(bin, 'traces'), traces, { mode: 0o755 })
  const withTraces = options.arm === 'traces'
  const argv = [
    '-p', row.prompt,
    '--output-format', 'stream-json', '--verbose',
    '--model', options.model!,
    '--max-budget-usd', String(options.budgetUsd),
    '--no-session-persistence',
    // No machine user settings, hooks, plugins or MCP servers: the arms differ only by `traces` and its skill.
    // The traces arm's user settings are its own HOME's, which holds the skill alone.
    '--setting-sources', withTraces ? 'user,project' : 'project',
    '--strict-mcp-config',
    '--tools', withTraces ? 'Bash,Read,Grep,Glob,Skill' : 'Bash,Read,Grep,Glob',
    '--permission-mode', 'bypassPermissions',
    ...(withTraces ? ['--append-system-prompt', TRACES_NOTE] : []),
  ]
  if (withTraces && !options.skills) throw new Error('the traces arm needs the skills directory')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ...(withTraces ? { HOME: await agentHome(dir, options.skills!) } : {}) }
  const started = Date.now()
  const result = await run('claude', argv, { cwd: tree, env, timeoutMs: QUESTION_TIMEOUT_MS })
  await writeFile(join(dir, 'transcript.jsonl'), result.stdout)
  const parsed = parseClaudeStream(result.stdout, dir)
  const { answer, error } = parsed
  if (parsed.outside > 0) options.log?.(`${options.arm} ${row.question}#${row.variant}: ${parsed.outside} tool call(s) named a session store outside the fixture copy or searched from /; see ${join(dir, 'transcript.jsonl')}`)
  return { outside: parsed.outside, answer: {
    question: row.question,
    variant: row.variant,
    answer,
    wall_ms: Date.now() - started,
    model_calls: parsed.modelCalls,
    tool_calls: parsed.toolCalls,
    cost_usd: parsed.costUsd,
    cost_basis: parsed.costUsd === null ? null : 'observed',
    skills_loaded: parsed.skills,
    traces_commands: parsed.traces,
    ...(error ? { error: `${error}${result.code !== 0 ? ` (exit ${result.code}: ${result.stderr.trim().slice(0, 300)})` : ''}` } : {}),
  } }
}

async function pool<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index]!)
    }
  }))
  return results
}

/** Run one arm over the selected question wordings and return its answers file. */
export async function runArm(options: ArmOptions): Promise<AnswersFile> {
  const rows = promptRows(options.manifest).filter((row) =>
    (options.variants === 'all' || row.variant === 0) && (!options.questions || options.questions.includes(row.question)))
  if (rows.length === 0) throw new Error('no question wording selected')
  if (options.arm === 'facts') {
    return { arm: 'facts', notes: 'traces facts --format json over the 3 sessions, mapped by fixed rules; $0', answers: await factsArm(options, rows) }
  }
  return runModelArm(options, rows)
}

/**
 * The large-session arm (`large.ts`): the same three arms over one session of
 * about 50,000 spans. The facts arm reads `traces facts` over its file and one
 * `--match` search.
 */
export async function runLargeArm(options: ArmOptions): Promise<AnswersFile> {
  const rows = promptRows(options.manifest, LARGE_QUESTIONS)
  if (options.arm !== 'facts') return runModelArm(options, rows)
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NO_COLOR: '1', ...await storeHome(options.root, join(options.work, 'facts')) }
  const path = join(options.root, options.manifest.sessions[0]!.path)
  const facts = async (argv: readonly string[]): Promise<unknown> => {
    const result = await run(process.execPath, [options.cli, 'facts', path, ...argv, '--format', 'json'], { env, timeoutMs: 600_000 })
    if (result.code !== 0) throw new Error(`traces facts ${argv.join(' ')} exited ${result.code}: ${result.stderr.trim()}`)
    return JSON.parse(result.stdout) as unknown
  }
  const sheet = (await facts([]) as { sessions: Sheet[] }).sessions[0]!
  const tests = (await facts(['--match', '^pnpm test( |$)']) as { matches: Match[] }).matches.filter((match) => match.kind === 'command')
  const exec = execRows(sheet)
  const prs = sheet.pullRequests.value
  const numbers = (list: readonly PullRequest[] | undefined) => list?.filter((pr) => pr.number !== null).map((pr) => Number(pr.number)) ?? null
  const answers: Readonly<Record<string, Record<string, unknown>>> = {
    'large.commands': { exec_commands: sum(exec, (row) => row.calls), nonzero_exits: sum(exec, (row) => row.outcomes.error) },
    'large.pull-requests': { created: numbers(prs?.created), merged: numbers(prs?.merged) },
    'large.test-runs': { pnpm_test_runs: tests.length },
    'large.last-human-turn': { text: sheet.humanTurns.value?.at(-1)?.text ?? null },
  }
  return {
    arm: 'facts',
    notes: 'traces facts --format json over the large session, and one --match search; $0',
    answers: rows.map((row) => ({ question: row.question, variant: row.variant, answer: answers[row.question] ?? null, model_calls: 0, cost_usd: 0, cost_basis: 'observed' })),
  }
}

/** How an arm's agents used traces: answers that loaded the skill, ran a traces command, only read help, or never ran it. */
export function tracesUse(answers: readonly AnswerRow[]): { skill: number; commands: number; helpOnly: number; none: number } {
  const ran = (row: AnswerRow) => row.traces_commands ?? []
  const commands = answers.filter((row) => ran(row).some((command) => !command.endsWith('help'))).length
  const helpOnly = answers.filter((row) => ran(row).length > 0 && ran(row).every((command) => command.endsWith('help'))).length
  return {
    skill: answers.filter((row) => (row.skills_loaded ?? []).length > 0).length,
    commands,
    helpOnly,
    none: answers.filter((row) => ran(row).length === 0).length,
  }
}

/** Answer prompt rows with one model arm: one headless agent per row. */
export async function runModelArm(options: ArmOptions, rows: readonly PromptRow[]): Promise<AnswersFile> {
  if (!options.model || !(options.budgetUsd! > 0)) throw new Error(`the ${options.arm} arm needs --model and --budget-usd`)
  let outside = 0
  const answers = await pool(rows, options.concurrency ?? 4, async (row) => {
    const { answer, outside: count } = await agentAnswer(options, row)
    outside += count
    options.log?.(`${options.arm} ${row.question}#${row.variant}: ${answer.error ?? 'answered'}, $${answer.cost_usd?.toFixed(4) ?? '?'}, ${answer.tool_calls} tool calls`)
    return answer
  })
  const use = tracesUse(answers)
  const traces = options.arm === 'traces'
    ? `traces on PATH and its skill in the agent's HOME; skill loaded in ${use.skill}, traces commands run in ${use.commands}, only --help in ${use.helpOnly}, no traces in ${use.none} of ${answers.length}`
    : 'no traces on PATH'
  return {
    arm: options.arm,
    notes: `claude -p, model ${options.model}, $${options.budgetUsd} per question, tools Bash Read Grep Glob${options.arm === 'traces' ? ' Skill' : ''}, ${traces}; ${outside} tool call(s) named a session store outside the fixture copy or searched from /`,
    answers,
  }
}
