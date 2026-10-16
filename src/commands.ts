/**
 * The command table: one row per command drives parsing, help and dispatch.
 *
 * Every flag comes from one vocabulary ({@link FLAGS}), so a flag means the
 * same thing on every command that takes it, and a flag a command does not
 * take exits 2 naming the commands that do. `traces --help` and `traces
 * <command> --help` are rendered from these rows, so help cannot list a flag
 * the parser refuses or miss one it takes.
 *
 * A hidden row is a 0.x spelling whose replacement lands in a later step
 * (spec §2.4): it is parsed and run, and absent from help. When its
 * replacement works, the spelling leaves this table for `moved.ts`.
 *
 * Exit codes, on every command: 0 yes, 1 no, 2 could not answer. A usage
 * error, an unreadable or ambiguous input, a rule that could not decide, runs
 * with no recorded outcome, or any other failure exits 2; with `--format
 * json|jsonl` its error is one JSON object `{error, code}` on stderr, so a
 * caller still tells the reasons apart, and stdout stays empty.
 */

import { resolve } from 'node:path'
import { DEFAULT_ANALYST_MODEL } from './analyst-model-call.js'
import { MAX_TRACE_QUESTION_CHARS } from './ask.js'
import { findMoved, movedMessage, renderMovedTable, tracesCommand } from './moved.js'
import { RefError } from './refs.js'
import { knownHarnesses, resolveAdapter } from './registry.js'
import { parseTimeBound } from './time.js'
import { tracesCommit, tracesVersion } from './version.js'

/** Why a command could not answer (spec §2.1), the `code` of its JSON error. */
export type ErrorCode = 'usage' | 'unreadable' | 'ambiguous' | 'unknown-verdict' | 'no-outcome' | 'partial'

/** A command that could not answer: exit 2, with the reason as `code`. */
export class CliError extends Error {
  readonly code: ErrorCode

  constructor(message: string, code: ErrorCode) {
    super(message)
    this.name = 'CliError'
    this.code = code
  }
}

/** A command line the table refused: exit 2, `code: usage`. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 'usage')
    this.name = 'UsageError'
  }
}

/** A parsed command line. The table writes it; handlers read it. */
export interface Args {
  /** The command as the table names it (`bundle verify` for the subcommand). */
  command: string
  /** Positional arguments: refs (a session id, prefix or suffix, a file, a directory). */
  refs: string[]
  /** The first ref, for the commands that take one path. */
  input?: string
  harness: string
  /** True when `--harness` was given; otherwise every harness is read. */
  harnessExplicit: boolean
  last: number
  current: boolean
  latestTurn: boolean
  cwd?: string
  since?: string
  until?: string
  format?: string
  out?: string
  noContent: boolean
  /** `facts --match`: a regular expression over human turns, agent messages and shell commands. */
  match?: string
  questions: string[]
  questionsFile?: string
  budget?: number
  model?: string
  contract?: string
  once: boolean
  dryRun: boolean
  yes: boolean
  unused: boolean
  // Hidden spellings, kept until the step that moves each (spec §2.4).
  llm: boolean
  config?: string
  dir?: string
  questionBudget?: number
  /** Seconds. */
  questionTimeout?: number
  concurrency: number
  junit?: string
  annotations: boolean
  explain: boolean
  mode?: string
  replay: boolean
  noSpans: boolean
  noFindings: boolean
  /** Seconds. */
  interval: number
  /** True when `--interval` was given, so a command can keep its own default. */
  intervalExplicit: boolean
  /** Minutes. */
  window: number
  kinds: string[]
  noRefresh: boolean
  store?: string
  sweep?: number
  profile?: string
  knownSecretEnvs: string[]
}

function emptyArgs(command: string): Args {
  return {
    command,
    refs: [],
    harness: 'claude-code',
    harnessExplicit: false,
    last: 0,
    current: false,
    latestTurn: false,
    noContent: false,
    questions: [],
    once: false,
    dryRun: false,
    yes: false,
    unused: false,
    llm: false,
    concurrency: 4,
    annotations: false,
    explain: false,
    replay: false,
    noSpans: false,
    noFindings: false,
    interval: 5,
    intervalExplicit: false,
    window: 30,
    kinds: [],
    noRefresh: false,
    knownSecretEnvs: [],
  }
}

interface Flag {
  /** The value's name in help; absent for a switch. */
  readonly value?: string
  /** The help line, unless a command says it its own way. */
  readonly help: string
  /** The value is free text, which may itself start with `--` (a question). */
  readonly freeText?: true
  readonly set: (args: Args, value: string) => void
}

