#!/usr/bin/env node
/**
 * `traces`: the command handlers. `src/commands.ts` owns the command table
 * (parsing, the per-command flag allowlist, help and dispatch); `src/moved.ts`
 * owns every 0.x spelling 1.0 removed. `traces --help` lists the commands and
 * `traces <command> --help` each one's flags.
 *
 * A ref names what to read by what it is (`src/refs.ts`): a session id or a
 * unique 8+ character prefix or suffix, a session file, OTLP or trace
 * evidence, a bundle or Runtime run directory, or a store root. With no ref, a
 * selection flag (`--current`, `--last`, `--since`) names the sessions.
 */

import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { appendAll } from './arrays.js'
import { indexSessionIdsByTrace } from './attributes.js'
import { findingRejectionDetail } from './finding-rejections.js'
import { type TraceEvidenceFormatOption, exportTraceEvidenceFile } from './file-export.js'
import {
  loadTracesConfig,
  mergeTracesConfig,
  isBridgeMismatchError,
  runTraceImprovement,
  runTraceInvestigation,
  saveReport,
  totalAgenticFailureMessage,
  type TraceInvestigationResult,
} from './improvement.js'
import { shellWord } from './moved.js'
import {
  serializeTraceStreamEvent,
  streamSessions,
  traceStreamEventsFromSpans,
  type TraceLiveAnalyst,
  type TraceLiveFinding,
} from './live.js'
import {
  analyzeSupervisorRun,
  findSupervisorRunDirs,
  isRuntimeSupervisorRunDir,
  renderSupervisorRollupMarkdown,
  renderSupervisorRunMarkdown,
  rollupSupervisorRuns,
} from '@tangle-network/agent-eval/supervisor-run'
import { fileRunContextSupervisorRunReader } from './supervisor-run-context.js'
import { resolveRunWatchTarget, watchRunTarget } from './run-watch.js'
import type { TraceAnalysisEngine } from '@tangle-network/agent-eval/analyst'
import { analysisEngineFromEnv, DEFAULT_ANALYST_MODEL, DEFAULT_QUESTION_MAX_COST_USD } from './analyst-model-call.js'
import {
  loadTraceQuestionsFile,
  normalizeTraceQuestions,
  runTraceQuestions,
  type TraceQuestion,
  type TraceQuestionsResult,
  writeTraceQuestionsArtifacts,
} from './ask.js'
import type { OtlpSpan } from './otlp.js'
import { iterSerializedSpans, writeOtlpFile } from './otlp.js'
import type {
  OtlpFieldWithheld,
  OtlpIngestIssue,
  OtlpInputFile,
  SkippedInputFile,
  UnreadableSourceRows,
} from './otlp-input.js'
import { readOtlpInput } from './otlp-input.js'
import {
  computeSessionFacts,
  createSessionFactsReportBuilder,
  renderSessionFacts,
  type SessionFactsReport,
  type UnreadSessionFact,
} from './session-facts.js'
import { renderValidation, validationExitCode } from './conformance.js'
import type { TraceValidation } from '@tangle-network/agent-trace-contract'
import { watchSessions } from './observer.js'
import { listAdapters, resolveAdapter, selectAdapters } from './registry.js'
import { locateSessions, parseSession, readSessionSpans, sessionsInCwd } from './session-source.js'
import { collectSessionSelection, type SessionSelection } from './session-selection.js'
import {
  type SessionWorkflowIssue,
  type SessionWorkflowSummary,
} from './session-workflow.js'
import { assembleSessionBundle, verifySessionBundle } from './bundle.js'
import { diffRuns, renderRunDiff } from './diff.js'
import { serveTraceMcp } from './mcp.js'
import { sessionReportSource } from './report.js'
import type { ReportSource } from './report.js'
import { parseSince, parseTimeBound } from './time.js'
import { explainTraceContract } from '@tangle-network/agent-eval'
import {
  AmbiguousTraceInputError,
  CHECK_EXIT,
  loadContract,
  renderCheckText,
  renderGithubAnnotations,
  renderJUnit,
  runCheck,
} from './check.js'
import { readsStoreRoots } from './adapters/harness-sessions.js'
import { RefError, resolveRefs, selectSpans, shortestRefs, type ResolvedRef } from './refs.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'
import { executeUpload, planUpload, planUploadFrom, type RefusedSession, type UploadPlan } from './upload.js'
import { formatVerdict, verdictExitCode, verifySafe } from './verify-safe.js'
import {
  buildSkillUsageReport,
  DEFAULT_SWEEP_THRESHOLD,
  defaultSkillUsageStorePath,
  readInstalledSkills,
  renderSkillUsage,
  SkillUsageStore,
} from './skill-usage.js'
import { type Args, CliError, type Handler, runTraces, UsageError, writeError } from './commands.js'

/**
 * What a command's positional refs resolved to. Read once, before the command
 * runs, so every reader below sees the same sessions and files.
 */
interface RefSelection {
  /** Harness sessions a ref named: an id, a unique prefix or suffix, or a session file. */
  readonly sessions: ReadonlyArray<{ readonly adapter: HarnessTraceAdapter; readonly ref: SessionRef }>
  /** Span sources a ref named: OTLP or trace evidence files and directories, bundles, run directories. */
  readonly spans: ReadonlyArray<Extract<ResolvedRef, { kind: 'spans' | 'run-dir' }>>
  /** A store root: selection runs over it instead of HOME. */
  readonly home?: string
}

/** A parsed command line, with its refs resolved for the commands that read them. */
type CliArgs = Args & { selection?: RefSelection }

/** The most spawned children a named session brings with it. */
const MAX_CHILD_SESSIONS = 100

/**
 * The caller's own session, from the variable its harness sets. Codex's wins:
 * a Codex session started from Claude Code inherits CLAUDE_CODE_SESSION_ID.
 * `harness` (an explicit `--harness codex|claude-code`) reads only its own variable.
 */
function callerSession(harness?: string): { readonly harness: 'codex' | 'claude-code'; readonly sessionId: string } | undefined {
  const codex = process.env.CODEX_THREAD_ID?.trim()
  const claude = process.env.CLAUDE_CODE_SESSION_ID?.trim()
  if (codex && harness !== 'claude-code') return { harness: 'codex', sessionId: codex }
  if (claude && harness !== 'codex') return { harness: 'claude-code', sessionId: claude }
  return undefined
}

const CURRENT_VARIABLES = 'CODEX_THREAD_ID (Codex) or CLAUDE_CODE_SESSION_ID (Claude Code)'

/** `--current` is the caller's own session, named by id. */
function applyCurrentSessionSelection(args: CliArgs): CliArgs {
  if (!args.current) return args
  if (args.refs.length > 0) throw new UsageError('--current names the caller\'s own session; pass --current or a ref, not both')
  if (args.last > 0) throw new UsageError('--current cannot be combined with --last')
  const named = args.harnessExplicit ? resolveAdapter(args.harness)?.harness ?? args.harness : undefined
  if (named !== undefined && named !== 'codex' && named !== 'claude-code') {
    throw new UsageError(
      `--current reads ${CURRENT_VARIABLES}; ${named} sets neither. ` +
        'Name this session with `traces list --cwd . --last 1`',
    )
  }
  const caller = callerSession(named)
  if (!caller) {
    throw new UsageError(
      `--current needs ${CURRENT_VARIABLES}, and neither is set. ` +
        'On another harness, `traces list --cwd . --last 1` names this session',
    )
  }
  return { ...args, refs: [caller.sessionId], input: caller.sessionId, harness: caller.harness, harnessExplicit: true }
}

function supportsTaskTurns(adapter: HarnessTraceAdapter | undefined): boolean {
  return adapter?.harness === 'codex' || adapter?.harness === 'claude-code'
}

/** `--latest-turn` reads the harnesses that record task turns. */
function validateLatestTurn(args: CliArgs): CliArgs {
  if (args.latestTurn && args.harnessExplicit && !supportsTaskTurns(resolveAdapter(args.harness))) {
    throw new UsageError('--latest-turn reads Codex and Claude Code sessions; pass --harness codex or claude-code, or no --harness')
  }
  return args
}

/**
 * Resolve the positional refs. Sessions, span sources and a store root are
 * kept apart, because each is read its own way, and a selection flag that
 * applies only to harness sessions is refused for the rest.
 */
