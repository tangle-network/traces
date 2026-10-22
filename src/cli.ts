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

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { appendAll } from './arrays.js'
import { indexSessionIdsByTrace } from './attributes.js'
import { findingRejectionDetail } from './finding-rejections.js'
import { type TraceEvidenceFormatOption, exportTraceEvidenceFile } from './file-export.js'
import { metadataOnly } from './metadata-only.js'
import { shellWord } from './moved.js'
import type { TraceStreamEvent, WatchedSession } from './live.js'
import type { TraceLiveFinding } from './pipelines.js'
import { DEFAULT_ANALYST_MODEL, DEFAULT_ASK_CONCURRENCY, DEFAULT_QUESTION_MAX_COST_USD, DEFAULT_QUESTION_TIMEOUT_MS } from './ask-defaults.js'
import type { TraceQuestion, TraceQuestionsResult } from './ask.js'
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
  createSessionFactsReportBuilder,
  matchRows,
  priceReport,
  renderSessionFacts,
  sessionMatches,
  type SessionFactsReport,
  type SessionFactsWindow,
  type SessionMatch,
  type SessionReading,
  type UnreadSessionFact,
} from './session-facts.js'
import { turnFactsJsonl, type TurnSource } from './facts-jsonl.js'
import { callIdsOf, citeFacts, type RecordLine, type SessionCiting } from './record-lines.js'
import { sessionIdentityLookup } from './session-identity.js'
import { conformanceOfSpans, renderValidation } from './conformance.js'
import type { TraceValidation } from '@tangle-network/agent-trace-contract'
import { listAdapters, resolveAdapter, selectAdapters } from './registry.js'
import { locateSessions, parseSession, readSessionSpans, sessionsInCwd } from './session-source.js'
import { collectSessionSelection, type SessionSelection } from './session-selection.js'
import {
  type SessionWorkflowIssue,
  type SessionWorkflowSummary,
} from './session-workflow.js'
import { assembleSessionBundle, verifySessionBundle } from './bundle.js'
import type { ReportSource } from './report.js'
import { parseSince, parseTimeBound, relativeBoundMs } from './time.js'
import { readsStoreRoots } from './adapters/harness-sessions.js'
import { RefError, resolveRefs, selectSpans, shortestRefs, type ResolvedRef } from './refs.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'
import type { RefusedSession, UploadPlan } from './upload.js'
import {
  buildSkillUsageReport,
  defaultSkillUsageStorePath,
  readInstalledSkills,
  renderSkillUsage,
  SkillUsageStore,
} from './skill-usage.js'
import { type Args, CliError, type Handler, runTraces, UsageError, writeError } from './commands.js'
import { type IndexedSession, TurnIndex } from './turn-index.js'

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

