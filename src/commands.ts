/**
 * The command table: one row per command drives parsing, help and dispatch.
 *
 * Every flag comes from one vocabulary ({@link FLAGS}), so a flag means the
 * same thing on every command that takes it, and a flag a command does not
 * take exits 2 naming the commands that do. `traces --help` and `traces
 * <command> --help` are rendered from these rows, so help cannot list a flag
 * the parser refuses or miss one it takes.
 *
 * A 0.x spelling is not in this table: `moved.ts` refuses it with its
 * replacement before anything here runs.
 *
 * Exit codes, on every command: 0 yes, 1 no, 2 could not answer. A usage
 * error, an unreadable or ambiguous input, a rule that could not decide, runs
 * with no recorded outcome, or any other failure exits 2; with `--format
 * json|jsonl` its error is one JSON object `{error, code}` on stderr, so a
 * caller still tells the reasons apart, and stdout stays empty.
 */

import { resolve } from 'node:path'
import {
  DEFAULT_ANALYST_MODEL,
  DEFAULT_ASK_CONCURRENCY,
  DEFAULT_QUESTION_MAX_COST_USD,
  DEFAULT_QUESTION_TIMEOUT_MS,
  MAX_TRACE_QUESTION_CHARS,
} from './ask-defaults.js'
import { findMoved, movedMessage, renderMovedTable, tracesCommand } from './moved.js'
import { RefError } from './refs.js'
import { knownHarnesses, resolveAdapter } from './registry.js'
import { parseTimeBound } from './time.js'
import { tracesCommit, tracesVersion } from './version.js'

/**
 * Why a command could not answer (spec §2.1), the `code` of its JSON error.
 * `ask` adds three that a caller fixes before it runs again: `setup` (no model
 * key or no Python bridge; nothing was spent), `auth` (the model endpoint
 * refused the key) and `model` (the endpoint cannot serve or price the model).
 */
export type ErrorCode =
  | 'usage'
  | 'unreadable'
  | 'ambiguous'
  | 'unknown-verdict'
  | 'no-outcome'
  | 'partial'
  | 'setup'
  | 'auth'
  | 'model'

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
  fleetRun?: string
  discoveryIndex?: string
  registry?: string
  runtimeModule?: string
  taskType?: string
  shape?: string
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
  /** `check --contract`: contract files, or `conformance`, in the order given. */
  contracts: string[]
  /** `check --share-safe`: read each ref as bytes and give its share verdict. */
  shareSafe: boolean
  once: boolean
  dryRun: boolean
  yes: boolean
  unused: boolean
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
    contracts: [],
    shareSafe: false,
    once: false,
    dryRun: false,
    yes: false,
    unused: false,
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
  '--fleet-run': { value: 'ID', help: 'bind one named native session to this exact Fleet run ID', set: (a, v) => { a.fleetRun = v } },
  '--discovery-index': { value: 'PATH', help: 'ingest the Discovery run catalog through its existing run reader', set: (a, v) => { a.discoveryIndex = resolve(v) } },
  '--registry': { value: 'DIR', help: 'query an existing Runtime graph registry', set: (a, v) => { a.registry = resolve(v) } },
  '--runtime-module': { value: 'MODULE', help: 'Runtime public module path or URL (default installed kernel)', set: (a, v) => { a.runtimeModule = v } },
  '--task-type': { value: 'TYPE', help: 'explicit feature, bugfix, consolidation, investigation or ops', set: (a, v) => {
    if (!['feature', 'bugfix', 'consolidation', 'investigation', 'ops'].includes(v)) throw new UsageError(`unknown task type ${v}`)
    a.taskType = v
  } },
  '--shape': { value: 'DIGEST', help: 'filter an exact topology digest', set: (a, v) => { a.shape = v } },
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
    help: 'one row per human turn, agent message or shell command matching RE (a command: ok, failed or ?)',
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
  '--budget': { value: 'USD', help: 'required: the most the run may spend, shared by every question', set: (a, v) => { a.budget = positiveNumber('--budget', v, 'USD') } },
  '--model': { value: 'ID', help: `the analyst model (default ${DEFAULT_ANALYST_MODEL})`, set: (a, v) => { a.model = v } },
  '--contract': { value: 'FILE|conformance', help: 'gate on a trace contract file, or on conformance (repeatable)', set: (a, v) => { a.contracts.push(v) } },
  '--share-safe': {
    help: 'gate on whether each path is safe to share, read as bytes: SAFE passes, UNSAFE fails, UNKNOWN cannot decide',
    set: (a) => { a.shareSafe = true },
  },
  '--once': { help: 'one pass, then exit', set: (a) => { a.once = true } },
  '--dry-run': { help: 'redact and preview; send nothing', set: (a) => { a.dryRun = true } },
  '--yes': { help: 'skip the confirmation prompt', set: (a) => { a.yes = true } },
  '--unused': { help: 'only installed skills with no use in the window', set: (a) => { a.unused = true } },
  '--known-secret-env': {
    value: 'NAME',
    help: 'with --share-safe: an environment variable whose value must appear nowhere (repeatable)',
    set: (a, v) => { a.knownSecretEnvs.push(v) },
  },
}