async function resolveSelection(args: CliArgs): Promise<RefSelection | undefined> {
  if (args.refs.length === 0) return undefined
  const resolved = await resolveRefs(args.refs, { harness: args.harnessExplicit ? args.harness : undefined })
  const sessions: Array<RefSelection['sessions'][number]> = []
  const spans: Array<RefSelection['spans'][number]> = []
  let home: string | undefined
  for (const ref of resolved) {
    // A session file records no cwd of its own until it is parsed; --cwd names
    // it, as it always has for an explicit session path.
    if (ref.kind === 'session') sessions.push({ adapter: ref.adapter, ref: { ...ref.session, cwd: ref.session.cwd ?? args.cwd ?? null } })
    else if (ref.kind === 'store-root') home = ref.path
    else spans.push(ref)
  }
  if (args.latestTurn) {
    if (spans[0]) throw new UsageError(`--latest-turn reads harness sessions; ${spans[0].ref} is a span source`)
    const other = sessions.find(({ adapter }) => !supportsTaskTurns(adapter))
    if (other) throw new UsageError(`--latest-turn reads Codex and Claude Code sessions; ${other.ref.sessionId} is ${other.adapter.harness}`)
    // Over a store root every harness is read unless --harness names one.
    const narrowed = args.harnessExplicit && supportsTaskTurns(resolveAdapter(args.harness))
    if (home !== undefined && sessions.length === 0 && !narrowed) {
      throw new UsageError('--latest-turn over a store root requires --harness codex or claude-code')
    }
  }
  return { sessions, spans, ...(home !== undefined ? { home } : {}) }
}

/** `args` with its refs resolved, for a command that reads them. */
async function withSelection(args: CliArgs): Promise<CliArgs> {
  if (args.selection || args.refs.length === 0) return args
  return { ...args, selection: await resolveSelection(args) }
}

/** Y/N confirm on a TTY (prompt to stderr so stdout stays clean). Non-TTY → false. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin,
    output: process.stderr,
  })
  try {
    const ans = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    return ans === 'y' || ans === 'yes'
  } finally {
    rl.close()
  }
}

/**
 * The harnesses a selection reads: every harness, or the one `--harness` names.
 * Over a store root, only those that read one. `--latest-turn` with no
 * `--harness` reads the harnesses that record task turns.
 */
function adaptersFor(args: CliArgs): HarnessTraceAdapter[] {
  let adapters = args.harnessExplicit ? selectAdapters({ harnesses: [args.harness] }) : [...listAdapters()]
  if (args.latestTurn && !args.harnessExplicit) adapters = adapters.filter(supportsTaskTurns)
  return args.selection?.home !== undefined ? adapters.filter(readsStoreRoots) : adapters
}

interface Discovered {
  /** Newest first, across every harness read. */
  readonly sessions: ReadonlyArray<{ readonly adapter: HarnessTraceAdapter; readonly ref: SessionRef }>
  /** Harness stores that could not be listed, each named with its reason. */
  readonly unread: UnreadSessionFact[]
}

/**
 * The sessions a selection with no named session finds: every one modified
 * since `--since` (with a record in the window, for commands that read one),
 * newest first by file mtime across every harness. `--last N`, or `defaultLast`
 * when neither `--last` nor `--since` is given, keeps the newest N, and never
 * the caller's own session.
 */
async function discover(args: CliArgs, defaultLast?: number): Promise<Discovered> {
  return narrow(args, await locateAll(args, args.since ? parseSince(args.since) : undefined), defaultLast)
}

/** Every session of the selected harnesses (modified since `sinceMs`, when given), newest first. */
async function locateAll(args: CliArgs, sinceMs?: number): Promise<Discovered> {
  const sessions: Array<Discovered['sessions'][number]> = []
  const unread: UnreadSessionFact[] = []
  for (const adapter of adaptersFor(args)) {
    try {
      for (const ref of await locateSessions(adapter, { sinceMs, home: args.selection?.home })) sessions.push({ adapter, ref })
    } catch (error) {
      unread.push({ sessionId: null, traceId: null, source: `${adapter.harness} sessions`, reason: errorText(error) })
    }
  }
  return { sessions: sessions.sort((a, b) => b.ref.mtimeMs - a.ref.mtimeMs), unread }
}

/** `located`, narrowed by `--since`, `--cwd` and `--last` (see `discover`). */
async function narrow(args: CliArgs, located: Discovered, defaultLast?: number): Promise<Discovered> {
  const sinceMs = args.since ? parseSince(args.since) : undefined
  let sessions = sinceMs === undefined ? located.sessions : located.sessions.filter(({ ref }) => ref.mtimeMs >= sinceMs)
  if (args.cwd) {
    const kept = new Set<SessionRef>()
    for (const adapter of new Set(sessions.map((session) => session.adapter))) {
      const refs = sessions.filter((session) => session.adapter === adapter).map((session) => session.ref)
      for (const ref of await sessionsInCwd(adapter, refs, args.cwd)) kept.add(ref)
    }
    sessions = sessions.filter(({ ref }) => kept.has(ref))
  }
  const last = args.last > 0 ? args.last : args.since ? undefined : defaultLast
  if (last === undefined) return { sessions, unread: located.unread }
  const caller = callerSession()?.sessionId
  return { sessions: sessions.filter(({ ref }) => ref.sessionId !== caller).slice(0, last), unread: located.unread }
}

/** Sessions as the per-harness groups the selection collector reads, in their order. */
function groupsInOrder(sessions: Discovered['sessions']): { adapter: HarnessTraceAdapter; refs: SessionRef[] }[] {
  const groups: { adapter: HarnessTraceAdapter; refs: SessionRef[] }[] = []
  for (const { adapter, ref } of sessions) {
    const last = groups[groups.length - 1]
    if (last?.adapter === adapter) last.refs.push(ref)
    else groups.push({ adapter, refs: [ref] })
  }
  return groups
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Name the sessions a sweep skipped, in one stderr line that says how to see
 * each with its reason: `command` with the same selection, as JSON.
 */
function warnUnread(args: CliArgs, unread: readonly UnreadSessionFact[], command: 'facts' | 'list' = 'facts'): void {
  if (unread.length === 0) return
  const select: string[] = args.current ? ['--current'] : args.refs.map(shellWord)
  if (args.harnessExplicit && !args.current) select.push('--harness', args.harness)
  if (args.since) select.push('--since', shellWord(args.since))
  if (args.until) select.push('--until', shellWord(args.until))
  if (args.last > 0) select.push('--last', String(args.last))
  if (args.cwd) select.push('--cwd', shellWord(args.cwd))
  if (args.latestTurn) select.push('--latest-turn')
  process.stderr.write(`${unread.length} unreadable: ${['traces', command, ...select].join(' ')} --format json | jq .selection\n`)
}

/**
 * `--llm` engine. It forwards the whole `--budget` as the per-analyst provider
 * ceiling: the registry already splits `--budget` across analysts, so this only
 * stops the engine's own $1 default from cutting runs short.
 */
function llmAnalysisEngine(args: CliArgs, model: string): TraceAnalysisEngine {
  return analysisEngineFromEnv({ model, maxCostUsd: args.budget, log: analystLog })
}

function analystModelFor(args: CliArgs): string {
  return args.model ?? process.env.TRACES_ANALYST_MODEL ?? DEFAULT_ANALYST_MODEL
}

/**
 * The published version of the Python bridge (`agent-eval-rpc` on PyPI) that
 * speaks this CLI's engine protocol. The bridge validates its input with
 * exact-key checks, so any skew between the interpreter's installed bridge and
 * this package's `@tangle-network/agent-eval` dependency kills every agentic
 * analyst at startup, before any model call.
 */
function requiredBridgeVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, unknown>
  }
  const version = pkg.dependencies?.['@tangle-network/agent-eval']
  if (typeof version !== 'string' || !version) {
    throw new Error('package.json is missing the @tangle-network/agent-eval dependency')
  }
  return version
}

/**
 * `--llm` promises agentic findings. Delivering the deterministic report with
 * exit 0 when the requested analysis died reads as success, so the report is
 * written and the run then exits 1 with each reason. The bridge-version read
 * happens only once total agentic failure is established, so a package.json
 * problem can never turn a successful run into a failure.
 */
function failUnlessRequestedAnalysesRan(
  args: CliArgs,
  result: Pick<TraceInvestigationResult, 'agenticPerAnalyst'>,
): void {
  if (!args.llm || !totalAgenticFailureMessage(result.agenticPerAnalyst)) return
  const message = totalAgenticFailureMessage(result.agenticPerAnalyst, { requiredBridgeVersion: requiredBridgeVersion() })
  process.stderr.write(`error: ${message}\n`)
  process.exitCode = 1
}

/** One `traces list` row: the facts a person picks a session by. */
interface ListRow {
  /** The shortest prefix or suffix (8+ characters) that names this session alone; any command takes it as a ref. */
  readonly ref: string
  readonly id: string
  readonly harness: string
  readonly path: string
  readonly bytes: number | null
  readonly parentSessionId: string | null
  /** The last record, or the file's mtime when no record carries a time. */
  readonly lastActivity: string
  readonly durationMs: number | null
  readonly humanTurns: number | null
  /** The working directory the session recorded. */
  readonly cwd: string | null
  /** The first turn a person typed, on one line, clipped to 80 characters. */
  readonly firstPrompt: string | null
}