function analystModelFor(args: CliArgs): string {
  return args.model ?? process.env.TRACES_ANALYST_MODEL ?? DEFAULT_ANALYST_MODEL
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

/** A session as the turn index holds it, as a list row. */
async function listRow(adapter: HarnessTraceAdapter, ref: SessionRef, shortRef: string, session: IndexedSession): Promise<ListRow> {
  const first = session.firstAt
  const last = session.lastAt
  let bytes: number | null = null
  try {
    bytes = (await stat(ref.path)).size
  } catch {
    // A store that moved between locate and read has no size to report.
  }
  return {
    ref: shortRef,
    id: ref.sessionId,
    harness: adapter.harness,
    path: ref.path,
    bytes,
    parentSessionId: session.parentSessionId,
    lastActivity: last ?? new Date(ref.mtimeMs).toISOString(),
    durationMs: first !== null && last !== null ? Date.parse(last) - Date.parse(first) : null,
    humanTurns: session.humanTurns.length,
    cwd: session.cwd ?? ref.cwd,
    firstPrompt: session.firstPrompt === null ? null : oneLine(session.firstPrompt, PROMPT_CHARS),
  }
}

/**
 * `traces list`: one row per session, newest first, across every harness.
 * `--last 20` by default, never the caller's own session; `--since` lists
 * every session active in the window. Rows come from the turn index, so a
 * warm run reads only what the listed sessions appended. A session that
 * cannot be read is counted in the footer and named in the JSON's
 * `selection.unreadSessions`.
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
  const stats = await TurnIndex.with(async (index) => {
    const refreshed = await index.refresh(found.sessions)
    for (const { adapter, ref } of found.sessions) {
      const held = index.session(adapter, ref)
      if (!held || held.unread !== null) {
        unread.push({ sessionId: ref.sessionId, traceId: null, source: ref.path, reason: held?.unread ?? 'not indexed' })
        continue
      }
      rows.push(await listRow(adapter, ref, shortRefs.get(ref.sessionId) ?? ref.sessionId, held.session))
    }
    return refreshed
  })
  warnUnread(args, unread, 'list')
  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify({ sessions: rows, selection: { unreadSessions: unread, index: stats } }, null, 2)}\n`)
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
  const { sessionReportSource } = await import('./report.js')
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
        `${input.issues.length} unusable). Run \`traces check ${path} --contract conformance\` for the per-finding reason.`,
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
  const sources: SelectedSessionSource[] = []
  const unread: UnreadSessionFact[] = []
  const workflows = parts.flatMap((part) => (part.workflow ? [part.workflow] : []))
  for (const part of parts) {
    appendAll(spans, part.spans)
    appendAll(sources, part.sources)
    appendAll(unread, part.unread ?? [])
  }
  return {
    spans,
    harness: [...new Set(parts.flatMap((part) => part.harness.split('+')))].join('+'),
    sources,
    ...(workflows[0] ? { workflow: workflows[0] } : {}),
    ...(unread.length > 0 ? { unread } : {}),
  }
}

/** Spans of the selected harness sessions: refs, `--current`, or discovery. */
async function collectSessionSpans(args: CliArgs): Promise<CollectedSpans> {
  const { sessionReportSource } = await import('./report.js')
  const selection = await collectSessionRows(args, args.last || 1)
  const spans: OtlpSpan[] = []
  const harnesses = new Set<string>()
  const sources: SelectedSessionSource[] = []
  for (const row of selection.rows) {
    harnesses.add(row.adapter.harness)
    appendAll(spans, row.spans)
    sources.push(sessionReportSource(row.ref, row.spans))
  }
  return {
    spans,
    harness: [...harnesses].join('+') || (args.harnessExplicit ? args.harness : 'none'),
    sources,
    ...(selection.workflow ? { workflow: selection.workflow } : {}),
    ...(selection.unread.length > 0 ? { unread: selection.unread } : {}),
  }
}

/**
 * `traces check`, the one gate: each `--contract` file, the built-in
 * `--contract conformance`, and `--share-safe` decide on their own, and the
 * check exits 1 if any fails, else 2 if any could not decide, else 0. The
 * verdict always goes to stdout in `--format`, because CI reads it; evidence
 * for each gate that did not pass goes under `--out DIR`, and without it
 * nothing is written. Contracts load before any trace is read, so a bad
 * contract exits 2 at once; `--share-safe` alone never reads a ref as a trace.
 */
async function cmdCheck(args: CliArgs): Promise<void> {
  const check = await import('./check.js')
  const { explainTraceContract } = await import('@tangle-network/agent-eval')
  const contracts = new Map<string, Awaited<ReturnType<typeof check.loadContract>>>()
  for (const path of args.contracts) {
    if (path === check.CONFORMANCE || contracts.has(path)) continue
    try {
      contracts.set(path, await check.loadContract(path))
    } catch (error) {
      throw new UsageError(errorText(error))
    }
  }
  for (const loaded of contracts.values()) for (const warning of loaded.warnings) process.stderr.write(`warning: ${warning}\n`)
  const traceGates = args.contracts.length > 0
  const selected = args.refs.length > 0 || args.current || args.last > 0 || args.since !== undefined
  if (traceGates && !selected && !args.shareSafe) {
    const explained = args.contracts.map((path) => {
      const loaded = contracts.get(path)
      return loaded
        ? { contract: loaded.contract.name, text: explainTraceContract(loaded.contract) }
        : { contract: check.CONFORMANCE, text: check.CONFORMANCE_EXPLAINED }
    })
    process.stdout.write(args.format === 'json'
      ? `${JSON.stringify({ explain: explained }, null, 2)}\n`
      : `${explained.map((entry) => entry.text).join('\n\n')}\n`)
    return
  }
  const gates: Parameters<typeof check.combineGates>[0][number][] = []
  if (traceGates) {
    const resolved = await withSelection(args)
    const sources = resolved.selection?.spans ?? []
    // OTLP refs are graded on the rows their producer wrote, and a file that is
    // not a trace fails conformance rather than going unread.
    const otlpOnly = resolved.selection !== undefined && resolved.selection.sessions.length === 0 &&
      resolved.selection.home === undefined && sources.every((source) => source.kind === 'run-dir' || source.reader === 'otlp')
    let run: CollectedSpans | undefined
    const runSpans = async (): Promise<CollectedSpans> => {
      if (run) return run
      try {
        run = await collectSpans(resolved)
      } catch (error) {
        if (error instanceof RefError || error instanceof CliError) throw error
        throw new CliError(errorText(error), error instanceof check.AmbiguousTraceInputError ? 'ambiguous' : 'unreadable')
      }
      if (run.spans.length === 0) throw new CliError('the trace holds no spans', 'unreadable')
      return run
    }
    for (const path of args.contracts) {
      if (path !== check.CONFORMANCE) {
        const report = await check.runCheck(contracts.get(path)!.contract, (await runSpans()).spans, args.out === undefined ? {} : { evidenceRoot: args.out })
        gates.push(check.contractGate(report))
      } else if (otlpOnly) {
        for (const source of sources) gates.push(await otlpConformanceGate(check, source.ref, source.path))
      } else {
        const { spans } = await runSpans()
        const subject = args.refs.length > 0 ? args.refs.join(' ') : 'the selected sessions'
        const validation = conformanceOfSpans(spans)
        gates.push(check.conformanceGate(subject, validation, renderValidation(validation, { subject, spans })))
      }
    }
  }
  if (args.shareSafe) {
    const { verifySafe } = await import('./verify-safe.js')
    const knownSecrets = args.knownSecretEnvs.map((name) => {
      const value = process.env[name]
      if (!value) throw new UsageError(`--known-secret-env ${name || '(missing name)'}: that environment variable is not set`)
      return value
    })
    for (const path of args.refs) gates.push(check.shareSafeGate(await verifySafe(path, { knownSecrets })))
  }
  const verdict = check.combineGates(gates)
  if (args.out !== undefined) await check.writeGateEvidence(args.out, verdict)
  const output = args.format === 'json'
    ? JSON.stringify(verdict, null, 2)
    : args.format === 'junit'
      ? check.renderVerdictJUnit(verdict).trimEnd()
      : args.format === 'github' ? check.renderVerdictGithub(verdict) : check.renderVerdictText(verdict)
  if (output) process.stdout.write(`${output}\n`)
  if (verdict.exitCode === check.CHECK_EXIT.couldNotDecide) {
    const undecided = verdict.gates.filter((gate) => gate.status === 'unknown').map((gate) => gate.gate)
    writeError(`${undecided.join(', ')} could not decide; the verdict on stdout says why`, 'unknown-verdict', args.format === 'json')
  }
  process.exitCode = verdict.exitCode
}

/** Conformance of one OTLP ref, graded on the rows its producer wrote. Only a missing file or directory cannot be graded. */
async function otlpConformanceGate(check: typeof import('./check.js'), subject: string, path: string) {
  let input: Awaited<ReturnType<typeof readOtlpInput>>
  try {
    input = await readOtlpInput(path)
  } catch (error) {
    throw new CliError(errorText(error), 'unreadable')
  }
  const text = renderValidation(input.validation, {
    subject,
    files: input.files,
    skipped: input.skipped,
    issues: input.issues,
    withheld: input.withheld,
    unreadable: input.unreadable,
    spans: input.spans,
  })
  return check.conformanceGate(subject, input.validation, text)
}

/**
 * `traces convert`: contract OTLP-JSONL to `--out`, or to stdout. With
 * `--no-content` the spans go through the metadata-only rule first, and the
 * summary names every attribute key it removed.
 */
async function cmdConvert(args: CliArgs): Promise<void> {
  const collected = await collectSpans(args)
  if (collected.spans.length === 0) throw new Error('no spans found for the given selection')
  warnIncompleteWorkflow(collected.workflow)
  const { spans, dropped } = args.noContent ? metadataOnly(collected.spans) : { spans: collected.spans, dropped: [] }
  if (args.out === undefined) {
    // Streamed line by line: a conversion can outgrow V8's maximum string length.
    for (const line of iterSerializedSpans(spans)) process.stdout.write(line)
    return
  }
  const out = await writeOtlpFile(spans, args.out)
  console.log(args.format === 'json'
    ? JSON.stringify({ out, spans: spans.length, droppedAttributes: dropped })
    : `wrote ${spans.length} spans → ${out}${args.noContent ? ` (metadata only: ${dropped.length} attribute key(s) dropped)` : ''}`)
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

/** Issues the incomplete-workflow warning names; the rest are counted. */
const WORKFLOW_ISSUES_NAMED = 3

function warnIncompleteWorkflow(workflow: SessionWorkflowSummary | undefined): void {
  if (!workflow || workflow.complete) return
  const { issues } = workflow
  const more = issues.length - WORKFLOW_ISSUES_NAMED
  process.stderr.write(
    `warning: session workflow is incomplete (${issues.length} issue(s)): ` +
      `${issues.slice(0, WORKFLOW_ISSUES_NAMED).map(workflowIssueText).join('; ')}${more > 0 ? `; and ${more} more` : ''}\n`,
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
  const { serveTraceMcp } = await import('./mcp.js')
  const collected = await collectSpans(args)
  if (collected.spans.length === 0) throw new Error('mcp: no spans found for the given selection')
  warnIncompleteWorkflow(collected.workflow)
  process.stderr.write(`traces mcp: serving ${collected.spans.length} span(s) over stdio\n`)
  await serveTraceMcp({ spans: collected.spans })
}

/**
 * `traces diff <a> <b>`: the first tool call where two runs split. Exit 0 when
 * they agree, 1 when they diverge, like diff(1); 2 when they could not be
 * compared: a side cannot be read, or the calls line up but neither side
 * records an outcome to call agreement on (`code: no-outcome`).
 */
async function cmdDiff(args: CliArgs): Promise<void> {
  const { diffRuns, renderRunDiff } = await import('./diff.js')
  const report = await diffRuns(args.refs[0]!, args.refs[1]!)
  if (!report.diff.firstDivergence && report.caveat) {
    throw new CliError(`the runs' tool calls line up with no difference, but there is no outcome to call agreement on: ${report.caveat}`, 'no-outcome')
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
 * The host a `--format jsonl` row names: this machine's short lowercase name
 * (the name voice-ledger and trace-mine key turns by), or for a store root
 * the archive's `<host>/home` directory name.
 */
function hostOf(args: CliArgs): string {
  const root = args.selection?.home
  if (root !== undefined) return basename(root) === 'home' ? basename(dirname(root)) : basename(root)
  return hostname().split('.')[0]!.toLowerCase()
}

/**
 * `traces facts` — the deterministic session-facts sheet, printed.
 *
 * No model, no engine, no budget: the numbers come out of the spans. The text
 * sheet by default, at most 25 lines a session; `--format json` prints the
 * whole sheet for programs, and `--format jsonl` one row per typed turn. With
 * `--match RE` it prints the human turns, agent messages and shell commands
 * that match instead of the sheet. Every fact names the span ids it came from.
 *
 * A named session (a ref or `--current`) comes first, its spawned children
 * after it, and one that cannot be read exits 2. A sweep (`--last`, a window)
 * skips a session that cannot be read and names it with its reason in
 * `selection.unreadSessions`, so one bad file never ends a run over hundreds.
 * With `--since`/`--until` the selection is every session with a record in
 * the window, read one at a time.
 */
async function cmdFacts(args: CliArgs): Promise<void> {
  const format = args.format ?? 'text'
  const pattern = args.match === undefined ? undefined : new RegExp(args.match)
  if (args.noContent && (pattern !== undefined || format === 'jsonl')) {
    throw new UsageError(`${pattern ? '--match searches' : '--format jsonl rows carry'} turn text, which --no-content withholds; drop one of them`)
  }
  const window = factsWindow(args)
  // Rows need where each session was read from, which the facts do not carry.
  const sourceOf = new Map<string, string>()
  let readingFrom: string | null = null
  const host = hostOf(args)
  const matches: SourcedMatch[] = []
  // JSON facts and --match rows cite the record each fact came from; --no-content withholds paths.
  const citings = new Map<string, SessionCiting>()
  const cite = !args.noContent && (format === 'json' || pattern !== undefined)
  const onSession = (reading: SessionReading): void => {
    // OTLP sources are keyed by trace id, which a span's own session id can differ from.
    const source = readingFrom ?? sourceOf.get(reading.facts.sessionId ?? '') ?? sourceOf.get(reading.facts.traceId) ?? null
    if (cite && source !== null) {
      citings.set(reading.facts.sessionId ?? reading.facts.traceId, { path: resolve(source), callIds: callIdsOf(reading.spans) })
    }
    if (pattern === undefined) return
    for (const match of sessionMatches(reading, pattern, window)) matches.push({ ...match, source })
  }
  // A store root alone is a place to select from, not a selection.
  const named = (args.selection?.sessions.length ?? 0) + (args.selection?.spans.length ?? 0)
  if (pattern !== undefined && window !== undefined && named === 0) return searchWindow(args, pattern, window, format)
  if (format === 'jsonl' && pattern === undefined) return writeTurnFacts(args, host, window)
  const builder = createSessionFactsReportBuilder({
    includeContent: !args.noContent,
    window,
    nameUnread: named === 0,
    agentIdentity: sessionIdentityLookup(args.selection?.home ?? (process.env.HOME || homedir())),
    onSession,
  })
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
      readingFrom = ref.path
      builder.add(spans)
    }
    readingFrom = null
    for (const entry of unread) builder.addUnread(entry)
    warnUnread(args, unread)
    report = { ...builder.build(), harness: [...harnesses].join('+') || (args.harnessExplicit ? args.harness : null) }
  } else {
    const collected = await collectSpans(args)
    if (collected.spans.length === 0 && (collected.unread ?? []).length === 0) throw new Error('no spans found for the given selection')
    warnIncompleteWorkflow(collected.workflow)
    for (const source of collected.sources) sourceOf.set(source.sessionId, source.path)
    const files = args.selection?.spans ?? []
    if (files.length === 1 && collected.sources.length === 0) readingFrom = files[0]!.path
    builder.add(collected.spans)
    readingFrom = null
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
  if (pattern !== undefined) {
    return writeMatches(args, format, {
      generatedAt: report.generatedAt,
      sessions: report.sessions.length,
      selection: report.selection,
      matches: (await citeFacts(report.sessions, matches, citings)).matches,
    })
  }
  // Rows and matches carry no cost, so only the sheet is priced.
  report = await priceReport(report)
  const rendered = format === 'json'
    ? `${JSON.stringify({ ...report, sessions: (await citeFacts(report.sessions, [], citings)).sessions })}\n`
    : renderSessionFacts(report)
  const summary = `session facts → ${args.out}  (${report.sessions.length} session(s), $0, no model call)`
  await writeOutput(args, rendered, summary)
}


/** JSONL needs only own-session turns; named refs retain the collector's workflow selection. */
async function writeTurnFacts(args: CliArgs, host: string, window?: SessionFactsWindow): Promise<void> {
  const unread: UnreadSessionFact[] = []
  const named = (args.selection?.sessions.length ?? 0) + (args.selection?.spans.length ?? 0)
  async function* sources(): AsyncGenerator<TurnSource> {
    if (window !== undefined && named === 0) {
      const found = await discover(args)
      unread.push(...found.unread)
      for (const { adapter, ref } of found.sessions) {
        try {
          yield { source: ref.path, spans: await readSessionSpans(adapter, ref, { taskScope: args.latestTurn ? 'latest' : 'all', includeSubagents: false }) }
        } catch (error) {
          unread.push({ sessionId: ref.sessionId, traceId: null, source: ref.path, reason: errorText(error) })
        }
      }
      return
    }
    const collected = await collectSpans(args)
    warnIncompleteWorkflow(collected.workflow)
    unread.push(...collected.unread ?? [])
    const byTrace = new Map<string, OtlpSpan[]>()
    for (const span of collected.spans) {
      const held = byTrace.get(span.trace_id)
      if (held) held.push(span)
      else byTrace.set(span.trace_id, [span])
    }
    const ids = indexSessionIdsByTrace(collected.spans).sessionByTrace
    for (const [trace, spans] of byTrace) {
      const source = collected.sources.find((entry) => entry.sessionId === (ids.get(trace) ?? trace))?.path
        ?? (args.selection?.spans.length === 1 ? args.selection.spans[0]!.path : null)
      yield { spans, source }
    }
  }
  const result = await turnFactsJsonl(sources(), host, window)
  unread.push(...result.unread)
  if (named > 0 && unread.length > 0) throw new RefError(`no records could be read: ${unread.map((entry) => entry.sessionId).join(', ')}`, 'unreadable')
  warnUnread(args, unread)
  await writeOutput(args, result.text, `turns → ${args.out}  (${result.turns} typed turn(s) in ${result.sessions} session(s), $0, no model call)`)
}

/** The `--since`/`--until` window the facts sheet counts turns in, as ISO times; undefined with neither. */
function factsWindow(args: CliArgs): SessionFactsWindow | undefined {
  if (args.since === undefined && args.until === undefined) return undefined
  return {
    ...(args.since !== undefined ? { since: new Date(parseSince(args.since)).toISOString() } : {}),
    ...(args.until !== undefined ? { until: new Date(parseTimeBound(args.until, '--until')).toISOString() } : {}),
  }
}

/** Write a report file, making its directory first. */
async function saveReport(path: string, report: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(path, report, 'utf8')
}

/** `rendered` to `--out` with a one-line summary on stdout, or to stdout. */
async function writeOutput(args: CliArgs, rendered: string, summary: string): Promise<void> {
  if (args.out) {
    await writeFile(args.out, rendered, 'utf8')
    console.log(summary)
    return
  }
  process.stdout.write(rendered)
}

/** A match row, the file its session was read from, and for a command its record and output's last line (see `citeFacts`). */
type SourcedMatch = SessionMatch & { readonly source: string | null; readonly record?: RecordLine | null; readonly lastLine?: string | null }

/** The hits of `facts --match`, oldest first, in `format`. */
async function writeMatches(
  args: CliArgs,
  format: string,
  found: { readonly generatedAt: string; readonly sessions: number; readonly selection: unknown; readonly matches: SourcedMatch[] },
): Promise<void> {
  const matches = [...found.matches].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  const document = {
    schemaVersion: 1,
    kind: 'traces.session_matches',
    generatedAt: found.generatedAt,
    pattern: args.match,
    sessions: found.sessions,
    selection: found.selection,
    matches,
  }
  const rendered = format === 'json'
    ? `${JSON.stringify(document, null, 2)}\n`
    : format === 'jsonl'
      ? matches.map((match) => `${JSON.stringify(match)}\n`).join('')
      : renderMatches(args.match!, found.sessions, matches)
  await writeOutput(args, rendered, `matches → ${args.out}  (${matches.length} in ${found.sessions} session(s), $0, no model call)`)
}

/**
 * `facts --match` over a window: every session with a record in it, searched
 * through the turn index, which reads only what each session appended since
 * the last search. Its rows are the rows a whole read of each session gives
 * (`tests/turn-index.test.ts`). A named ref is parsed instead.
 */
async function searchWindow(args: CliArgs, pattern: RegExp, window: SessionFactsWindow, format: string): Promise<void> {
  const found = await discover(args)
  const unread: UnreadSessionFact[] = [...found.unread]
  const outsideWindow: string[] = []
  const matches: SourcedMatch[] = []
  const since = window.since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(window.since)
  const until = window.until === undefined ? Number.POSITIVE_INFINITY : Date.parse(window.until)
  let sessions = 0
  const stats = await TurnIndex.with(async (index) => {
    const refreshed = await index.refresh(found.sessions)
    for (const { adapter, ref } of found.sessions) {
      const held = index.session(adapter, ref)
      if (!held || held.unread !== null) {
        unread.push({ sessionId: ref.sessionId, traceId: null, source: ref.path, reason: held?.unread ?? 'not indexed' })
        continue
      }
      const { session } = held
      if (Date.parse(session.lastAt ?? '') < since || Date.parse(session.firstAt ?? '') >= until) {
        outsideWindow.push(session.sessionId ?? ref.sessionId)
        continue
      }
      sessions += 1
      for (const match of matchRows(session.sessionId, await index.rows(adapter, ref), pattern, window)) {
        matches.push({ ...match, source: ref.path })
      }
    }
    return refreshed
  })
  warnUnread(args, unread)
  await writeMatches(args, format, {
    generatedAt: new Date().toISOString(),
    sessions,
    selection: {
      since: window.since ?? null,
      until: window.until ?? null,
      sessionRule: 'a session is searched when its records, first to last, overlap [since, until)',
      turnRule: 'only rows that started inside [since, until) match',
      outsideWindow: outsideWindow.sort(),
      unreadSessions: unread,
      index: stats,
    },
    matches,
  })
}

/** `facts --match` as text: one line per hit, oldest first; a command's line says `ok`, `failed`, or `?` when its call's status is not its own. */
function renderMatches(pattern: string, sessions: number, matches: readonly SourcedMatch[]): string {
  const lines = [`${matches.length} match(es) for /${pattern}/ in ${sessions} session(s), deterministic, $0`]
  for (const match of matches) {
    const outcome = match.kind !== 'command' ? '' : `${(match.failed === true ? 'failed' : match.failed === false ? 'ok' : '?').padEnd(6)}  `
    lines.push(`${match.at}  ${(match.sessionId ?? '?').slice(0, 8)}  ${match.kind.padEnd(7)}  ${outcome}${match.text}`)
    // The record to cite, and the output's last line, which no clipped row shows.
    if (match.record) lines.push(`  ${match.record.file}:${match.record.line}${match.lastLine == null ? '' : `  last: ${match.lastLine.slice(0, 300)}`}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * `traces analyze`: what went wrong, ranked, for $0. Text by default (at most
 * 40 lines), `--format json` for the facts, the finding packet, the measures,
 * conformance and every question the trace cannot answer, and `--out DIR` for
 * `report.md` and `findings.json`.
 */
async function cmdAnalyze(args: CliArgs): Promise<void> {
  // A Runtime run directory, or a directory of them, is a supervision tree.
  const runDir = args.selection?.spans.find((source) => source.kind === 'run-dir')
  if (runDir) {
    if (args.refs.length > 1) throw new UsageError(`analyze reports one supervision tree at a time; ${runDir.ref} is a run directory`)
    return cmdAnalyzeSupervisorRun(runDir.path, args)
  }
  const { runTraceInvestigation, writeAnalysisArtifacts } = await import('./improvement.js')
  const { renderAnalysis, renderAnalysisReport } = await import('./report.js')
  const collected = await collectSpans(args)
  if (collected.spans.length === 0) throw new Error('no spans found for the given selection')
  warnIncompleteWorkflow(collected.workflow)
  const result = await runTraceInvestigation({
    spans: collected.spans,
    harness: collected.harness,
    ...(collected.unread ? { unread: collected.unread } : {}),
    ...(collected.conformance ? { conformance: collected.conformance } : {}),
    facts: {
      window: factsWindow(args),
      agentIdentity: sessionIdentityLookup(args.selection?.home ?? (process.env.HOME || homedir())),
    },
    log: analystLog,
  })
  if (args.out) {
    const artifacts = await writeAnalysisArtifacts(renderAnalysisReport(result), result.packet, args.out)
    console.log(
      `analysis → ${artifacts.directory}  (report.md, findings.json: ${result.packet.findings.length} finding(s), ` +
        `${result.cannotAnswer.length} question(s) it cannot answer, $0)`,
    )
    return
  }
  if (args.format === 'json') {
    const { schemaVersion, kind, generatedAt, harness, facts, packet, measures, conformance, cannotAnswer } = result
    process.stdout.write(`${JSON.stringify({ schemaVersion, kind, generatedAt, harness, facts, packet, measures, conformance, cannotAnswer })}\n`)
    return
  }
  process.stdout.write(renderAnalysis(result))
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
  const { analyzeSupervisorRun, findSupervisorRunDirs, isRuntimeSupervisorRunDir, renderSupervisorRollupMarkdown, renderSupervisorRunMarkdown, rollupSupervisorRuns } = await import('@tangle-network/agent-eval/supervisor-run')
  const { fileRunContextSupervisorRunReader } = await import('./supervisor-run-context.js')
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
    const path = resolve(args.out, 'report.md')
    await saveReport(path, markdown)
    console.log(`supervisor report → ${path}  (${runDirs.length === 1 ? '1 run' : `${runDirs.length} runs`})`)
  } else {
    console.log(markdown)
  }
}

async function collectImportedSpans(
  path: string,
  format: TraceEvidenceFormatOption,
  selector?: string,
): Promise<CollectedSpans> {
  const { sessionReportSource } = await import('./report.js')
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
    sources: [...sessions].map(([sessionId, grouped]) => sessionReportSource({
      harness: result.format,
      sessionId,
      path,
      cwd: null,
      mtimeMs: 0,
    }, grouped, sessionId)),
  }
}

/** A registry or engine line that reports a failure, not progress. */
const ANALYST_FAILURE = /\[analyst\] (?:FAIL|WARN) |\bmodel call \d+ FAIL\b/u

/**
 * The analysts' log on stderr: what failed, and nothing else. Progress (the
 * registry's `[analyst] ok <id>` and `skip` lines, each analyst's own notes,
 * the engine's `model call N ok`) is not printed: the report carries every
 * analyst's status, and stderr is for what went wrong. The registry's
 * `[analyst] FAIL <id>` line carries its reason only in the structured
 * fields; a message-only sink turns every engine-startup failure into an
 * unactionable one-liner.
 */
function analystLog(msg: string, fields?: Record<string, unknown>): void {
  // A gate rejection names its cause only in the fields; without them the
  // line says a finding was dropped but not why, which nobody can act on.
  const rejection = findingRejectionDetail(msg, fields)
  if (rejection !== undefined) {
    process.stderr.write(rejection ? `${msg} — ${rejection}\n` : `${msg}\n`)
    return
  }
  if (!ANALYST_FAILURE.test(msg)) return
  const error = typeof fields?.error === 'string' && fields.error ? fields.error : undefined
  const errorClass = typeof fields?.error_class === 'string' && fields.error_class ? `${fields.error_class}: ` : ''
  process.stderr.write(error ? `${msg} — ${errorClass}${error}\n` : `${msg}\n`)
}

/**
 * `traces ask`: free-form questions over the selected sessions, the one
 * command that spends. Every question is its own recursive investigation;
 * they run concurrently under one shared ledger, so `--budget` bounds the
 * whole run, and each question spends at most min(--budget, $2) within 1800 s.
 *
 * Nothing is spent until the run can start: a missing key or bridge exits 2
 * (`setup`) before any session is parsed. A key or model the endpoint refuses
 * stops every question at its first call and exits 2 (`auth` or `model`). A
 * busy or rate-limited endpoint is retried inside the call. Answers, citation
 * checks, and per-question cost and time are written before the exit code is
 * decided, so a failed question never costs the others' answers: a run that
 * answered only some exits 2 (`partial`) with every answer written. Ctrl-C is
 * one of those failures.
 */
async function cmdAsk(args: CliArgs): Promise<void> {
  const { analysisEngineFromEnv, bridgeVersion, missingAskRequirements, UnservableModelError } = await import('./analyst-model-call.js')
  const { isBridgeMismatchError, loadTraceQuestionsFile, normalizeTraceQuestions, runTraceQuestions, writeTraceQuestionsArtifacts } = await import('./ask.js')
  let questions: TraceQuestion[]
  try {
    questions = [
      ...(args.questionsFile ? await loadTraceQuestionsFile(args.questionsFile) : []),
      ...args.questions.map((question) => ({ question })),
    ]
    if (questions.length === 0) throw new UsageError('ask needs --question "<text>" (repeatable) or --questions <questions.json>')
    // Reject a bad question before any session is parsed or process started.
    normalizeTraceQuestions(questions)
  } catch (error) {
    throw error instanceof CliError ? error : new UsageError(errorText(error))
  }
  const missing = missingAskRequirements()
  if (missing.length > 0) throw new CliError(`ask needs ${missing.join('; and ')}. Nothing was spent`, 'setup')
  const budget = args.budget!
  const controller = new AbortController()
  let refused: { code: 'auth' | 'model'; message: string } | undefined
  let engine: ReturnType<typeof analysisEngineFromEnv>
  try {
    engine = analysisEngineFromEnv({
      model: analystModelFor(args),
      maxCostUsd: Math.min(budget, DEFAULT_QUESTION_MAX_COST_USD),
      timeoutMs: DEFAULT_QUESTION_TIMEOUT_MS,
      log: analystLog,
      // A refused key or model fails every question the same way: stop them all at the first.
      onPermanentFailure: (failure) => {
        refused ??= failure
        controller.abort(new Error(failure.message))
      },
    })
  } catch (error) {
    if (error instanceof UnservableModelError) throw new CliError(error.message, error.failure.code)
    throw error
  }
  const collected = await collectSpans(args)
  if (collected.spans.length === 0) throw new CliError('no spans found for the given selection', 'unreadable')
  warnIncompleteWorkflow(collected.workflow)
  const interrupt = () => controller.abort(new Error('ask interrupted'))
  process.once('SIGINT', interrupt)
  let result: TraceQuestionsResult
  try {
    result = await runTraceQuestions({
      questions,
      spans: collected.spans,
      engine,
      harness: collected.harness,
      concurrency: DEFAULT_ASK_CONCURRENCY,
      budgetUsd: budget,
      signal: controller.signal,
      log: analystLog,
    })
  } catch (error) {
    // A budget below one model call's reservation is refused before any call.
    throw error instanceof RangeError ? new UsageError(error.message) : error
  } finally {
    process.removeListener('SIGINT', interrupt)
  }
  const artifacts = args.out === undefined ? undefined : await writeTraceQuestionsArtifacts(result, args.out)
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`)
  if (refused) {
    const record = artifacts ? `; ${artifacts.result} records each question` : ''
    throw new CliError(`${refused.message}. ask stopped every question at the first refused call${record}`, refused.code)
  }
  const { totals } = result
  const cost = totals.cost.usd
  if (artifacts) {
    process.stdout.write(args.format === 'json'
      ? `${JSON.stringify({ out: artifacts.directory, answered: totals.answered, questions: totals.questions, costUsd: cost })}\n`
      : `answers → ${artifacts.directory}  (answers.json, report.md: ${totals.answered}/${totals.questions} answered, ` +
        `${cost === null ? 'cost uncaptured' : `$${cost > 0 && cost < 0.01 ? cost.toPrecision(2) : cost.toFixed(2)}`}, ` +
        `${(totals.wallTimeMs / 1000).toFixed(1)} s)\n`)
  } else if (args.format === 'json') {
    const { report: _report, ...machine } = result
    process.stdout.write(`${JSON.stringify(machine)}\n`)
  } else {
    process.stdout.write(result.report)
  }
  if (result.ok) return
  const failed = result.questions.filter((answer) => answer.status === 'failed')
  const where = artifacts ? artifacts.result : args.format === 'json' ? 'the JSON on stdout' : 'the report above'
  // Any kind, not only `error`: the hint is decided by the message, and a
  // mismatch that also exhausted the budget still needs the reinstall line.
  const hint = failed.some((answer) => isBridgeMismatchError(answer.failure?.message ?? ''))
    ? ` The DSPy bridge protocol is version-locked: TRACES_PYTHON needs agent-eval-rpc[dspy]==${bridgeVersion()}, or unset it to let uv run that version.`
    : ''
  throw new CliError(
    `${failed.length} of ${result.questions.length} question(s) unanswered ` +
      `(${failed.map((answer) => `${answer.id}: ${answer.failure?.kind}`).join(', ')}); ${where} says why.${hint}`,
    'partial',
  )
}

/** Severity as `traces analyze` prints it. */
const LIVE_SEVERITY: Readonly<Record<TraceLiveFinding['severity'], string>> = { info: 'INFO', low: 'LOW', medium: 'MED', high: 'HIGH' }

/** One line per finding: time, severity, the session's ref and harness, the rule, what it saw, and the spans it cites. */
function liveFindingLine(finding: TraceLiveFinding, ref: string): string {
  const spans = [...new Set(finding.evidence.flatMap((item) => item.spanIds ?? []))]
  const cite = spans.length === 0 ? '' : ` (span${spans.length === 1 ? '' : 's'} ${spans.slice(0, 2).join(', ')}${spans.length > 2 ? ', …' : ''})`
  return `${finding.observedAt.slice(11, 19)} ${LIVE_SEVERITY[finding.severity]} ${ref} ${finding.session.harness} ${finding.ruleId}: ${finding.claim}${cite}`
}

/** A span source's runs, one per trace, as the sessions a watch follows. */
async function* spanRuns(args: CliArgs, path: string): AsyncGenerator<WatchedSession> {
  const { spans } = await collectSpans(args)
  const { sessionByTrace } = indexSessionIdsByTrace(spans)
  const byTrace = new Map<string, OtlpSpan[]>()
  for (const span of spans) {
    const group = byTrace.get(span.trace_id)
    if (group) group.push(span)
    else byTrace.set(span.trace_id, [span])
  }
  for (const [traceId, group] of byTrace) {
    const attribute = (key: string): string | null => {
      const value = group[0]!.attributes[key]
      return typeof value === 'string' && value.length > 0 ? value : null
    }
    yield { session: { harness: attribute('service.name') ?? 'otlp', sessionId: sessionByTrace.get(traceId) ?? traceId, cwd: attribute('tangle.cwd'), path }, spans: group }
  }
}

/**
 * `traces watch`: live supervision. With no ref, or a store root, it follows
 * every session active in the `--since` window (default 30m), whose start is
 * recomputed on every pass; with session refs, those sessions. Text prints one
 * line per new finding (and, with `--once`, a closing count); `--format jsonl`
 * prints the `traces.stream.*` envelope. A Runtime run directory or a span
 * file is one run tree in text, and the envelope of its spans in jsonl.
 */
async function cmdWatch(args: CliArgs): Promise<void> {
  const named = args.selection
  const source = named?.spans[0]
  if (source && (named!.spans.length > 1 || named!.sessions.length > 0)) {
    throw new UsageError('watch follows one run tree or span file at a time, or harness sessions: traces watch <run-dir|file> or traces watch <id…>')
  }
  const jsonl = args.format === 'jsonl'
  if (source && !jsonl) return cmdWatchRunTarget(source.path, args)
  const { streamSessions, watchSource } = await import('./live.js')
  const since = args.since ?? '30m'
  const windowMs = relativeBoundMs(since)
  const sessions = named?.sessions.length ? named.sessions : undefined
  const scope = source ? source.ref : sessions ? `${sessions.length} named session${sessions.length === 1 ? '' : 's'}` : `every session active ${windowMs === undefined ? 'since' : 'in the last'} ${since}`
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  if (!args.once) process.stderr.write(`traces watch: ${scope}, every 5 s; read-only. Ctrl-C to stop.\n`)
  // A session's ref is the shortest prefix or suffix that names it among the sessions seen.
  const ids: string[] = []
  const reported = new Set<string>()
  let last: Extract<TraceStreamEvent, { event: 'tick' }> | undefined
  let findings = 0
  const onEvent = (event: TraceStreamEvent): void => {
    if (jsonl) process.stdout.write(`${JSON.stringify(event)}\n`)
    if (event.event === 'session') ids.push(event.session.sessionId)
    else if (event.event === 'finding') {
      findings += 1
      const id = event.finding.session.sessionId
      if (!jsonl) process.stdout.write(`${liveFindingLine(event.finding, shortestRefs(ids).get(id) ?? id)}\n`)
    } else {
      last = event
      if (args.once) return
      for (const unread of event.unreadSessions) {
        const key = unread.sessionId ?? unread.source
        if (reported.has(key)) continue
        reported.add(key)
        process.stderr.write(`unreadable ${key}: ${unread.reason}\n`)
      }
    }
  }
  const loop = { once: args.once, signal: controller.signal, onEvent }
  if (source) await watchSource(() => spanRuns(args, source.path), loop)
  else {
    await streamSessions({
      adapters: adaptersFor(args),
      ...(sessions ? { sessions } : {}),
      ...(named?.home !== undefined ? { home: named.home } : {}),
      cwd: args.cwd,
      ...(windowMs !== undefined ? { windowMs } : { sinceMs: parseSince(since) }),
      ...loop,
    })
  }
  if (!args.once || !last) return
  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
  if (!jsonl) process.stdout.write(`${scope}: ${count(last.sessions, 'session')} read · ${count(findings, 'finding')}\n`)
  const unread = last.unreadSessions.length
  if (unread > 0) {
    process.stderr.write(`${unread} unreadable: traces watch … --once --format jsonl | jq 'select(.event == "tick") | .unreadSessions'\n`)
  }
}

/**
 * Live view of one run tree. The target is an OTLP span file (the general
 * source, which works for any emitter), an agent-runtime `createFileRunContext`
 * directory (the specific source, which carries budget and settlement), or a
 * directory holding both. Read-only, plain stdout, every 2 s; `--once` prints
 * a single snapshot, which is what a script or an agent wants.
 */
async function cmdWatchRunTarget(dir: string, args: CliArgs): Promise<void> {
  const { resolveRunWatchTarget, watchRunTarget } = await import('./run-watch.js')
  const target = await resolveRunWatchTarget(resolve(dir))
  const controller = new AbortController()
  if (!args.once) {
    process.once('SIGINT', () => controller.abort())
    process.stderr.write(
      `traces watch: tailing ${target.requested} every 2s; read-only, ` +
        `${target.runDir === null ? 'span source only — Ctrl-C to stop' : 'stops when result.json lands. Ctrl-C to stop'}.\n`,
    )
  }
  // A tree view polls faster than sessions: a blocking question is worth surfacing the moment it lands.
  const snapshot = await watchRunTarget(target, { once: args.once, intervalMs: 2000, signal: controller.signal })
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
  const { executeUpload, planUpload, planUploadFrom } = await import('./upload.js')
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
    w(`  + [${i.ref.harness}] ${i.ref.sessionId.slice(0, 8)}  ${i.spans.length} spans  ${i.redaction.redactionCount} redacted  ${args.noContent ? '' : i.ref.cwd ?? ''}\n`)
  }
  if (candidates.length > 25) w(`  … and ${candidates.length - 25} more\n`)

  if (candidates.length === 0) {
    console.log('No sessions found to upload.')
    return
  }

  if (args.dryRun) {
    const res = await executeUpload(plan, { dryRun: true, otlpOut: args.out, stripContent: args.noContent })
    reportRefused(res.refused)
    if (res.verdict) console.log(`share verdict: ${res.verdict.status} (the redacted${args.noContent ? ', metadata-only' : ''} payload; UNSAFE and UNKNOWN are refused)`)
    console.log(
      `dry run: ${candidates.length - res.skippedSessions - res.refused.length} session(s), ${totalRedactions} redaction(s).` +
        (res.otlpPath ? ` Redacted OTLP -> ${res.otlpPath}` : ' Pass --out FILE to keep the redacted OTLP.'),
    )
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

/** The window `traces skills` counts when no `--since` is given. */
const SKILLS_SINCE = '30d'

/**
 * `traces skills`: skill use across Claude Code, Codex and Kimi Code sessions,
 * with no model call. Each run reads the bytes sessions appended since the
 * last into the store under `$XDG_STATE_HOME/traces`, then counts the window.
 */
async function cmdSkills(args: CliArgs): Promise<void> {
  const since = parseSince(args.since ?? SKILLS_SINCE)
  const storePath = defaultSkillUsageStorePath()
  const store = await SkillUsageStore.load(storePath)
  const refreshed = await store.refresh()
  await store.save()
  const report = buildSkillUsageReport(store.list(), await readInstalledSkills(), storePath, { since, refresh: refreshed })
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
  // check resolves its refs itself, after its contracts load, and --share-safe
  // reads paths as bytes: a bad contract exits before any trace is read.
  check: async (args) => cmdCheck(prepare(args)),
  diff: cmdDiff,
  watch: reading(cmdWatch),
  bundle: reading(cmdBundle),
  'bundle verify': cmdBundleVerify,
  convert: reading(cmdConvert),
  upload: reading(cmdUpload),
  skills: cmdSkills,
  mcp: reading(cmdMcp),
})