function positiveInteger(flag: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new UsageError(`${flag} must be a positive whole number, got "${raw}"`)
  return value
}

function positiveNumber(flag: string, raw: string, unit: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new UsageError(`${flag} must be a positive number of ${unit}`)
  return value
}

function timeBound(flag: string, raw: string): string {
  try {
    parseTimeBound(raw, flag)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  return raw
}

function harnessId(raw: string): string {
  if (!resolveAdapter(raw)) throw new UsageError(`unknown harness "${raw}"; known: ${knownHarnesses().join(', ')}`)
  return raw
}

/** Every flag any command takes, by its long name. */
const FLAGS: Readonly<Record<string, Flag>> = {
  '--current': { help: "the caller's own session: CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID", set: (a) => { a.current = true } },
  '--last': { value: 'N', help: "the N newest sessions by file mtime, never the caller's own", set: (a, v) => { a.last = positiveInteger('--last', v) } },
  '--since': { value: 'T', help: 'every session with a record since T: 30m, 2h, 7d or an ISO time', set: (a, v) => { a.since = timeBound('--since', v) } },
  '--until': { value: 'T', help: 'close the --since window (exclusive); same forms', set: (a, v) => { a.until = timeBound('--until', v) } },
  '--cwd': { value: 'DIR', help: 'sessions recorded in DIR or under it, or in a worktree of its repo', set: (a, v) => { a.cwd = resolve(v) } },
  '--harness': { value: 'ID', help: 'read only this harness; with a file ref, force its reader', set: (a, v) => { a.harness = harnessId(v); a.harnessExplicit = true } },
  '--latest-turn': { help: 'only the latest task turn of a resumed Codex or Claude Code session', set: (a) => { a.latestTurn = true } },
  '--format': { value: 'F', help: 'the output format', set: (a, v) => { a.format = v } },
  '--out': { value: 'PATH', help: 'write the output to PATH; stdout gets one summary line', set: (a, v) => { a.out = v } },
  '--no-content': { help: 'omit conversation, commands, paths and assignments', set: (a) => { a.noContent = true } },
  '--match': {
    value: 'RE',
    help: 'one row per human turn, agent message or shell command matching RE',
    freeText: true,
    set: (a, v) => {
      try {
        new RegExp(v)
      } catch (error) {
        throw new UsageError(`--match is not a regular expression: ${error instanceof Error ? error.message : String(error)}`)
      }
      a.match = v
    },
  },
  '--question': { value: 'TEXT', help: `a question (repeatable, at most ${MAX_TRACE_QUESTION_CHARS} characters)`, freeText: true, set: (a, v) => { a.questions.push(v) } },
  '--questions': { value: 'FILE', help: 'a JSON array of questions: strings or {id?, question, answerSchema?}', set: (a, v) => { a.questionsFile = v } },
  '--budget': { value: 'USD', help: 'one spending ceiling shared by every question', set: (a, v) => { a.budget = positiveNumber('--budget', v, 'USD') } },
  '--model': { value: 'ID', help: `the analyst model (default ${DEFAULT_ANALYST_MODEL})`, set: (a, v) => { a.model = v } },
  '--contract': { value: 'FILE', help: 'the trace contract to gate on (required)', set: (a, v) => { a.contract = v } },
  '--once': { help: 'print one snapshot and exit', set: (a) => { a.once = true; a.replay = true } },
  '--dry-run': { help: 'redact and preview; send nothing', set: (a) => { a.dryRun = true } },
  '--yes': { help: 'skip the confirmation prompt', set: (a) => { a.yes = true } },
  '--unused': { help: 'only installed skills with no use in the window', set: (a) => { a.unused = true } },
  '--llm': { help: 'add the agentic analysts (Python bridge, model spend)', set: (a) => { a.llm = true } },
  '--config': { value: 'FILE', help: 'a JS config with analysts or liveAnalysts', set: (a, v) => { a.config = v } },
  '--dir': { value: 'DIR', help: 'write the artifacts to DIR', set: (a, v) => { a.dir = v } },
  '--question-budget': { value: 'USD', help: 'the provider ceiling for one question', set: (a, v) => { a.questionBudget = positiveNumber('--question-budget', v, 'USD') } },
  '--question-timeout': {
    value: 'S',
    help: "one question's deadline in seconds",
    set: (a, v) => {
      const ms = Math.round(Number(v) * 1000)
      if (!Number.isSafeInteger(ms) || ms < 1000) throw new UsageError('--question-timeout must be a number of seconds, at least 1')
      a.questionTimeout = Number(v)
    },
  },
  '--concurrency': { value: 'N', help: 'questions running at once (default 4)', set: (a, v) => { a.concurrency = positiveInteger('--concurrency', v) } },
  '--junit': { value: 'FILE', help: 'write JUnit XML to FILE', set: (a, v) => { a.junit = v } },
  '--annotations': { help: 'print GitHub workflow annotations', set: (a) => { a.annotations = true } },
  '--explain': { help: 'print what the contract checks and read no trace', set: (a) => { a.explain = true } },
  '--mode': { value: 'MODE', help: 'visualizer, findings or agent', set: (a, v) => { a.mode = v } },
  '--replay': { help: 'scan once and exit', set: (a) => { a.replay = true } },
  '--no-spans': { help: 'omit per-span events', set: (a) => { a.noSpans = true } },
  '--no-findings': { help: 'omit live-finding events', set: (a) => { a.noFindings = true } },
  '--interval': { value: 'S', help: 'poll every S seconds', set: (a, v) => { a.interval = positiveNumber('--interval', v, 'seconds'); a.intervalExplicit = true } },
  '--window': { value: 'M', help: 'sessions active in the last M minutes (default 30)', set: (a, v) => { a.window = positiveNumber('--window', v, 'minutes') } },
  '--kind': { value: 'KIND', help: 'keep only steps of this span kind (repeatable)', set: (a, v) => { a.kinds.push(v) } },
  '--no-refresh': { help: 'answer from the store without reading transcripts', set: (a) => { a.noRefresh = true } },
  '--store': { value: 'PATH', help: 'the skill-use store', set: (a, v) => { a.store = v } },
  '--sweep': { value: 'N', help: 'a command reading N or more skills is a catalog sweep, not use', set: (a, v) => { a.sweep = positiveInteger('--sweep', v) } },
  '--profile': { value: 'P', help: 'default, share or strict', set: (a, v) => { a.profile = v } },
  '--known-secret-env': { value: 'NAME', help: 'a variable holding a secret to look for (repeatable)', set: (a, v) => { a.knownSecretEnvs.push(v) } },
}

const ALIASES: Readonly<Record<string, string>> = { '-y': '--yes' }

/** A flag a command takes: its name, optionally with the command's own help line, or hidden until its step. */
type FlagUse = string | { readonly flag: string; readonly value?: string; readonly help?: string; readonly hidden?: true }

interface CommandSpec {
  readonly name: string
  /** What follows `traces ` on the usage line. */
  readonly usage: string
  /** The command's one job, in one sentence. */
  readonly job: string
  /** At most two lines more, printed under the job. */
  readonly notes?: readonly string[]
  readonly flags: readonly FlagUse[]
  /** `--format` values, the default first. */
  readonly formats?: readonly string[]
  /** How many positional refs it takes: [min, max]. */
  readonly refs: readonly [number, number]
  /** `required`: a ref or a selector flag. A reading command never guesses its session. */
  readonly select?: 'required'
  readonly jq?: ReadonlyArray<readonly [path: string, what: string]>
  readonly examples: readonly string[]
  /** A 0.x command kept until its step: parsed and run, absent from `traces --help`. */
  readonly hidden?: true
  /** Its row in `traces --help`: the question it answers and how to ask it. */
  readonly overview?: readonly [question: string, example: string]
}

const SELECT = ['--current', '--last', '--since', '--cwd', '--harness', '--latest-turn'] as const
const hidden = (flag: string): FlagUse => ({ flag, hidden: true })
const MANY = Number.POSITIVE_INFINITY

const COMMANDS = [
  {
    name: 'list',
    usage: 'list [<store-root>] [--last N | --since T] [--cwd DIR] [--harness ID] [--format text|json]',
    job: "Find a session: one row per session, newest first, across every harness, never the caller's own.",
    flags: [
      { flag: '--last', help: 'the N newest sessions (default 20)' }, '--since', '--cwd',
      { flag: '--harness', help: "only this harness's sessions" },
      { flag: '--format', help: 'text (default), or json with id, path, bytes and parent id' },
    ],
    formats: ['text', 'json'],
    refs: [0, 1],
    jq: [
      ['.sessions[].ref', 'the short ref any command takes'],
      ['.sessions[] | {id, cwd, firstPrompt}', 'which session is which'],
      ['.selection.unreadSessions', 'sessions that could not be read, and why'],
    ],
    examples: ['traces list --cwd . --last 5', 'traces list --since 1d --harness codex', "traces list --format json | jq -r '.sessions[0].id'"],
    overview: ['Which sessions ran?', 'traces list [--cwd .] [--last N]'],
  },
  {
    name: 'facts',
    usage: 'facts <ref…> | --current | --last N | --since T [flags]',
    job: 'What happened, exactly, for $0: who acted, tools, subagents, human turns, PRs, first failure.',
    flags: [
      ...SELECT.slice(0, 3), '--until', ...SELECT.slice(3), '--match', '--no-content',
      { flag: '--format', help: 'json (default), text, or jsonl: one row per typed turn' },
      { flag: '--out', help: 'write the sheet to PATH; stdout gets one summary line' },
    ],
    formats: ['json', 'text', 'jsonl'],
    refs: [0, MANY],
    select: 'required',
    jq: [
      ['.sessions[0].humanTurns.value[] | {text, reply, signals}', 'each ask, its reply, correction signals'],
      ['.sessions[0].agent.value', 'who acted: profile, model, directive'],
      ['.sessions[0].firstFailure', 'the first failure and its blame'],
      ['.matches[] | {sessionId, kind, text}', 'with --match: each hit'],
    ],
    examples: ['traces facts --current', 'traces facts 019a3c7e --format jsonl', "traces facts --since 30d --match '^gh pr merge'"],
    overview: ['What happened (turns, PRs, failure)? $0', 'traces facts <ref> | --current | --since 1d'],
  },
  {
    name: 'analyze',
    usage: 'analyze <ref…> | --current | --last N | --since T [flags]',
    job: 'What went wrong, ranked, for $0: loops, failures, waste, and what the trace cannot answer.',
    notes: ['A Runtime run directory as the ref reports its supervision tree.'],
    flags: [...SELECT, { flag: '--out', help: 'write the report to PATH; stdout gets one summary line' }, hidden('--llm'), hidden('--model'), hidden('--budget'), hidden('--config')],
    refs: [0, MANY],
    select: 'required',
    examples: ['traces analyze --current', 'traces analyze 019a3c7e --out report.md', 'traces analyze runs/my-run'],
    overview: ['Where did it waste time or get interrupted? $0', 'traces analyze <ref>'],
  },
  {
    name: 'ask',
    usage: 'ask <ref…> | --current | --last N | --since T --question TEXT [flags]',
    job: 'A question facts cannot answer, with checked trace:// citations: the only command that calls a model.',
    notes: ['Needs TANGLE_API_KEY and Python with agent-eval-rpc[dspy] (TRACES_PYTHON names it).'],
    flags: [
      ...SELECT, '--question', '--questions', '--budget', '--model',
      hidden('--dir'), hidden('--question-budget'), hidden('--question-timeout'), hidden('--concurrency'),
    ],
    refs: [0, MANY],
    select: 'required',
    examples: [
      'traces ask --current --question "Which command failed first?" --budget 1',
      'traces ask 019a3c7e --questions questions.json --budget 5',
      'traces ask --last 3 --question "Did it verify the fix?" --budget 2',
    ],
    overview: ["A question facts can't answer (model, $)", 'traces ask <ref> --question "…" --budget 1'],
  },
  {
    name: 'check',
    usage: 'check <ref…> | --current | --last N | --since T --contract FILE [flags]',
    job: 'The gate: does this run satisfy a trace contract?',
    notes: ['Exit 0 pass, 1 fail, 2 could not decide: a bad contract, a rule that could not run, or an unreadable or ambiguous trace.'],
    flags: [
      '--contract', ...SELECT.slice(0, 4), { flag: '--harness', help: 'force the reader of a file ref (claude-code, codex, …)' },
      { flag: '--format', help: 'text (default) or json, the full report' },
      { flag: '--out', value: 'DIR', help: 'write evidence for each trace that did not pass under DIR' },
      hidden('--junit'), hidden('--annotations'), hidden('--explain'),
    ],
    formats: ['text', 'json'],
    refs: [0, MANY],
    select: 'required',
    examples: [
      'traces check spans.otlp.jsonl --contract contract.json',
      'traces check --current --contract contract.json',
      'traces check run.jsonl --harness claude-code --contract c.json --out evidence',
    ],
    overview: ['Does this run pass? (CI)', 'traces check <ref> --contract c.json'],
  },
  {
    name: 'diff',
    usage: 'diff <a> <b> [--format text|json]',
    job: 'Where two runs of one task first split.',
    notes: [
      'Each side is an OTLP file or dir, any file convert reads, file#<trace id> or file#branch=<id>.',
      'Exit 0 agree, 1 diverge, 2 could not compare: a side cannot be read, or neither records an outcome.',
    ],
    flags: [{ flag: '--format', help: 'text (default) or json' }, hidden('--kind')],
    formats: ['text', 'json'],
    refs: [2, 2],
    jq: [
      ['.diff.firstDivergence', 'the first step where the runs differ'],
      ['.caveat', 'why agreement could not be called'],
    ],
    examples: [
      'traces diff passing.otlp.jsonl failing.otlp.jsonl',
      'traces diff runs.otlp.jsonl#branch=a runs.otlp.jsonl#branch=b',
      'traces diff a.jsonl b.jsonl --format json | jq .diff.firstDivergence',
    ],
    overview: ['Where did two runs diverge?', 'traces diff <a> <b>'],
  },
  {
    name: 'watch',
    usage: 'watch [--harness ID] [--cwd DIR]  |  watch <run-dir|spans.otlp.jsonl> [--once]',
    job: 'Live supervision: findings in every session active in the last 30 minutes, or one run tree.',
    notes: ['A run tree stops when its result lands, and exits 1 when the run ended with an error.'],
    flags: [
      { flag: '--once', help: 'with a run dir or span file: print one snapshot and exit' },
      { flag: '--harness', help: "only this harness's sessions" }, '--cwd', hidden('--window'), hidden('--interval'),
    ],
    refs: [0, 1],
    examples: ['traces watch', 'traces watch runs/my-run --once', 'traces watch --harness codex --cwd .'],
    overview: ['What is happening right now?', 'traces watch [<run-dir> --once]'],
  },
  {
    name: 'bundle',
    usage: 'bundle <ref> | --current --out DIR      (then: traces bundle verify DIR)',
    job: "Keep one session's evidence beyond log rotation: session/, spans, facts, git log, sha256 manifest.",
    notes: ['A bundle directory is a ref: traces facts DIR reads it.'],
    flags: ['--current', { flag: '--harness', help: 'force the reader of a file ref' }, { flag: '--out', value: 'DIR', help: 'a new or empty directory for the bundle' }],
    refs: [0, 1],
    select: 'required',
    examples: ['traces bundle 019a3c7e --out evidence/019a3c7e', 'traces bundle --current --out evidence/now', 'traces bundle verify evidence/019a3c7e'],
    overview: ["Keep a session's evidence", 'traces bundle <ref> --out <dir> · bundle verify <dir>'],
  },
  {
    name: 'bundle verify',
    usage: 'bundle verify <dir> [--format text|json]',
    job: 'Check a bundle against its manifest: every listed file with its size and SHA-256, nothing unlisted.',
    notes: ['Exit 0 verified, 1 any difference.'],
    flags: [{ flag: '--format', help: 'text (default) or json' }],
    formats: ['text', 'json'],
    refs: [1, 1],
    jq: [
      ['.ok', 'true when every file matches'],
      ['.issues[] | {kind, path, detail}', 'each difference'],
    ],
    examples: ['traces bundle verify evidence/019a3c7e', 'traces bundle verify evidence/019a3c7e --format json | jq .issues'],
  },
  {
    name: 'convert',
    usage: 'convert <ref…> | --current | --last N | --since T [--out FILE]',
    job: 'Hand spans to another tool: contract OTLP-JSONL, to --out or stdout.',
    notes: ['Sandbox events, Codex live streams and OpenInference files are sniffed; --harness forces a reader.'],
    flags: [...SELECT, { flag: '--out', help: 'write the spans to PATH; stdout gets one summary line' }],
    refs: [0, MANY],
    select: 'required',
    examples: [
      'traces convert --current --out spans.otlp.jsonl',
      'traces convert sandbox-events.json --out spans.otlp.jsonl',
      'traces convert live-stream.jsonl --harness codex-exec > spans.otlp.jsonl',
    ],
    overview: ['Hand spans to another tool', 'traces convert <ref> --out <file>'],
  },
  {
    name: 'upload',
    usage: 'upload <ref…> | --current | --since T [--dry-run] [--no-content] [--yes]',
    job: 'Send redacted sessions to Tangle Intelligence; one still UNSAFE or UNKNOWN once redacted is refused (exit 1).',
    notes: ['Env: TANGLE_INGEST_URL, TANGLE_INGEST_API_KEY (or TANGLE_API_KEY), TANGLE_TENANT_ID.'],
    flags: [
      '--current', '--since', '--cwd', '--harness', '--dry-run',
      { flag: '--no-content', help: 'strip prompt and response text; send metadata only' },
      '--yes',
      { flag: '--out', help: 'with --dry-run: write the redacted OTLP preview to PATH' },
    ],
    refs: [0, MANY],
    examples: ['traces upload --since 24h --dry-run', 'traces upload 019a3c7e --yes', 'traces upload spans.otlp.jsonl --dry-run --out preview.otlp.jsonl'],
    overview: ['Ship sessions to Intelligence', 'traces upload <ref>|--since T [--dry-run]'],
  },
  {
    name: 'skills',
    usage: 'skills [--since T] [--unused] [--format text|json]',
    job: 'Which skills are used, and which installed skills never are; no model call.',
    notes: ['Reads Claude Code, Codex and Kimi Code sessions; each run reads only bytes appended since the last.'],
    flags: [
      { flag: '--since', help: 'count use since T: 30m, 2h, 7d or an ISO time (default: all stored)' },
      '--unused', { flag: '--format', help: 'text (default) or json' },
      hidden('--no-refresh'), hidden('--store'), hidden('--sweep'),
    ],
    formats: ['text', 'json'],
    refs: [0, 0],
    jq: [
      ['.rows[] | {skill, sessions}', 'use per skill'],
      ['.unused[].skill', 'installed skills never used in the window'],
    ],
    examples: ['traces skills --since 30d', 'traces skills --unused', "traces skills --format json | jq '.rows[] | {skill, sessions}'"],
    overview: ['Which skills are used?', 'traces skills [--unused]'],
  },
  {
    name: 'mcp',
    usage: 'mcp <ref…> | --current | --last N | --since T',
    job: "Serve agent-eval's read-only span tools over stdio, for an MCP client with no shell.",
    notes: [
      'Spans and results are redacted, and it refuses to start if redacted spans are UNSAFE or UNKNOWN.',
      'Each result carries an untrusted-text notice and is capped at 512 KiB.',
    ],
    flags: SELECT.slice(0, 5),
    refs: [0, MANY],
    select: 'required',
    examples: ['traces mcp spans.otlp.jsonl', 'traces mcp --last 5', 'claude mcp add traces -- traces mcp spans.otlp.jsonl'],
    overview: ['Serve span tools over MCP', 'traces mcp <ref>|--last N'],
  },
  // Hidden until their step (spec §2.4): validate and verify-safe (15), stream (14), improve (13).
  {
    name: 'validate',
    usage: 'validate <file|dir> [--out FILE]',
    job: 'What a trace can and cannot answer. Exit 1 on an error finding.',
    flags: ['--out'],
    refs: [1, 1],
    examples: ['traces validate spans.otlp.jsonl'],
    hidden: true,
  },
  {
    name: 'verify-safe',
    usage: 'verify-safe <file|dir> [--profile P] [--known-secret-env NAME]… [--format text|json]',
    job: 'Whether files are safe to share. Exit 0 SAFE or SAFE_WITH_WARNINGS, 1 UNSAFE, 2 UNKNOWN.',
    flags: ['--profile', '--known-secret-env', { flag: '--format', help: 'text (default) or json' }],
    formats: ['text', 'json'],
    refs: [1, 1],
    examples: ['traces verify-safe handoff.md'],
    hidden: true,
  },
  {
    name: 'stream',
    usage: 'stream [<ref>] [flags]',
    job: 'Live trace events as JSONL.',
    flags: ['--current', '--last', '--cwd', '--harness', '--config', '--mode', '--replay', '--once', '--no-spans', '--no-findings', '--window', '--interval'],
    refs: [0, 1],
    examples: ['traces stream --mode findings'],
    hidden: true,
  },
  {
    name: 'improve',
    usage: 'improve <ref…> | --current | --last N | --since T --dir DIR',
    job: 'Write findings, evidence, a report and spans to a directory.',
    flags: [...SELECT, '--dir', '--out', '--llm', '--model', '--budget', '--config'],
    refs: [0, MANY],
    select: 'required',
    examples: ['traces improve --current --dir .traces/improvement'],
    hidden: true,
  },
] as const satisfies readonly CommandSpec[]

/** A command's name, as the table and the handler map spell it. */
export type CommandName = (typeof COMMANDS)[number]['name']

export type Handler = (args: Args) => Promise<void>

type Use = Exclude<FlagUse, string>

function usesOf(spec: CommandSpec): Use[] {
  return spec.flags.map((use) => (typeof use === 'string' ? { flag: use } : use))
}

const SPECS: readonly CommandSpec[] = COMMANDS

/** The command `argv` names: `bundle verify` before `bundle`. */
function commandAt(argv: readonly string[]): CommandSpec | undefined {
  if (argv[0] === 'bundle' && argv[1] === 'verify') return SPECS.find((spec) => spec.name === 'bundle verify')
  return SPECS.find((spec) => spec.name === argv[0])
}

/** The commands that take `flag`: the ones that show it, else the ones that hide it. */
function appliesTo(flag: string): string[] {
  const shown = SPECS.filter((spec) => !spec.hidden && usesOf(spec).some((use) => use.flag === flag && !use.hidden))
  const any = shown.length > 0 ? shown : SPECS.filter((spec) => usesOf(spec).some((use) => use.flag === flag))
  return any.map((spec) => spec.name)
}

function formatHelp(formats: readonly string[]): string {
  return `${formats[0]} (default) or ${formats.slice(1).join(' or ')}`
}

const OVERVIEW_COLUMN = 49

/** `traces --help`: one row per question, from the table. At most 40 lines. */
export function renderGlobalHelp(): string {
  const rows = SPECS.flatMap((spec) =>
    spec.overview && !spec.hidden ? [`  ${spec.overview[0].padEnd(OVERVIEW_COLUMN - 1)} ${spec.overview[1]}`] : [])
  const formats = [...new Set(SPECS.filter((spec) => !spec.hidden).flatMap((spec) => spec.formats ?? []))]
  return [
    'traces: what your agents did, where they wasted time, whether a run passes',
    '',
    ...rows,
    '',
    'ref: session id, or 8+ char unique prefix or suffix; session file; OTLP file/dir; bundle dir; run dir; store root',
    'Select: --current  --last N  --since/--until 2h|1d|ISO  --cwd DIR  --harness ID  --latest-turn',
    `Output: --format ${formats.join('|')}  --out PATH  --no-content`,
    'Exit: 0 yes · 1 no (fail, diverged, unsafe) · 2 could not answer (stderr says why)',
    'traces <command> --help for flags, jq paths and examples · moved from 0.x: traces help moved',
    '',
  ].join('\n')
}

const FLAG_COLUMN = 20

/** `traces <command> --help`: usage, the job, its flags, jq paths and examples. At most 25 lines. */
export function renderCommandHelp(spec: CommandSpec): string {
  const flagLines = usesOf(spec).filter((use) => !use.hidden).map((use) => {
    const flag = FLAGS[use.flag]!
    const value = use.flag === '--format' && spec.formats ? spec.formats.join('|') : use.value ?? flag.value
    const left = value ? `${use.flag} ${value}` : use.flag
    const help = use.help ?? (use.flag === '--format' && spec.formats ? formatHelp(spec.formats) : flag.help)
    return `  ${left.padEnd(FLAG_COLUMN - 1)} ${help}`
  })
  const lines = [`Usage: traces ${spec.usage}`, spec.job, ...(spec.notes ?? [])]
  if (flagLines.length > 0) lines.push('', ...flagLines)
  if (spec.jq && spec.jq.length > 0) {
    const width = Math.max(...spec.jq.map(([path]) => path.length))
    lines.push('', 'jq paths (--format json):', ...spec.jq.map(([path, what]) => `  ${path.padEnd(width)}  ${what}`))
  }
  lines.push('', 'Examples:', ...spec.examples.map((example) => `  ${example}`))
  return `${lines.join('\n')}\n`
}

/** What a command line asks for: text to print (help, version), or a command to run. */
export type Parsed =
  | { readonly kind: 'print'; readonly text: string }
  | { readonly kind: 'run'; readonly args: Args }

function unknownCommand(word: string): UsageError {
  return new UsageError(word.startsWith('-')
    ? `${word} needs a command before it: traces <command> ${word} …; traces --help lists the commands`
    : `unknown command ${word}; traces --help lists the commands`)
}

/** Parse `argv` (the arguments after `traces`) against the table. Throws {@link UsageError}. */
export function parseCommandLine(argv: readonly string[]): Parsed {
  const [first, second] = argv
  if (first === undefined || first === '--help' || first === '-h') return { kind: 'print', text: renderGlobalHelp() }
  if (first === '--version' || first === '-v' || first === 'version') {
    return { kind: 'print', text: `traces ${tracesVersion()} (${tracesCommit()})\n` }
  }
  if (first === 'help') {
    if (second === undefined) return { kind: 'print', text: renderGlobalHelp() }
    if (second === 'moved') return { kind: 'print', text: renderMovedTable() }
    const spec = commandAt(argv.slice(1))
    if (!spec) throw unknownCommand(second)
    return { kind: 'print', text: renderCommandHelp(spec) }
  }
  const spec = commandAt(argv)
  if (!spec) throw unknownCommand(first)
  const rest = argv.slice(spec.name.split(' ').length)
  try {
    const args = parseFlags(spec, rest)
    if (args === 'help') return { kind: 'print', text: renderCommandHelp(spec) }
    checkArgs(spec, args, argv)
    return { kind: 'run', args }
  } catch (error) {
    // `--help` anywhere wins over a mistake elsewhere on the line.
    if (error instanceof UsageError && (rest.includes('--help') || rest.includes('-h'))) {
      return { kind: 'print', text: renderCommandHelp(spec) }
    }
    throw error
  }
}

function parseFlags(spec: CommandSpec, rest: readonly string[]): Args | 'help' {
  const args = emptyArgs(spec.name)
  const allowed = new Set(usesOf(spec).map((use) => use.flag))
  let help = false
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!
    if (word === '--help' || word === '-h') {
      help = true
      continue
    }
    if (!word.startsWith('-') || word === '-') {
      args.refs.push(word)
      continue
    }
    const name = ALIASES[word] ?? word
    const flag = FLAGS[name]
    if (!flag) throw new UsageError(`unknown flag ${word} for ${spec.name}; traces ${spec.name} --help lists its flags`)
    if (!allowed.has(name)) throw new UsageError(`${name} does not apply to ${spec.name}; it applies to: ${appliesTo(name).join(', ')}`)
    if (flag.value === undefined) {
      flag.set(args, '')
      continue
    }
    const value = rest[i + 1]
    if (value === undefined || (!flag.freeText && value.startsWith('--'))) {
      throw new UsageError(`${name} needs a value: ${name} ${flag.value}`)
    }
    i++
    flag.set(args, value)
  }
  if (help) return 'help'
  args.input = args.refs[0]
  return args
}