const PROMPT_CHARS = 80

function oneLine(text: string, chars: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= chars ? flat : `${flat.slice(0, chars - 1)}…`
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '?'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The facts of one session's own trace, as a list row. */
async function listRow(adapter: HarnessTraceAdapter, ref: SessionRef, shortRef: string): Promise<ListRow> {
  const spans = await readSessionSpans(adapter, ref)
  const sessions = computeSessionFacts(spans)
  const facts = sessions.find((entry) => entry.sessionId === ref.sessionId) ?? sessions[0]
  if (!facts || facts.recordSpans === 0) throw new Error('no record could be read')
  const first = facts.firstRecordAt.value
  const last = facts.lastRecordAt.value
  let bytes: number | null = null
  try {
    bytes = (await stat(ref.path)).size
  } catch {
    // A store that moved between locate and read has no size to report.
  }
  const turns = facts.humanTurns.value
  return {
    ref: shortRef,
    id: ref.sessionId,
    harness: adapter.harness,
    path: ref.path,
    bytes,
    parentSessionId: facts.parentSessionId,
    lastActivity: last ?? new Date(ref.mtimeMs).toISOString(),
    durationMs: first !== null && last !== null ? Date.parse(last) - Date.parse(first) : null,
    humanTurns: turns?.length ?? null,
    cwd: facts.cwd.value ?? ref.cwd,
    firstPrompt: turns?.[0] ? oneLine(turns[0].text, PROMPT_CHARS) : null,
  }
}

/**
 * `traces list`: one row per session, newest first, across every harness.
 * `--last 20` by default, never the caller's own session; `--since` lists
 * every session active in the window. A session that cannot be read is
 * counted in the footer and named in the JSON's `selection.unreadSessions`.
 */
async function cmdList(args: CliArgs): Promise<void> {
  const named = args.selection?.sessions[0]?.ref.sessionId ?? args.selection?.spans[0]?.ref
  if (named !== undefined) {
    throw new UsageError(`list finds sessions; its only ref is a store root, and ${named} is not one (read it with \`traces facts ${named}\`)`)
  }
  // Every session a ref could name, so each row's short ref names it alone.
  const every = await locateAll(args)
  const shortRefs = shortestRefs(every.sessions.map(({ ref }) => ref.sessionId))
  const found = await narrow(args, every, 20)
  const rows: ListRow[] = []
  const unread: UnreadSessionFact[] = [...found.unread]
  for (const { adapter, ref } of found.sessions) {
    try {
      rows.push(await listRow(adapter, ref, shortRefs.get(ref.sessionId) ?? ref.sessionId))
    } catch (error) {
      unread.push({ sessionId: ref.sessionId, traceId: null, source: ref.path, reason: errorText(error) })
    }
  }
  warnUnread(args, unread, 'list')
  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify({ sessions: rows, selection: { unreadSessions: unread } }, null, 2)}\n`)
    return
  }
  const footer = `${rows.length} session${rows.length === 1 ? '' : 's'} · ${unread.length} unreadable`
  const lines = rows.map((row) => [
    row.ref.padEnd(8),
    row.harness.padEnd(11),
    row.lastActivity.slice(0, 16).replace('T', ' '),
    formatDuration(row.durationMs).padStart(7),
    `${row.humanTurns ?? '?'} turn${row.humanTurns === 1 ? '' : 's'}`.padEnd(9),
    row.cwd ?? '(no cwd)',
    row.firstPrompt ? `"${row.firstPrompt}"` : '',
  ].join('  ').trimEnd())
  process.stdout.write(`${[...lines, footer].join('\n')}\n`)
}

type SelectedSessionSource = ReportSource

interface CollectedSpans {
  spans: OtlpSpan[]
  harness: string
  cwds: string[]
  sources: SelectedSessionSource[]
  workflow?: SessionWorkflowSummary
  /**
   * Conformance of the SOURCE, present when the spans were read from OTLP.
   * Absent for adapter output, which is graded from the spans themselves.
   */
  conformance?: TraceValidation
  conformanceSubject?: string
  conformanceFiles?: readonly OtlpInputFile[]
  conformanceSkipped?: readonly SkippedInputFile[]
  conformanceIssues?: readonly OtlpIngestIssue[]
  conformanceWithheld?: readonly OtlpFieldWithheld[]
  conformanceUnreadable?: UnreadableSourceRows
  /** Sessions the selection skipped because they could not be read. */
  unread?: readonly UnreadSessionFact[]
}

/**
 * Read OTLP spans a foreign system emitted, skipping the adapter stage
 * entirely: the analysis engine is already OTLP-native, so conforming spans
 * need no translation to be analysed.
 */
async function collectOtlpSpans(path: string, selector?: string): Promise<CollectedSpans> {
  let input: Awaited<ReturnType<typeof readOtlpInput>>
  try {
    input = await readOtlpInput(path)
  } catch (error) {
    if (!(await stat(path).catch(() => undefined))?.isDirectory()) throw error
    // A directory that is no run, store root or bundle is read as OTLP: say what else it could have been.
    throw new Error(
      `${errorText(error)}. A directory ref is read as OTLP-JSONL unless it is a Runtime run ` +
        '(spawn-journal.jsonl, observer.jsonl or failure.json), a harness store root, or a bundle (manifest.json)',
    )
  }
  if (input.spans.length === 0) {
    throw new Error(
      `no analyzable spans in ${path} (${input.files.length} file(s), ${input.rows.length} row(s), ` +
        `${input.issues.length} unusable). Run \`traces validate ${path}\` for the per-finding reason.`,
    )
  }
  const fileByTrace = new Map<string, string>()
  for (const file of input.files) {
    for (const traceId of file.traceIds) if (!fileByTrace.has(traceId)) fileByTrace.set(traceId, file.path)
  }
  const selected = selector ? selectSpans(input.spans, selector, path) : input.spans
  const byTrace = new Map<string, OtlpSpan[]>()
  for (const span of selected) {
    const grouped = byTrace.get(span.trace_id) ?? []
    grouped.push(span)
    byTrace.set(span.trace_id, grouped)
  }
  return {
    spans: [...selected],
    harness: 'otlp',
    cwds: [],
    sources: [...byTrace].map(([traceId, spans]) => sessionReportSource({
      harness: 'otlp',
      sessionId: traceId,
      path: fileByTrace.get(traceId) ?? path,
      cwd: null,
      mtimeMs: 0,
    }, spans, traceId)),
    conformance: input.validation,
    conformanceSubject: path,
    conformanceFiles: input.files,
    conformanceSkipped: input.skipped,
    conformanceIssues: input.issues,
    conformanceWithheld: input.withheld,
    conformanceUnreadable: input.unreadable,
  }
}

async function collectSpans(args: CliArgs): Promise<CollectedSpans> {
  if (args.refs.length > 0 && !args.selection) throw new Error(`internal: ${args.command} read its refs before resolving them`)
  const sources = args.selection?.spans ?? []
  if (sources.length === 0) {
    const collected = await collectSessionSpans(args)
    warnUnread(args, collected.unread ?? [])
    return collected
  }
  const parts: CollectedSpans[] = []
  for (const source of sources) {
    parts.push(source.kind === 'run-dir'
      ? await collectOtlpSpans(source.path)
      : source.reader === 'otlp'
        ? await collectOtlpSpans(source.path, source.selector)
        : await collectImportedSpans(source.path, source.reader, source.selector))
  }
  if (args.selection?.sessions.length) parts.push(await collectSessionSpans(args))
  const collected = parts.length === 1 ? parts[0]! : mergeCollected(parts)
  warnUnread(args, collected.unread ?? [])
  return collected
}

/** Spans of several refs together. A source's conformance describes that source alone, so it is not carried. */
function mergeCollected(parts: readonly CollectedSpans[]): CollectedSpans {
  const spans: OtlpSpan[] = []
  const cwds: string[] = []
  const sources: SelectedSessionSource[] = []
  const unread: UnreadSessionFact[] = []
  const workflows = parts.flatMap((part) => (part.workflow ? [part.workflow] : []))
  for (const part of parts) {
    appendAll(spans, part.spans)
    appendAll(cwds, part.cwds)
    appendAll(sources, part.sources)
    appendAll(unread, part.unread ?? [])
  }
  return {
    spans,
    harness: [...new Set(parts.flatMap((part) => part.harness.split('+')))].join('+'),
    cwds,
    sources,
    ...(workflows[0] ? { workflow: workflows[0] } : {}),
    ...(unread.length > 0 ? { unread } : {}),
  }
}