const ALIASES: Readonly<Record<string, string>> = { '-y': '--yes' }

/** A flag a command takes: its name, optionally with the command's own help line. */
type FlagUse = string | { readonly flag: string; readonly value?: string; readonly help?: string }

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
  /** Its rows in `traces --help`: each question it answers and how to ask it. */
  readonly overview?: ReadonlyArray<readonly [question: string, example: string]>
}

const SELECT = ['--current', '--last', '--since', '--cwd', '--harness', '--latest-turn'] as const
const MANY = Number.POSITIVE_INFINITY

const COMMANDS = [
  {
    name: 'graphs',
    usage: 'graphs [<ref…> | --current | --last N | --since T] [flags]',
    job: 'Ingest session graphs, or rank a Runtime corpus by delivery, wall minutes, tokens and human messages.',
    flags: [...SELECT.slice(0, 3), '--until', ...SELECT.slice(3), '--fleet-run', '--discovery-index', '--registry', '--task-type', '--shape', '--runtime-module',
      { flag: '--out', value: 'DIR', help: 'ingest into this Runtime registry (default local traces state)' }, '--format'],
    formats: ['text', 'json'],
    refs: [0, MANY],
    jq: [['.groups[] | {taskType, topologyDigest, deliveredRate, medianMergeMs}', 'task type × topology; unknown stays null']],
    examples: ['traces graphs --since 7d --out corpus', 'traces graphs --registry corpus --task-type bugfix --format json'],
    overview: [['Which graph topologies delivered?', 'traces graphs [--registry DIR]']],
  },
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
    overview: [['Which sessions ran?', 'traces list [--cwd .] [--last N]']],
  },
  {
    name: 'facts',
    usage: 'facts <ref…> | --current | --last N | --since T [flags]',
    job: 'What happened, exactly, for $0: who acted, turns, tools, commands, PRs, first failure, tokens, cost, time lost.',
    flags: [
      ...SELECT.slice(0, 3), '--until', ...SELECT.slice(3), '--match', '--no-content',
      { flag: '--format', help: 'text (default, 25 lines a session), json (the sheet), or jsonl: one row per typed turn' },
      { flag: '--out', help: 'write the sheet to PATH; stdout gets one summary line' },
    ],
    formats: ['text', 'json', 'jsonl'],
    refs: [0, MANY],
    select: 'required',
    jq: [
      ['.sessions[0].humanTurns.value[] | {at, text, spanId}', 'each typed turn, its time and span'],
      ['.sessions[0].commands.value[]', 'programs run: runs, failed, inScripts'],
      ['.sessions[0].measurements.tools[] | {name, calls, failed: .outcomes.error}', 'tool calls by name, and failures'],
      ['.sessions[0] | {firstFailure, tokens, cost, agent: .agent.value}', 'first failure, tokens, cost, who acted'],
    ],
    examples: ['traces facts --current', "traces facts 019a3c7e --format json | jq '.sessions[0].measurements.waste'", "traces facts --since 30d --match '^gh pr merge'"],
    overview: [
      ['What happened (turns, PRs, failure, cost)? $0', 'traces facts <ref> | --current | --since 1d'],
      ['Did we already try X / what was said? $0', "traces facts <ref> | --since 30d --match '<re>'"],
    ],
  },
  {
    name: 'analyze',
    usage: 'analyze <ref…> | --current | --last N | --since T [flags]',
    job: 'What went wrong, ranked, for $0: failing commands, stalls, interrupts, findings, and what the trace cannot answer.',
    notes: ['At most 40 lines; several sessions get a table of the 15 with the most waste. A Runtime run dir reports its tree.'],
    flags: [
      ...SELECT.slice(0, 3), '--until', ...SELECT.slice(3),
      { flag: '--format', help: 'text (default, at most 40 lines) or json: facts, packet, measures, conformance, cannotAnswer' },
      { flag: '--out', value: 'DIR', help: 'write report.md and findings.json under DIR; stdout gets one summary line' },
    ],
    formats: ['text', 'json'],
    refs: [0, MANY],
    select: 'required',
    jq: [
      ['.packet.findings[] | {severity, subject, claim}', 'the findings, HIGH first'],
      ['.cannotAnswer[] | {analysis, reason}', 'what the trace cannot answer, and why'],
      ['.facts.sessions[0].measurements.waste', 'failing streaks, stalls, reverts'],
    ],
    examples: ['traces analyze --current', 'traces analyze 019a3c7e --out analysis', 'traces analyze --since 1d --cwd .'],
    overview: [['Where did it waste time or get interrupted? $0', 'traces analyze <ref>']],
  },
  {
    name: 'ask',
    usage: 'ask <ref…> | --current | --last N | --since T --question TEXT [flags]',
    job: 'A question facts cannot answer, with checked trace:// citations: the only command that calls a model.',
    notes: [
      `Each question spends at most min(--budget, $${DEFAULT_QUESTION_MAX_COST_USD}) within ${DEFAULT_QUESTION_TIMEOUT_MS / 1000} s; ${DEFAULT_ASK_CONCURRENCY} run at once. Some unanswered: exit 2.`,
      'Needs TANGLE_API_KEY (or OPENAI_API_KEY) and uv, or TRACES_PYTHON naming a Python with agent-eval-rpc[dspy].',
    ],
    flags: [
      ...SELECT, '--question', '--questions', '--budget', '--model',
      { flag: '--format', help: 'text (default): the report; json: each answer, its citations, failure and cost' },
      { flag: '--out', value: 'DIR', help: 'write answers.json and report.md under DIR; stdout gets one summary line' },
    ],
    formats: ['text', 'json'],
    refs: [0, MANY],
    select: 'required',
    jq: [['.questions[] | {id, status, answer, failure}', 'each answer, or why it has none']],
    examples: [
      'traces ask --current --question "Which command failed first?" --budget 1',
      'traces ask 019a3c7e --questions questions.json --budget 5 --out answers',
      "traces ask --last 3 --question \"Did it verify the fix?\" --budget 2 --format json | jq '.questions[0].answer'",
    ],
    overview: [["A question facts can't answer (model, $)", 'traces ask <ref> --question "…" --budget 1']],
  },
  {
    name: 'check',
    usage: 'check <ref…> | --current | --last N | --since T  --contract FILE|conformance | --share-safe  [flags]',
    job: 'The one gate: does this run pass a trace contract or conform, and is this file safe to share?',
    notes: [
      'A gate is required. --share-safe reads each path as bytes, never as a trace. --contract F with no ref explains F.',
      'Exit 0 pass, 1 any gate fails, 2 a gate could not decide: a bad contract, a rule or verdict that could not run, an unreadable ref.',
    ],
    flags: [
      '--contract', '--share-safe', '--known-secret-env',
      ...SELECT.slice(0, 4), { flag: '--harness', help: 'force the reader of a file ref (claude-code, codex, …)' },
      { flag: '--format', help: 'text (default), json, junit or github: the verdict, on stdout' },
      { flag: '--out', value: 'DIR', help: 'write evidence for each gate that did not pass under DIR' },
    ],
    formats: ['text', 'json', 'junit', 'github'],
    refs: [0, MANY],
    select: 'required',
    jq: [
      ['.gates[] | {gate, status}', 'each gate and what it decided'],
      ['.gates[].report.traces[]?.verdict.violations', 'each rule a run broke, with span ids'],
    ],
    examples: [
      'traces check run.otlp.jsonl --contract contract.json --format junit > contract.xml',
      'traces check spans.otlp.jsonl --contract conformance',
      'traces check handoff.md --share-safe --known-secret-env TANGLE_API_KEY',
    ],
    overview: [
      ['Does this run pass? (CI)', 'traces check <ref> --contract c.json|conformance'],
      ['Is this safe to share?', 'traces check <path> --share-safe'],
    ],
  },
  {
    name: 'diff',
    usage: 'diff <a> <b> [--format text|json]',
    job: 'Where two runs of one task split: the first tool call that differs, with both calls.',
    notes: [
      'A side is a session id or 8+ char prefix or suffix, a session file, OTLP, file#<trace id> or file#branch=<id>.',
      'Calls compare by tool, status and argument (the command, the file, or the input), after each run\'s',
      'cwd, worktree, temp dirs and hex ids become <cwd>, <worktree>, <tmp> and <hex>. Model calls are not compared.',
      'Exit 0 agree, 1 diverge, 2 could not compare: a side cannot be read, or neither records an outcome.',
    ],
    flags: [{ flag: '--format', help: 'text (default) or json' }],
    formats: ['text', 'json'],
    refs: [2, 2],
    jq: [
      ['.diff.firstDivergence', 'where and how the runs first split (index is 0-based)'],
      ['.a.steps[.diff.firstDivergence.a].text', "A's call at that step, normalized"],
    ],
    examples: [
      'traces diff 0199a1b2 0199c3d4',
      'traces diff passing.otlp.jsonl failing.otlp.jsonl',
      'traces diff run.otlp.jsonl#branch=a run.otlp.jsonl#branch=b --format json',
    ],
    overview: [['Where did two runs diverge?', 'traces diff <a> <b>']],
  },
  {
    name: 'watch',
    usage: 'watch [<id…> | <store-root>] [--since T] [--once]  |  watch <run-dir|span file> [--once]',
    job: 'Live supervision: what the analyze rules find in every session active in the last 30 minutes, or one run tree.',
    notes: [
      'Sessions are read every 5 s; a run tree every 2 s, until its result lands (exit 1 when the run ended with an error).',
      'A run dir or span file prints its tree as text, and its findings with --format jsonl.',
    ],
    flags: [
      { flag: '--since', help: 'sessions active in the last T (default 30m; it slides with time), or since an ISO time' },
      '--cwd', { flag: '--harness', help: "only this harness's sessions; with a file ref, force its reader" },
      { flag: '--once', help: 'one pass, then exit' },
      { flag: '--format', help: 'text (default): a line per new finding, or the run tree; jsonl: the traces.stream events' },
    ],
    formats: ['text', 'jsonl'],
    refs: [0, MANY],
    jq: [
      ['select(.event == "finding") | .finding | {severity, ruleId, claim}', 'each new finding'],
      ['select(.event == "tick") | .unreadSessions', 'sessions a pass could not read, and why'],
    ],
    examples: ['traces watch --once', 'traces watch runs/my-run --once', 'traces watch --since 2h --format jsonl'],
    overview: [['What is happening right now?', 'traces watch [<run-dir>] [--once]']],
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
    overview: [["Keep a session's evidence", 'traces bundle <ref> --out <dir> · bundle verify <dir>']],
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
    usage: 'convert <ref…> | --current | --last N | --since T [--out FILE] [--no-content]',
    job: 'Hand spans to another tool: contract OTLP-JSONL, to --out or stdout.',
    notes: ['Sandbox events, Codex live streams and OpenInference files are sniffed; --harness forces a reader.'],
    flags: [
      ...SELECT,
      { flag: '--no-content', help: 'metadata only: drop prompts, replies, tool input and output, error text, paths and briefs' },
      { flag: '--out', help: 'write the spans to PATH; stdout gets one summary line' },
      { flag: '--format', help: 'the --out summary line: text (default) or json {out, spans, droppedAttributes}' },
    ],
    formats: ['text', 'json'],
    refs: [0, MANY],
    select: 'required',
    jq: [['.droppedAttributes', 'with --out and --no-content: the attribute keys the metadata-only rule removed']],
    examples: [
      'traces convert --current --out spans.otlp.jsonl',
      'traces convert raw.otlp.jsonl --no-content --out metadata.otlp.jsonl --format json',
      'traces convert live-stream.jsonl --harness codex-exec > spans.otlp.jsonl',
    ],
    overview: [['Hand spans to another tool', 'traces convert <ref> --out <file>']],
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
    overview: [['Ship sessions to Intelligence', 'traces upload <ref>|--since T [--dry-run]']],
  },
  {
    name: 'skills',
    usage: 'skills [--since T] [--unused] [--format text|json]',
    job: 'Which skills are used, and which installed skills never are; no model call.',
    notes: ['Reads Claude Code, Codex and Kimi Code sessions; each run reads only bytes appended since the last.'],
    flags: [
      { flag: '--since', help: 'count use since T: 30m, 2h, 7d or an ISO time (default 30d)' },
      '--unused', { flag: '--format', help: 'text (default), or json with the refresh cost and sweep exclusions' },
    ],
    formats: ['text', 'json'],
    refs: [0, 0],
    jq: [
      ['.rows[] | {skill, sessions}', 'use per skill'],
      ['.unused[].skill', 'installed skills never used in the window'],
    ],
    examples: ['traces skills --since 30d', 'traces skills --unused', "traces skills --format json | jq '.rows[] | {skill, sessions}'"],
    overview: [['Which skills are used?', 'traces skills [--unused]']],
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
    overview: [['Serve span tools over MCP', 'traces mcp <ref>|--last N']],
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

/** The commands that take `flag`. */
function appliesTo(flag: string): string[] {
  return SPECS.filter((spec) => usesOf(spec).some((use) => use.flag === flag)).map((spec) => spec.name)
}

function formatHelp(formats: readonly string[]): string {
  return `${formats[0]} (default) or ${formats.slice(1).join(' or ')}`
}

const OVERVIEW_COLUMN = 49

/** `traces --help`: one row per question, from the table. At most 40 lines. */
export function renderGlobalHelp(): string {
  const rows = SPECS.flatMap((spec) => (spec.overview ?? []).map(([question, example]) => `  ${question.padEnd(OVERVIEW_COLUMN - 1)} ${example}`))
  const formats = [...new Set(SPECS.flatMap((spec) => spec.formats ?? []))]
  return [
    'traces: what your agents did, where they wasted time, whether a run passes',
    "Start here for one session: traces facts <ref> (25 lines); one field: add --format json | jq '<path>'",
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
  const flagLines = usesOf(spec).map((use) => {
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
    const format = spec.formats?.includes('json') ? 'json' : 'jsonl'
    lines.push('', `jq paths (--format ${format}):`, ...spec.jq.map(([path, what]) => `  ${path.padEnd(width)}  ${what}`))
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
  if (spec.name === 'check') checkGates(args)
  // `check --contract F` with nothing selected explains F and reads no trace.
  const explains = spec.name === 'check' && !selected
  if (spec.select === 'required' && !selected && !explains) {
    const flags = new Set(usesOf(spec).map((use) => use.flag))
    const ways = ['a ref', ...['--current', '--last N', '--since T'].filter((way) => flags.has(way.split(' ')[0]!))]
    const choice = ways.length === 1 ? ways[0] : `${ways.slice(0, -1).join(', ')} or ${ways.at(-1)}`
    throw new UsageError(
      `${spec.name} needs ${choice}` +
        `${flags.has('--cwd') ? '; --cwd and --harness only narrow' : ''}. traces list finds a session`,
    )
  }
  // `ask` is the one command that spends, so the caller names the most it may.
  if (spec.name === 'ask' && args.budget === undefined) {
    throw new UsageError(`ask needs --budget USD, the most the run may spend: ${tracesCommand([...argv, '--budget', '1'])} (each question spends at most min(USD, $${DEFAULT_QUESTION_MAX_COST_USD}))`)
  }
}

/**
 * check fails closed: with no gate it exits 2 naming both, so a CI step whose
 * contract variable expanded to nothing never passes. `--share-safe` reads the
 * paths named on the command line, not a selection of sessions.
 */
function checkGates(args: Args): void {
  if (args.contracts.length === 0 && !args.shareSafe) {
    throw new UsageError('check needs a gate: --contract FILE|conformance (repeatable), or --share-safe')
  }
  if (args.shareSafe && (args.current || args.last > 0 || args.since !== undefined)) {
    throw new UsageError('--share-safe reads the paths you name; --current, --last and --since select sessions for a contract. Run them as two checks')
  }
  if (args.shareSafe && args.refs.length === 0) throw new UsageError('--share-safe needs the files or directories to read: traces check <path> --share-safe')
  if (args.knownSecretEnvs.length > 0 && !args.shareSafe) throw new UsageError('--known-secret-env applies with --share-safe')
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