function checkArgs(spec: CommandSpec, args: Args, argv: readonly string[]): void {
  const [min, max] = spec.refs
  if (args.refs.length > max) {
    throw new UsageError(max === 0
      ? `${spec.name} takes no ref, got ${args.refs[0]}: traces ${spec.usage}`
      : `unexpected argument ${args.refs[max]}: traces ${spec.usage}`)
  }
  if (args.refs.length < min) throw new UsageError(`${spec.name} needs ${min === 1 ? 'one ref' : `${min} refs`}: traces ${spec.usage}`)
  if (args.format !== undefined && spec.formats && !spec.formats.includes(args.format)) {
    throw new UsageError(`unknown ${spec.name} format "${args.format}" (expected ${spec.formats.join(' or ')})`)
  }
  const selected = args.refs.length > 0 || args.current || args.last > 0 || args.since !== undefined
  if (spec.name === 'upload' && !selected) {
    throw new UsageError(`upload with no selection was removed in traces 1.0. Instead: ${tracesCommand([...argv, '--since', '24h'])}`)
  }
  if (spec.select === 'required' && !selected && !args.explain) {
    const flags = new Set(usesOf(spec).map((use) => use.flag))
    const ways = ['a ref', ...['--current', '--last N', '--since T'].filter((way) => flags.has(way.split(' ')[0]!))]
    const choice = ways.length === 1 ? ways[0] : `${ways.slice(0, -1).join(', ')} or ${ways.at(-1)}`
    throw new UsageError(
      `${spec.name} needs ${choice}` +
        `${flags.has('--cwd') ? '; --cwd and --harness only narrow' : ''}. traces list finds a session`,
    )
  }
}