/** Spans of the selected harness sessions: refs, `--current`, or discovery. */
async function collectSessionSpans(args: CliArgs): Promise<CollectedSpans> {
  const selection = await collectSessionRows(args, args.last || 1)
  const spans: OtlpSpan[] = []
  const harnesses = new Set<string>()
  const cwds: string[] = []
  const sources: SelectedSessionSource[] = []
  for (const row of selection.rows) {
    harnesses.add(row.adapter.harness)
    appendAll(spans, row.spans)
    sources.push(sessionReportSource(row.ref, row.spans))
    if (row.ref.cwd) cwds.push(row.ref.cwd)
  }
  return {
    spans,
    harness: [...harnesses].join('+') || (args.harnessExplicit ? args.harness : 'none'),
    cwds,
    sources,
    ...(selection.workflow ? { workflow: selection.workflow } : {}),
    ...(selection.unread.length > 0 ? { unread: selection.unread } : {}),
  }
}

/**
 * `traces validate <file|dir>` (hidden; `check --contract conformance` in
 * 1.0): what a trace can and cannot answer, before anyone spends a run on it.
 * Exits non-zero on exactly one condition: the input is not a trace, because
 * not one entry in it could be read as a span. A degraded trace exits 0 and
 * states its degradation per capability.
 */
async function cmdValidate(args: CliArgs): Promise<void> {
  const path = args.input!
  const input = await readOtlpInput(path)
  const report = renderValidation(input.validation, {
    subject: path,
    files: input.files,
    skipped: input.skipped,
    issues: input.issues,
    withheld: input.withheld,
    unreadable: input.unreadable,
    spans: input.spans,
  })
  const validation = input.validation
  if (args.out) {
    await saveReport(args.out, report)
    console.log(
      `conformance report → ${args.out}  (${validation.findings.length} finding(s), ` +
        `${validation.capabilities.filter((capability) => capability.available).length}/` +
        `${validation.capabilities.length} capabilities available)`,
    )
  } else {
    console.log(report)
  }
  // `validate` is read by CI: an error finding must not exit 0.
  process.exitCode = validationExitCode(validation)
}

/**
 * `traces check` — gate a run on a trace contract. Exit 0 pass, 1 fail, 2
 * could not decide: the contract is missing or malformed, a rule could not
 * run (`code: unknown-verdict`), or the trace is unreadable or ambiguous. The
 * verdict always goes to stdout in `--format`, because CI reads it; evidence
 * for every trace that did not pass goes to `--evidence`.
 */
async function cmdCheck(args: CliArgs): Promise<void> {
  if (!args.contract) throw new UsageError('check needs --contract <contract.json>')
  let loaded: Awaited<ReturnType<typeof loadContract>>
  try {
    loaded = await loadContract(args.contract)
  } catch (error) {
    throw new UsageError(errorText(error))
  }
  for (const warning of loaded.warnings) process.stderr.write(`warning: ${warning}\n`)
  if (args.explain) {
    console.log(explainTraceContract(loaded.contract))
    return
  }
  let spans: OtlpSpan[]
  try {
    spans = (await collectSpans(await withSelection(args))).spans
  } catch (error) {
    if (error instanceof RefError || error instanceof CliError) throw error
    throw new CliError(errorText(error), error instanceof AmbiguousTraceInputError ? 'ambiguous' : 'unreadable')
  }
  if (spans.length === 0) throw new CliError('the trace holds no spans', 'unreadable')
  const json = args.format === 'json'
  const report = await runCheck(loaded.contract, spans, { evidenceRoot: args.evidence ?? join('.traces', 'check') })
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderCheckText(report)}\n`)
  if (args.junit) await writeFile(args.junit, renderJUnit(report), 'utf8')
  if (args.out) await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  // Annotations are lines of text: they would corrupt a JSON verdict on stdout.
  if (!json && (args.annotations || process.env.GITHUB_ACTIONS === 'true')) {
    const annotations = renderGithubAnnotations(report)
    if (annotations) console.log(annotations)
  }
  if (report.exitCode === CHECK_EXIT.couldNotDecide) {
    const undecided = report.traces.filter((trace) => trace.verdict.status === 'error').length
    writeError(`${undecided} trace(s) had a rule that could not run; the verdict above says which`, 'unknown-verdict', json)
  }
  process.exitCode = report.exitCode
}

/** `traces convert`: contract OTLP-JSONL to `--out`, or to stdout. */
async function cmdConvert(args: CliArgs): Promise<void> {
  const { spans, workflow } = await collectSpans(args)
  if (spans.length === 0) throw new Error('no spans found for the given selection')
  warnIncompleteWorkflow(workflow)
  if (args.out === undefined) {
    // Streamed line by line: a conversion can outgrow V8's maximum string length.
    for (const line of iterSerializedSpans(spans)) process.stdout.write(line)
    return
  }
  const path = await writeOtlpFile(spans, args.out)
  console.log(`wrote ${spans.length} spans → ${path}`)
}

function workflowIssueText(issue: SessionWorkflowIssue): string {
  if (issue.kind === 'cycle') return `cycle: ${issue.sessionIds.join(' -> ')}`
  if (issue.kind === 'unresolved-parent-task') {
    return `cannot resolve parent task for child ${issue.childSessionId} in ${issue.parentSessionId}: ${issue.reason}`
  }
  if (issue.kind === 'parent-conflict') {
    return `parent conflict for ${issue.sessionId}: declared ${issue.declaredParentSessionId ?? 'none'}, ` +
      `referenced by ${issue.referencedParentSessionIds.join(', ') || 'none'}`
  }
  if (issue.kind === 'unjoined-child') {
    return `unjoined child ${issue.agentPath} spawned by ${issue.parentSessionId}: ${issue.reason}` +
      (issue.candidates ? ` (${issue.candidates.join(', ')})` : '')
  }
  return `${issue.kind} ${issue.sessionId}, referenced as ${issue.relation} by ${issue.referencedBySessionId}`
}

function warnIncompleteWorkflow(workflow: SessionWorkflowSummary | undefined): void {
  if (!workflow || workflow.complete) return
  process.stderr.write(
    `warning: session workflow is incomplete (${workflow.issues.length} issue(s)): ` +
      `${workflow.issues.map(workflowIssueText).join('; ')}\n`,
  )
}

/** The sessions a selection names, or finds, parsed; with the sessions a sweep skipped as unreadable. */
type CollectedSessionRows = SessionSelection & { readonly unread: UnreadSessionFact[] }

/**
 * Parse the selected harness sessions. A named session (a ref or `--current`)
 * and a `--last` selection bring each session's spawned children, the named
 * session first; a window already holds every child that ran in it. A named
 * session that cannot be read exits 2; any other session that cannot be read
 * is skipped and named in `unread`.
 */
async function collectSessionRows(args: CliArgs, defaultLast: number): Promise<CollectedSessionRows> {
  const named = args.selection?.sessions ?? []
  const source = args.selection?.spans[0]
  if (source && named.length === 0) {
    throw new Error(`${args.command} reads harness sessions; ${source.ref} is a span source`)
  }
  const found = named.length > 0 ? { sessions: named, unread: [] } : await discover(args, defaultLast)
  const unread = [...found.unread]
  const selection = await collectSessionSelection(groupsInOrder(found.sessions), {
    workflow: named.length > 0 || !args.since,
    parents: false,
    maxWorkflowSessions: MAX_CHILD_SESSIONS,
    taskScope: args.latestTurn ? 'latest' : 'all',
    home: args.selection?.home,
    onUnreadable: ({ ref, error, seed }) => {
      if (seed && named.length > 0) throw new RefError(`${ref.sessionId} could not be read (${ref.path}): ${errorText(error)}`, 'unreadable')
      unread.push({ sessionId: ref.sessionId, traceId: null, source: ref.path, reason: errorText(error) })
    },
  })
  return { ...selection, unread }
}

async function cmdBundle(args: CliArgs): Promise<void> {
  const named = args.selection
  if (named?.sessions.length !== 1 || named.spans.length > 0) {
    throw new UsageError(
      named?.spans[0]
        ? `bundle keeps one harness session's evidence; ${named.spans[0].ref} is a span source`
        : 'bundle needs one session: traces bundle <id|path> --out <dir>; run `traces list` to pick a session ID',
    )
  }
  if (!args.out) throw new UsageError('bundle needs --out <dir>: a new or empty directory for the bundle')
  const { adapter, ref } = named.sessions[0]!
  const result = await assembleSessionBundle({ adapter, ref, outDir: args.out })
  const { manifest } = result
  console.log(`session bundle → ${result.directory}  (${manifest.files.length} file(s), ${manifest.absent.length} recorded absent)`)
}

/**
 * `traces mcp`: serve the selected spans to an MCP client over stdio. Stdout
 * carries the protocol, so everything else this command says goes to stderr.
 */
async function cmdMcp(args: CliArgs): Promise<void> {
  const collected = await collectSpans(args)
  if (collected.spans.length === 0) throw new Error('mcp: no spans found for the given selection')
  warnIncompleteWorkflow(collected.workflow)
  process.stderr.write(`traces mcp: serving ${collected.spans.length} span(s) over stdio\n`)
  await serveTraceMcp({ spans: collected.spans })
}

/**
 * `traces diff <a> <b>`: pair the two runs' steps and mark where they first
 * diverge. Exit 0 when they agree, 1 when they diverge, like diff(1); 2 when
 * they could not be compared: a side cannot be read, or the steps line up
 * with no divergence but neither side records an outcome to call agreement on
 * (`code: no-outcome`).
 */
async function cmdDiff(args: CliArgs): Promise<void> {
  if (args.kinds.some((kind) => !kind)) throw new UsageError('diff: --kind needs a span kind, e.g. --kind TOOL')
  const report = await diffRuns(args.refs[0]!, args.refs[1]!, { kinds: args.kinds })
  if (!report.diff.firstDivergence && report.caveat) {
    throw new CliError(`the runs line up with no divergence, but there is no recorded outcome to call agreement on: ${report.caveat}`, 'no-outcome')
  }
  process.stdout.write(args.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderRunDiff(report))
  if (report.diff.firstDivergence) process.exitCode = 1
}

/**
 * `traces bundle verify <dir>`: every listed file is on disk with its recorded
 * size and SHA-256, and nothing unlisted sits beside them. Exit 0 when the
 * bundle verifies, 1 when it does not.
 */
async function cmdBundleVerify(args: CliArgs): Promise<void> {
  const result = await verifySessionBundle(args.input!)
  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    const lines = [
      `${result.ok ? 'VERIFIED' : 'FAILED'}  bundle ${result.directory}`,
      `  ${result.matched}/${result.listed} listed file(s) match their recorded size and SHA-256`,
      ...result.issues.map((issue) => `  ${issue.kind.padEnd(11)} ${issue.path}: ${issue.detail}`),
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
  }
  if (!result.ok) process.exitCode = 1
}

/**
 * `traces facts` — the deterministic session-facts sheet, printed.
 *
 * No model, no engine, no budget: the numbers come out of the spans. JSON by
 * default because the sheet's consumers are programs; `--format text` prints
 * the short readable form. Every fact names the span ids it came from, so any
 * number here can be checked with `traces convert` or a trace tool.
 *
 * A named session (a ref or `--current`) comes first, its spawned children
 * after it, and one that cannot be read exits 2. A sweep (`--last`, a window)
 * skips a session that cannot be read and names it with its reason in
 * `selection.unreadSessions`, so one bad file never ends a run over hundreds.
 * With `--since`/`--until` the selection is every session with a record in
 * the window, read one at a time.
 */
async function cmdFacts(args: CliArgs): Promise<void> {
  const format = args.format ?? 'json'
  const window = args.since !== undefined || args.until !== undefined
    ? {
        ...(args.since !== undefined ? { since: new Date(parseSince(args.since)).toISOString() } : {}),
        ...(args.until !== undefined ? { until: new Date(parseTimeBound(args.until, '--until')).toISOString() } : {}),
      }
    : undefined
  // A store root alone is a place to select from, not a selection.
  const named = (args.selection?.sessions.length ?? 0) + (args.selection?.spans.length ?? 0)
  const builder = createSessionFactsReportBuilder({ includeContent: !args.noContent, window, nameUnread: named === 0 })
  let report: SessionFactsReport
  if (window !== undefined && named === 0) {
    // Every session modified since the window opened, newest first, parsed and
    // reduced to its facts one at a time: a week of sessions is gigabytes of
    // spans, and the sheet needs only one session's at once. A file last
    // written before `since` holds no record after it.
    const found = await discover(args)
    const unread = [...found.unread]
    const harnesses = new Set<string>()
    for (const { adapter, ref } of found.sessions) {
      let spans: OtlpSpan[]
      try {
        spans = await parseSession(adapter, ref, { taskScope: args.latestTurn ? 'latest' : 'all' })
      } catch (error) {
        unread.push({ sessionId: ref.sessionId, traceId: null, source: ref.path, reason: errorText(error) })
        continue
      }
      harnesses.add(adapter.harness)
      builder.add(spans)
    }
    for (const entry of unread) builder.addUnread(entry)
    warnUnread(args, unread)
    report = { ...builder.build(), harness: [...harnesses].join('+') || (args.harnessExplicit ? args.harness : null) }
  } else {
    const collected = await collectSpans(args)
    if (collected.spans.length === 0 && (collected.unread ?? []).length === 0) throw new Error('no spans found for the given selection')
    warnIncompleteWorkflow(collected.workflow)
    builder.add(collected.spans)
    for (const entry of collected.unread ?? []) builder.addUnread(entry)
    report = { ...builder.build(), harness: collected.harness }
  }
  // A session that yielded no record spans was not read: only its root, and any
  // integrity receipt for the bytes that failed to parse. Printing a sheet of
  // zeros for it would state, in the sheet's own voice, that the session did
  // nothing — which is the one thing the sheet must never do. A sweep names
  // such a session in selection.unreadSessions instead.
  const unread = report.sessions.filter((facts) => facts.recordSpans === 0)
  if (unread.length > 0) {
    throw new RefError(
      `no records could be read from ${unread.length} selected session(s): ` +
        unread
          .map((facts) => `${facts.sessionId ?? facts.traceId} (${facts.unreadRecords.value ?? 0} unread record(s))`)
          .join(', ') +
        '. The facts sheet would state zeros the spans cannot support.',
      'unreadable',
    )
  }
  const rendered = format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderSessionFacts(report)
  if (args.out) {
    await writeFile(args.out, rendered, 'utf8')
    console.log(`session facts → ${args.out}  (${report.sessions.length} session(s), $0, no model call)`)
    return
  }
  process.stdout.write(rendered)
}

async function cmdAnalyze(args: CliArgs): Promise<void> {
  // A Runtime run directory, or a directory of them, is a supervision tree.
  const runDir = args.selection?.spans.find((source) => source.kind === 'run-dir')
  if (runDir) {
    if (args.refs.length > 1) throw new UsageError(`analyze reports one supervision tree at a time; ${runDir.ref} is a run directory`)
    return cmdAnalyzeSupervisorRun(runDir.path, args)
  }
  const result = await investigate(args)
  if (args.out) {
    await saveReport(args.out, result.report)
    console.log(
      `report → ${args.out}  (${result.findings.length} findings, ` +
        `${result.pipelines.stuckLoops.findings.length} loops, OTLP: ${result.otlpPath})`,
    )
  } else {
    console.log(result.report)
  }
  failUnlessRequestedAnalysesRan(args, result)
}

/**
 * Supervision-tree view: what the TREE did (steers, spawn waves, concurrency,
 * idle wall, cost by role, accepted vs rejected), as opposed to the rest of
 * this CLI, which reports what happened inside one harness session.
 *
 * Eval owns Runtime run discovery and analysis. Traces adds coordination-log
 * evidence through its reader, then prints a single report or a rollup.
 */
async function cmdAnalyzeSupervisorRun(runDir: string, args: CliArgs): Promise<void> {
  const single = await isRuntimeSupervisorRunDir(runDir)
  const runDirs = single ? [runDir] : await findSupervisorRunDirs(runDir)
  if (runDirs.length === 0) {
    throw new Error(
      `no supervisor run found at ${runDir} — expected a Runtime run containing ` +
        'spawn-journal.jsonl, observer.jsonl, or failure.json, or a parent directory containing such runs',
    )
  }
  const reports = await Promise.all(
    runDirs.map((dir) => analyzeSupervisorRun(fileRunContextSupervisorRunReader(dir))),
  )
  const markdown = single
    ? renderSupervisorRunMarkdown(reports[0]!)
    : renderSupervisorRollupMarkdown(rollupSupervisorRuns(reports), `Supervisor rollup — ${runDir}`)
  if (args.out) {
    await saveReport(args.out, markdown)
    console.log(`supervisor report → ${args.out}  (${runDirs.length === 1 ? '1 run' : `${runDirs.length} runs`})`)
  } else {
    console.log(markdown)
  }
}