/** `--format json|jsonl` on the command line: an error is then one JSON object on stderr. */
function wantsJsonErrors(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    if (FLAGS[argv[i]!]?.freeText) {
      i++
      continue
    }
    if (argv[i] === '--format' && (argv[i + 1] === 'json' || argv[i + 1] === 'jsonl')) return true
  }
  return false
}

/** One error line on stderr: text, or one JSON object `{error, code}` when the caller asked for JSON. */
export function writeError(message: string, code: ErrorCode, json: boolean, extra: Record<string, unknown> = {}): void {
  process.stderr.write(json ? `${JSON.stringify({ error: message, code, ...extra })}\n` : `error: ${message}\n`)
}

/** An error that ended a command: exit 2, with its reason as `code`. */
function reportError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof RefError || error instanceof CliError ? error.code : 'unreadable'
  const candidates = error instanceof RefError && error.candidates.length > 0 ? { candidates: error.candidates } : {}
  writeError(message, code, json, candidates)
  process.exitCode = 2
}

/**
 * Run one command line: refuse a moved spelling with its replacement, print
 * help or the version, or run the command's handler. Never throws: an error
 * is reported on stderr and exits 2.
 */
export async function runTraces(argv: readonly string[], handlers: Readonly<Record<CommandName, Handler>>): Promise<void> {
  try {
    const moved = findMoved(argv)
    if (moved) throw new UsageError(movedMessage(moved, argv))
    const parsed = parseCommandLine(argv)
    if (parsed.kind === 'print') {
      process.stdout.write(parsed.text)
      return
    }
    await handlers[parsed.args.command as CommandName](parsed.args)
  } catch (error) {
    reportError(error, wantsJsonErrors(argv))
  }
}