async function collectImportedSpans(
  path: string,
  format: TraceEvidenceFormatOption,
  selector?: string,
): Promise<CollectedSpans> {
  const result = await exportTraceEvidenceFile(path, { format })
  const spans = selector ? selectSpans(result.spans, selector, path) : result.spans
  const { sessionByTrace } = indexSessionIdsByTrace(spans)
  const sessions = new Map<string, OtlpSpan[]>()
  for (const span of spans) {
    const sessionId = sessionByTrace.get(span.trace_id)
    if (!sessionId) continue
    const grouped = sessions.get(sessionId) ?? []
    grouped.push(span)
    sessions.set(sessionId, grouped)
  }
  return {
    spans,
    harness: result.format,
    cwds: [],
    sources: [...sessions].map(([sessionId, grouped]) => sessionReportSource({
      harness: result.format,
      sessionId,
      path,
      cwd: null,
      mtimeMs: 0,
    }, grouped, sessionId)),
  }
}

/**
 * Analyst progress log for stderr. The registry's `[analyst] FAIL <id>` line
 * carries its reason only in the structured fields; a message-only sink turns
 * every engine-startup failure into an unactionable one-liner.
 */
function analystLog(msg: string, fields?: Record<string, unknown>): void {
  // A gate rejection names its cause only in the fields; without them the
  // line says a finding was dropped but not why, which nobody can act on.
  const rejection = findingRejectionDetail(msg, fields)
  if (rejection !== undefined) {
    process.stderr.write(rejection ? `${msg} — ${rejection}\n` : `${msg}\n`)
    return
  }
  const error = typeof fields?.error === 'string' && fields.error ? fields.error : undefined
  const errorClass = typeof fields?.error_class === 'string' && fields.error_class ? `${fields.error_class}: ` : ''
  process.stderr.write(error ? `${msg} — ${errorClass}${error}\n` : `${msg}\n`)
}

/** Conformance fields threaded from the source into the investigation options. */
function conformanceOptions(collected: CollectedSpans) {
  return {
    ...(collected.conformance ? { conformance: collected.conformance } : {}),
    ...(collected.conformanceSubject ? { conformanceSubject: collected.conformanceSubject } : {}),
    ...(collected.conformanceFiles ? { conformanceFiles: collected.conformanceFiles } : {}),
    ...(collected.conformanceSkipped ? { conformanceSkipped: collected.conformanceSkipped } : {}),
    ...(collected.conformanceIssues ? { conformanceIssues: collected.conformanceIssues } : {}),
    ...(collected.conformanceWithheld ? { conformanceWithheld: collected.conformanceWithheld } : {}),
    ...(collected.conformanceUnreadable ? { conformanceUnreadable: collected.conformanceUnreadable } : {}),
  }
}

/** The analyze run: a traces config is loaded only when `--config` names one. */
async function investigate(args: CliArgs) {
  const collected = await collectSpans(args)
  const { spans, harness, cwds, sources, workflow } = collected
  if (spans.length === 0) throw new Error('no spans found for the given selection')
  const config = args.config !== undefined ? await loadTracesConfig(args.config) : undefined
  const analystModel = analystModelFor(args)
  const engine = args.llm ? llmAnalysisEngine(args, analystModel) : undefined
  return runTraceInvestigation(mergeTracesConfig({
    spans,
    harness,
    sources,
    workflow,
    cwds,
    engine,
    model: args.llm ? analystModel : args.model,
    budgetUsd: args.budget,
    log: analystLog,
    ...conformanceOptions(collected),
  }, config))
}

/** `traces improve` (hidden; `analyze --out DIR` in 1.0): the review packet, written to `--dir`. */
async function cmdImprove(args: CliArgs): Promise<void> {
  const collected = await collectSpans(args)
  const { spans, harness, cwds, sources, workflow } = collected
  if (spans.length === 0) throw new Error('no spans found for the given selection')
  const config = await loadTracesConfig(args.config)
  const analystModel = analystModelFor(args)
  const engine = args.llm ? llmAnalysisEngine(args, analystModel) : undefined
  const result = await runTraceImprovement({
    ...mergeTracesConfig({
      spans,
      harness,
      sources,
      workflow,
      cwds,
      engine,
      model: args.llm ? analystModel : args.model,
      budgetUsd: args.budget,
      log: analystLog,
      ...conformanceOptions(collected),
    }, config),
    outDir: args.dir ?? args.out,
  })
  const dir = result.artifacts?.directory
  if (!dir) throw new Error('improve did not produce an artifact directory')
  console.log(
    `improvement artifacts → ${dir}  ` +
      `(${result.findings.length} findings with actions and checks, OTLP: ${result.otlpPath})`,
  )
  failUnlessRequestedAnalysesRan(args, result)
}

/**
 * `traces ask`: free-form questions over the selected sessions. Every question
 * is its own recursive investigation; they run concurrently under one shared
 * ledger, so `--budget` bounds the whole run and each question's ceiling is
 * the smaller of it and the per-question default. The answers, their citation
 * checks, and per-question cost and time are written before the exit code is
 * decided, so a failed question never costs the others' answers. Ctrl-C is
 * one of those failures: `runTraceQuestions` records it on the questions the
 * run never reached and still returns, so the artifacts below are written for
 * the answers already paid for.
 */
async function cmdAsk(args: CliArgs): Promise<void> {
  const questions: TraceQuestion[] = [
    ...(args.questionsFile ? await loadTraceQuestionsFile(args.questionsFile) : []),
    ...args.questions.map((question) => ({ question })),
  ]
  if (questions.length === 0) {
    throw new UsageError('ask needs --question "<text>" (repeatable) or --questions <questions.json>')
  }
  // Reject a bad question before any session is parsed or process started.
  normalizeTraceQuestions(questions)
  const questionTimeoutMs = args.questionTimeout === undefined ? undefined : Math.round(args.questionTimeout * 1000)
  // Before the adapter pass: a missing API key must not cost an operator the
  // wait for a large session to be parsed before it is reported.
  const engine = analysisEngineFromEnv({
    model: analystModelFor(args),
    maxCostUsd: args.questionBudget ?? Math.min(args.budget ?? Infinity, DEFAULT_QUESTION_MAX_COST_USD),
    ...(questionTimeoutMs !== undefined ? { timeoutMs: questionTimeoutMs } : {}),
    log: analystLog,
  })
  const collected = await collectSpans(args)
  if (collected.spans.length === 0) throw new Error('no spans found for the given selection')
  warnIncompleteWorkflow(collected.workflow)
  const directory = resolve(args.dir ?? await mkdtemp(join(tmpdir(), 'traces-ask-')))
  await mkdir(directory, { recursive: true })
  const controller = new AbortController()
  const interrupt = () => controller.abort(new Error('ask interrupted'))
  process.once('SIGINT', interrupt)
  let result: TraceQuestionsResult
  try {
    result = await runTraceQuestions({
      questions,
      spans: collected.spans,
      engine,
      harness: collected.harness,
      concurrency: args.concurrency,
      ...(args.budget !== undefined ? { budgetUsd: args.budget } : {}),
      otlpOutPath: join(directory, 'traces.otlp.jsonl'),
      signal: controller.signal,
      log: analystLog,
    })
  } finally {
    process.removeListener('SIGINT', interrupt)
  }
  const artifacts = await writeTraceQuestionsArtifacts(result, directory)
  process.stdout.write(result.report)
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`)
  process.stderr.write(
    `ask artifacts → ${artifacts.directory}  (${result.totals.answered}/${result.totals.questions} answered, ` +
      `wall ${(result.totals.wallTimeMs / 1000).toFixed(1)} s, answers: ${artifacts.result})\n`,
  )
  if (result.ok) return
  const failed = result.questions.filter((answer) => answer.status === 'failed')
  const lines = [
    `${failed.length} of ${result.questions.length} question(s) failed; the answers file holds every result.`,
    ...failed.map((answer) => `  ${answer.id}: ${answer.failure?.kind}: ${answer.failure?.message.slice(0, 300)}`),
  ]
  // Any kind, not only `error`: the hint is decided by the message, and a
  // mismatch that also exhausted the budget still needs the reinstall line.
  if (failed.some((answer) => isBridgeMismatchError(answer.failure?.message ?? ''))) {
    lines.push(
      'hint: the DSPy bridge protocol is version-locked — the TRACES_PYTHON interpreter needs ' +
        `agent-eval-rpc[dspy]==${requiredBridgeVersion()} (matching this package's @tangle-network/agent-eval).`,
    )
  }
  process.stderr.write(`error: ${lines.join('\n')}\n`)
  process.exitCode = 1
}

function summarizeFindingEvidence(finding: TraceLiveFinding): string {
  const first = finding.evidence[0]
  if (!first) return 'no evidence'
  return `${first.label}: ${first.value}`
}

function formatLiveFinding(finding: TraceLiveFinding): string {
  const ts = new Date(finding.observedAt).toISOString().slice(11, 19)
  const where = `[${finding.session.harness}] ${finding.session.sessionId.slice(0, 8)}`
  const cwd = finding.session.cwd ? ` · ${finding.session.cwd}` : ''
  return [
    `${ts} ${finding.severity.toUpperCase()} ${where}: ${finding.title}${cwd}`,
    `  evidence: ${summarizeFindingEvidence(finding)}`,
    `  action: ${finding.action}`,
    `  check: ${finding.check}`,
  ].join('\n')
}

type StreamMode = 'visualizer' | 'findings' | 'agent'

function streamMode(raw: string | undefined): StreamMode {
  if (raw === undefined) return 'visualizer'
  if (raw === 'visualizer' || raw === 'findings' || raw === 'agent') return raw
  throw new UsageError(`unknown stream mode "${raw}" (expected visualizer, findings, or agent)`)
}

function streamPreset(args: CliArgs): { mode: StreamMode; includeSpans: boolean; includeFindings: boolean; includeBatches: boolean; includeReports: boolean } {
  const mode = streamMode(args.mode)
  return {
    mode,
    includeSpans: !args.noSpans && mode === 'visualizer',
    includeFindings: !args.noFindings,
    includeBatches: true,
    includeReports: mode === 'agent',
  }
}

async function streamExplicitSession(
  args: CliArgs,
  extraAnalysts: readonly TraceLiveAnalyst[] | undefined,
  { adapter, ref }: RefSelection['sessions'][number],
): Promise<void> {
  const preset = streamPreset(args)
  const spans = await parseSession(adapter, ref)
  for (const event of traceStreamEventsFromSpans(spans, {
    ref,
    includeSpans: preset.includeSpans,
    includeFindings: preset.includeFindings,
    extraAnalysts,
  })) {
    process.stdout.write(serializeTraceStreamEvent(event))
  }
}

/** `traces stream` (hidden; `watch --format jsonl` in 1.0): live trace events as JSONL. */
async function cmdStream(args: CliArgs): Promise<void> {
  const config = await loadTracesConfig(args.config)
  const preset = streamPreset(args)
  const named = args.selection
  if (named && named.sessions.length + named.spans.length > 1) throw new UsageError('stream reads one ref at a time')
  const source = named?.spans[0]?.path
  if (source) {
    const { spans, harness } = await collectSpans(args)
    const ref: SessionRef = {
      harness,
      sessionId: basename(source),
      path: resolve(source),
      cwd: args.cwd ?? null,
      mtimeMs: Date.now(),
    }
    for (const event of traceStreamEventsFromSpans(spans, {
      ref,
      includeSpans: preset.includeSpans,
      includeFindings: preset.includeFindings,
      extraAnalysts: config?.liveAnalysts,
    })) {
      process.stdout.write(serializeTraceStreamEvent(event))
    }
    return
  }
  if (named?.sessions[0]) {
    await streamExplicitSession(args, config?.liveAnalysts, named.sessions[0])
    return
  }

  const all = !args.harnessExplicit
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  if (!args.replay) {
    process.stderr.write(
      `traces stream: ${preset.mode} JSONL feed for ${all ? 'all harnesses' : args.harness}, ` +
        `last ${args.window}m, every ${args.interval}s. Ctrl-C to stop.\n`,
    )
  }
  await streamSessions({
    all,
    harnesses: all ? undefined : [args.harness],
    // A store root reads every harness that reads one (--harness narrows).
    ...(named?.home !== undefined ? { adapters: adaptersFor(args), home: named.home } : {}),
    cwd: args.cwd,
    last: args.last > 0 ? args.last : args.replay ? 1 : undefined,
    windowMs: args.window * 60_000,
    intervalMs: args.interval * 1000,
    once: args.replay,
    includeSpans: preset.includeSpans,
    includeFindings: preset.includeFindings,
    includeBatches: preset.includeBatches,
    includeReports: preset.includeReports,
    extraAnalysts: config?.liveAnalysts,
    signal: controller.signal,
    onEvent: (event) => {
      process.stdout.write(serializeTraceStreamEvent(event))
    },
    onError: (err, ref) => {
      const where = ref ? ` [${ref.harness}] ${ref.sessionId}` : ''
      process.stderr.write(`stream error${where}: ${err instanceof Error ? err.message : String(err)}\n`)
    },
  })
}

/**
 * Two watches share one verb because they answer the same question one level
 * apart: `traces watch` (no path) tails live HARNESS SESSIONS, and
 * `traces watch <target>` tails one RUN TREE.
 */
async function cmdWatch(args: CliArgs): Promise<void> {
  if (args.input !== undefined) return cmdWatchRunTarget(args.input, args)
  if (args.once) throw new UsageError('watch --once prints one snapshot of a run: traces watch <run-dir|spans.otlp.jsonl> --once')
  const all = !args.harnessExplicit
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.stderr.write(
    `traces watch: observing ${all ? 'all harnesses' : args.harness}, ` +
      `sessions active in the last ${args.window}m, every ${args.interval}s. ` +
      `Loop + semantic live findings; read-only; Ctrl-C to stop.\n`,
  )
  await watchSessions({
    all,
    harnesses: all ? undefined : [args.harness],
    cwd: args.cwd,
    windowMs: args.window * 60_000,
    intervalMs: args.interval * 1000,
    signal: controller.signal,
    onLoop: (l) => {
      const ts = new Date().toISOString().slice(11, 19)
      process.stdout.write(
        `${ts} LOOP [${l.harness}] ${l.sessionId.slice(0, 8)}: ` +
          `\`${l.toolName}\` repeated ×${l.occurrences} with identical args ` +
          `(${(l.windowMs / 1000).toFixed(0)}s)${l.cwd ? ` · ${l.cwd}` : ''}\n`,
      )
    },
    onFinding: (finding) => {
      process.stdout.write(`${formatLiveFinding(finding)}\n`)
    },
  })
}

/**
 * Live view of one run tree. The target is an OTLP span file (the general
 * source, which works for any emitter), an agent-runtime `createFileRunContext`
 * directory (the specific source, which carries budget and settlement), or a
 * directory holding both. Read-only, plain stdout; `--once` prints a single
 * snapshot, which is what a script or an agent wants.
 */
async function cmdWatchRunTarget(dir: string, args: CliArgs): Promise<void> {
  const target = await resolveRunWatchTarget(resolve(dir))
  const controller = new AbortController()
  if (!args.once) {
    process.once('SIGINT', () => controller.abort())
    process.stderr.write(
      `traces watch: tailing ${target.requested} every ${args.intervalExplicit ? args.interval : 2}s; read-only, ` +
        `${target.runDir === null ? 'span source only — Ctrl-C to stop' : 'stops when result.json lands. Ctrl-C to stop'}.\n`,
    )
  }
  const snapshot = await watchRunTarget(target, {
    once: args.once,
    // A tree view wants a tighter poll than the session observer's 5s default:
    // a blocking question is worth surfacing the moment it lands.
    intervalMs: args.intervalExplicit ? Math.max(250, args.interval * 1000) : 2000,
    signal: controller.signal,
  })
  // A terminal run that ended badly should not look like a success to a script.
  const result = snapshot.journal?.result ?? null
  if (result !== null && result.errorMessage !== null) process.exitCode = 1
}

/**
 * The sessions upload's refs name, read. A span file is one upload item per
 * run in it, keyed by its session id (or its trace id when it records none).
 */
async function* refSessions(args: CliArgs): AsyncGenerator<{ ref: SessionRef; spans: OtlpSpan[] }> {
  const named = args.selection
  if (!named) return
  for (const { adapter, ref } of named.sessions) yield { ref, spans: await parseSession(adapter, ref) }
  for (const source of named.spans) {
    const collected = source.kind === 'spans' && source.reader !== 'otlp'
      ? await collectImportedSpans(source.path, source.reader, source.selector)
      : await collectOtlpSpans(source.path, source.kind === 'spans' ? source.selector : undefined)
    const mtimeMs = (await stat(source.path)).mtimeMs
    const byTrace = new Map<string, OtlpSpan[]>()
    for (const span of collected.spans) {
      const grouped = byTrace.get(span.trace_id)
      if (grouped) grouped.push(span)
      else byTrace.set(span.trace_id, [span])
    }
    for (const [traceId, spans] of byTrace) {
      const { sessionByTrace } = indexSessionIdsByTrace(spans)
      const ref: SessionRef = {
        harness: collected.harness,
        sessionId: sessionByTrace.get(traceId) ?? traceId,
        path: source.path,
        cwd: args.cwd ?? null,
        mtimeMs,
      }
      yield { ref, spans }
    }
  }
}

/** `traces upload`: redact, gate on share safety, and send. A ref or `--since` is required (the table says so). */
async function cmdUpload(args: CliArgs): Promise<void> {
  const named = args.selection
  const fromRefs = named !== undefined && named.sessions.length + named.spans.length > 0
  if (!fromRefs && args.since === undefined) {
    throw new UsageError(`upload over a store root needs a window: traces upload ${named?.home ?? '<store-root>'} --since 24h`)
  }
  const sinceMs = fromRefs ? undefined : parseSince(args.since!)
  const all = !args.harnessExplicit
  // A window is a sweep: a session that cannot be read is skipped and named.
  const unread: UnreadSessionFact[] = []
  const plan: UploadPlan = fromRefs
    ? await planUploadFrom(refSessions(args))
    : await planUpload({
        ...(named?.home !== undefined
          ? { adapters: adaptersFor(args), home: named.home }
          : { all, harnesses: args.harnessExplicit ? [args.harness] : undefined }),
        cwd: args.cwd,
        sinceMs,
        onError: (error, ref) => {
          unread.push({ sessionId: ref?.sessionId ?? null, traceId: null, source: ref?.path ?? null, reason: errorText(error) })
        },
      })
  warnUnread(args, unread)

  const candidates = plan.items
  const byDetector: Record<string, number> = {}
  let totalRedactions = 0
  for (const i of candidates) {
    totalRedactions += i.redaction.redactionCount
    for (const [r, n] of Object.entries(i.redaction.byDetector)) byDetector[r] = (byDetector[r] ?? 0) + n
  }

  const w = (s: string) => process.stderr.write(s)
  w(sinceMs === undefined ? `\nRefs: ${args.refs.join(' ')}\n` : `\nWindow: since ${new Date(sinceMs).toISOString()}\n`)
  w(`Sessions found: ${plan.items.length}  ·  final privacy-mode dedup runs before upload\n`)
  w(`PII/secrets redacted: ${totalRedactions}${Object.keys(byDetector).length ? ` (${Object.entries(byDetector).map(([r, n]) => `${r}:${n}`).join(', ')})` : ''}\n`)
  for (const i of candidates.slice(0, 25)) {
    w(`  + [${i.ref.harness}] ${i.ref.sessionId.slice(0, 8)}  ${i.spans.length} spans  ${i.redaction.redactionCount} redacted  ${i.ref.cwd ?? ''}\n`)
  }
  if (candidates.length > 25) w(`  … and ${candidates.length - 25} more\n`)

  if (candidates.length === 0) {
    console.log('No sessions found to upload.')
    return
  }

  if (args.dryRun) {
    const res = await executeUpload(plan, { dryRun: true, otlpOut: args.out, stripContent: args.noContent })
    reportRefused(res.refused)
    console.log(`dry run: ${candidates.length - res.skippedSessions - res.refused.length} session(s), ${totalRedactions} redaction(s). Redacted OTLP -> ${res.otlpPath}`)
    console.log('No upload performed. Set TANGLE_INGEST_URL / TANGLE_INGEST_API_KEY / TANGLE_TENANT_ID and drop --dry-run to send.')
    return
  }

  if (!args.yes) {
    const ok = await confirm(`Process ${candidates.length} redacted session(s) for upload to the Tangle Intelligence Platform?`)
    if (!ok) {
      console.log('Aborted (use --yes to skip the prompt, or --dry-run to preview).')
      return
    }
  }

  const res = await executeUpload(plan, { log: (m) => w(`${m}\n`), stripContent: args.noContent })
  reportRefused(res.refused)
  console.log(
    `Uploaded ${res.uploadedSessions} session(s), ${res.acceptedSpans} spans accepted, ` +
      `${res.redactionCount} redaction(s); ${res.skippedSessions} already-uploaded skipped; ${res.refused.length} refused.`,
  )
}

/** Print each refused session with its verdict (detectors and paths, never values); exit 1 when any. */
function reportRefused(refused: readonly RefusedSession[]): void {
  for (const { harness, sessionId, verdict } of refused) {
    process.stderr.write(`  REFUSED [${harness}] ${sessionId.slice(0, 8)}: ${verdict.status}\n`)
    for (const finding of verdict.findings.filter((f) => f.severity === 'error')) {
      process.stderr.write(`    ${finding.category}/${finding.detector} x${finding.count} at ${finding.paths.join(', ')}\n`)
    }
    for (const entry of verdict.unreadable) process.stderr.write(`    unread ${entry}\n`)
  }
  if (refused.length > 0) {
    process.stderr.write(`${refused.length} session(s) refused by the share-safety check and kept on this machine.\n`)
    process.exitCode = 1
  }
}

/**
 * `traces verify-safe <file|dir>` (hidden; `check --share-safe` in 1.0): the
 * share-safety verdict for files, read-only. Exit 0 SAFE or
 * SAFE_WITH_WARNINGS, 1 UNSAFE, 2 UNKNOWN.
 */
async function cmdVerifySafe(args: CliArgs): Promise<void> {
  const profile = args.profile ?? 'share'
  if (profile !== 'default' && profile !== 'share' && profile !== 'strict') {
    throw new UsageError(`verify-safe: --profile must be default, share or strict, got "${profile}"`)
  }
  const knownSecrets = args.knownSecretEnvs.map((name) => {
    const value = process.env[name]
    if (!value) throw new UsageError(`verify-safe: environment variable ${name || '(missing name)'} is not set`)
    return value
  })
  const result = await verifySafe(args.input!, { profile, knownSecrets })
  process.stdout.write(args.format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : `${formatVerdict(result)}\n`)
  process.exitCode = verdictExitCode(result)
}

/** `traces skills`: skill use across Claude Code, Codex and Kimi Code sessions, incrementally, with no model call. */
async function cmdSkills(args: CliArgs): Promise<void> {
  if (args.store === '') throw new UsageError('skills: --store needs a path')
  const since = args.since === undefined ? undefined : parseSince(args.since)
  const storePath = args.store ?? defaultSkillUsageStorePath()
  const store = await SkillUsageStore.load(storePath)
  const refreshed = args.noRefresh ? null : await store.refresh()
  if (refreshed) await store.save()
  const report = buildSkillUsageReport(store.list(), await readInstalledSkills(), storePath, {
    since,
    sweepThreshold: args.sweep ?? DEFAULT_SWEEP_THRESHOLD,
    refresh: refreshed,
  })
  const json = args.format === 'json'
  if (args.unused) {
    if (json) process.stdout.write(`${JSON.stringify(report.unused, null, 2)}\n`)
    else for (const skill of report.unused) process.stdout.write(`${skill.skill}\t${skill.installedIn.join(',')}\n`)
    return
  }
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderSkillUsage(report)}\n`)
}

/** `--current` named as a ref, and `--latest-turn` checked against the harness. */
function prepare(args: Args): CliArgs {
  return validateLatestTurn(applyCurrentSessionSelection(args))
}

/** A command that reads its refs: they are resolved once, before it runs. */
function reading(handler: (args: CliArgs) => Promise<void>): Handler {
  return async (args) => handler(await withSelection(prepare(args)))
}

/**
 * Node 22 warns when `node:sqlite` first loads (the OpenCode store reader). The
 * warning is not this command's output, and on stderr it would break the
 * contract that an error under `--format json` is one JSON object there.
 */
// Node's exact text, so an unrelated warning that merely mentions SQLite still reaches stderr and listeners.
const NODE_SQLITE_WARNING = 'SQLite is an experimental feature and might change at any time'
const emitWarning = process.emitWarning.bind(process) as (warning: string | Error, ...rest: unknown[]) => void
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: unknown } | undefined)?.type
  const text = typeof warning === 'string' ? warning : warning.message
  if (type === 'ExperimentalWarning' && text === NODE_SQLITE_WARNING) return
  emitWarning(warning, ...rest)
}) as typeof process.emitWarning

await runTraces(process.argv.slice(2), {
  list: reading(cmdList),
  facts: reading(cmdFacts),
  analyze: reading(cmdAnalyze),
  ask: reading(cmdAsk),
  // check resolves its refs itself, after its contract loads: a bad contract
  // is reported before any trace is read, with check's own exit codes.
  check: async (args) => cmdCheck(prepare(args)),
  diff: cmdDiff,
  watch: cmdWatch,
  bundle: reading(cmdBundle),
  'bundle verify': cmdBundleVerify,
  convert: reading(cmdConvert),
  upload: reading(cmdUpload),
  skills: cmdSkills,
  mcp: reading(cmdMcp),
  validate: cmdValidate,
  'verify-safe': cmdVerifySafe,
  stream: reading(cmdStream),
  improve: reading(cmdImprove),
})
