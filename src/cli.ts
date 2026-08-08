#!/usr/bin/env node
/**
 * `traces`: analyze agent traces — yours, or any system's.
 *
 *   traces validate <file|dir>
 *   traces analyze --otlp <file|dir> [--out report.md] [--llm]
 *   traces list    [--harness claude-code] [--last 20] [--all]
 *   traces analyze [--harness claude-code] [--last 1] [--out report.md] [--llm]
 *   traces analyze --harness codex --current --latest-turn --workflow
 *   traces analyze --harness claude-code --session <path> --latest-turn --workflow
 *   traces analyze <evidence.jsonl|spans.jsonl> [--format auto] [--out report.md]
 *   traces investigate [input.jsonl] [--format auto] [--out report.md]
 *   traces improve [input.jsonl] [--format auto] --dir .traces/improvement
 *   traces convert [--harness claude-code] [--last 1] --otlp-out spans.jsonl
 *   traces index   [--harness claude-code] [--last 20] --out session-index.json
 *   traces bundle  --harness claude-code --session <id|path> --out <dir>
 *   traces inspect session-index.json [--out inspection-report.md]
 *   traces export  <file.jsonl|file.json> --out spans.openinference.jsonl
 *   traces import-codetracebench <rows.jsonl> --trajectory-dir <dir> --out <dir> --revision <40-or-64-character-hex>
 *   traces evidence [--harness claude-code] [--last 20] --out policy-evidence.jsonl
 *   traces stream  [input.jsonl] [--replay] [--all] [--format auto]
 *   traces watch   [--all] [--interval 5] [--window 30] [--min-loop 3]
 *   traces watch   <run-dir | spans.otlp.jsonl> [--once] [--interval 2]
 *
 * Two ways in. `--otlp` reads spans a system already emitted in the
 * `@tangle-network/agent-trace-contract` shape and skips translation entirely —
 * the way to integrate a system you control. `--harness` runs an adapter over a
 * proprietary session store, for the coding agents whose format we do not own.
 *
 * `analyze` runs the agent-eval analyst suite (deterministic + the shipped
 * loop/waste pipelines; +agentic RLM kinds with `--llm`) and reports which
 * analyses the spans could not support, and why. `validate` reports that
 * conformance alone, before a run is spent. `watch` is the online observer:
 * with no path it tails active sessions and prints notifications when a stuck
 * loop or semantic live finding appears; given a run directory or an OTLP span
 * file it tails that run's tree instead. `stream` emits the same live feed as
 * JSONL for visualizers, dashboards, and external agents.
 *
 * `--otlp <file|dir>` READS OTLP; `--otlp-out <path>` WRITES the artifact.
 */

import { readFileSync } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { appendAll } from './arrays.js'
import { indexSessionIdsByTrace } from './attributes.js'
import { importCodeTraceBench } from './codetracebench.js'
import { buildPolicyEvidenceRecord, serializePolicyEvidence, writePolicyEvidenceFile } from './evidence.js'
import { cmdReplayVerifyBatch } from './replay-batch.js'
import { cmdReplayVerify } from './replay-verify.js'
import {
  cmdVerifyFindings,
  DEFAULT_SANDBOX_BASE_URL,
  renderVerifiedFindingsSection,
  verifyFindings,
  type VerifyFindingsRun,
} from './analyze-verify.js'
import { parseCorpusFlag } from './replay-corpus.js'
import { commandAnalyzer, commandRedactor, haloAnalyzer } from './external.js'
import { hodoscopeAnalyzer } from './hodoscope.js'
import { primeAnalyzer } from './analyst-engine-prime.js'
import { type TraceEvidenceFormatOption, exportTraceEvidenceFile, writeTraceEvidenceExportFile } from './file-export.js'
import { inspectSessionIndex, readSessionIndexFile, renderInspectionReport, writeInspectionReportFile } from './inspect.js'
import {
  loadTracesConfig,
  mergeTracesConfig,
  runTraceImprovement,
  runTraceInvestigation,
  saveReport,
  totalAgenticFailureMessage,
  type TraceInvestigationResult,
} from './improvement.js'
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
  isUnavailable,
  renderSupervisorRollupMarkdown,
  renderSupervisorRunMarkdown,
  rollupSupervisorRuns,
} from '@tangle-network/agent-eval/supervisor-run'
import { fileRunContextSupervisorRunReader, isFileRunContextDir } from './supervisor-run-context.js'
import { resolveRunWatchTarget, watchRunTarget } from './run-watch.js'
import { createDspyRlmTraceEngine, type TraceAnalysisEngine } from '@tangle-network/agent-eval/analyst'
import type { OtlpSpan } from './otlp.js'
import { serializeSpans, writeOtlpFile } from './otlp.js'
import type {
  OtlpFieldWithheld,
  OtlpIngestIssue,
  OtlpInputFile,
  SkippedInputFile,
  UnreadableSourceRows,
} from './otlp-input.js'
import { readOtlpInput } from './otlp-input.js'
import { renderValidation, validationExitCode } from './conformance.js'
import type { TraceValidation } from '@tangle-network/agent-trace-contract'
import { watchSessions } from './observer.js'
import { knownHarnesses, resolveAdapter, selectAdapters } from './registry.js'
import { locateSessions, parseSession } from './session-source.js'
import { collectSessionSelection, type SessionSelection } from './session-selection.js'
import {
  type SessionWorkflowIssue,
  type SessionWorkflowSummary,
} from './session-workflow.js'
import { assembleSessionBundle } from './bundle.js'
import { buildSessionIndexFromRows, serializeSessionIndex, writeSessionIndexFile } from './session-index.js'
import { sessionReportSource } from './report.js'
import type { ReportSource } from './report.js'
import { parseSince } from './time.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'
import { executeUpload, planUpload } from './upload.js'

interface Args {
  command: string
  input?: string
  help: boolean
  harness: string
  harnessExplicit: boolean
  all: boolean
  last: number
  current: boolean
  latestTurn: boolean
  workflow: boolean
  maxWorkflowSessions: number
  session?: string
  cwd?: string
  since?: string
  out?: string
  dir?: string
  /** OTLP-JSONL file or directory to READ. */
  otlp?: string
  /** Where to WRITE the OTLP-JSONL artifact. */
  otlpOut?: string
  llm: boolean
  budget?: number
  interval: number
  /** True when `--interval` was given, so a command can keep its own default. */
  intervalExplicit: boolean
  window: number
  minLoop: number
  dryRun: boolean
  yes: boolean
  noContent: boolean
  analyzers: string[]
  analyzerPrompt?: string
  redactorCmd?: string
  model?: string
  config?: string
  format?: string
  mode?: string
  replay: boolean
  /** `--once`: a single pass instead of a live tail. */
  once: boolean
  noSpans: boolean
  noFindings: boolean
  metadata?: string
  attrs: string[]
  supervisorRunDir?: string
  trajectoryDir?: string
  revision?: string
  concurrency: number
  /** analyze --verify-findings: execute analyst findings as sandbox replay proofs. */
  verifyFindings: boolean
  /** Repeatable `name=<labels>::<prepared>` corpora resolving finding trajectories. */
  replayCorpora: string[]
  /** Receipt root for --verify-findings; defaults next to --out. */
  verifyOut?: string
}

const DEFAULT_ANALYST_MODEL = 'gpt-5-mini'

/** Default `--llm` endpoint: the Tangle router, reached with TANGLE_API_KEY. */
const TANGLE_ROUTER_BASE_URL = 'https://router.tangle.tools/v1'

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('package.json is missing version')
  return pkg.version
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: argv[0] === '--help' || argv[0] === '-h' ? 'help' : argv[0] ?? 'help',
    help: argv[0] === '--help' || argv[0] === '-h',
    harness: 'claude-code',
    harnessExplicit: false,
    all: false,
    last: 0,
    current: false,
    latestTurn: false,
    workflow: false,
    maxWorkflowSessions: 100,
    llm: false,
    interval: 5,
    intervalExplicit: false,
    window: 30,
    minLoop: 3,
    dryRun: false,
    yes: false,
    noContent: false,
    analyzers: [],
    replay: false,
    once: false,
    noSpans: false,
    noFindings: false,
    attrs: [],
    concurrency: 4,
    verifyFindings: false,
    replayCorpora: [],
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--harness': a.harness = next() ?? a.harness; a.harnessExplicit = true; break
      case '--all': a.all = true; break
      case '--last': a.last = Number(next()); break
      case '--current': a.current = true; break
      case '--latest-turn': a.latestTurn = true; break
      case '--workflow': a.workflow = true; break
      case '--max-workflow-sessions': a.maxWorkflowSessions = Number(next()); break
      case '--session': a.session = next(); break
      case '--cwd': a.cwd = next(); break
      case '--supervisor-run-dir': a.supervisorRunDir = next(); break
      case '--trajectory-dir': a.trajectoryDir = next(); break
      case '--revision': a.revision = next(); break
      case '--concurrency': a.concurrency = Number(next()); break
      case '--since': a.since = next(); break
      case '--out': a.out = next(); break
      case '--dir': a.dir = next(); break
      case '--otlp': a.otlp = next(); break
      case '--otlp-out': a.otlpOut = next(); break
      case '--llm': a.llm = true; break
      case '--budget': a.budget = Number(next()); break
      case '--model': a.model = next(); break
      case '--config': a.config = next(); break
      case '--mode': a.mode = next(); break
      case '--metadata': a.metadata = next(); break
      case '--attr': { const v = next(); if (v) a.attrs.push(v); break }
      case '--interval': a.interval = Number(next()); a.intervalExplicit = true; break
      case '--window': a.window = Number(next()); break
      case '--min-loop': a.minLoop = Number(next()); break
      case '--dry-run': a.dryRun = true; break
      case '--no-content': a.noContent = true; break
      case '--replay': a.replay = true; break
      // `stream --once` has always meant "one pass"; `watch --once` means the
      // same thing over a run directory, so one flag drives both.
      case '--once': a.once = true; a.replay = true; break
      case '--no-spans': a.noSpans = true; break
      case '--no-findings': a.noFindings = true; break
      case '--analyzer': { const v = next(); if (v) a.analyzers.push(v); break }
      case '--verify-findings': a.verifyFindings = true; break
      case '--replay-corpus': { const v = next(); if (v) a.replayCorpora.push(v); break }
      case '--verify-out': a.verifyOut = next(); break
      case '--analyzer-prompt': a.analyzerPrompt = next(); break
      case '--redactor': a.redactorCmd = next(); break
      case '--format': a.format = next(); break
      case '--help':
      case '-h': a.help = true; break
      case '--yes':
      case '-y': a.yes = true; break
      default:
        if (arg?.startsWith('--')) throw new Error(`unknown flag: ${arg}`)
        if (arg && !a.input) a.input = arg
        else if (arg) throw new Error(`unexpected positional argument: ${arg}`)
    }
  }
  return a
}

/**
 * Commands that READ OTLP with `--otlp`. Everything else WRITES its OTLP
 * artifact with `--otlp-out`: one flag, one direction, no command where the
 * same word means read here and write there.
 */
const OTLP_INPUT_COMMANDS = new Set(['analyze', 'investigate', 'improve', 'stream', 'validate'])

/**
 * `--otlp` used to mean "write the artifact here" on every command. It now
 * means "read this" — so on a WRITING command the old spelling is honoured for
 * one minor with a warning, rather than turning a working script into a hard
 * error at the moment the reader was introduced. Removed in 0.12.
 */
function migrateWritingOtlpFlag(args: Args): Args {
  if (args.otlp === undefined || OTLP_INPUT_COMMANDS.has(args.command)) return args
  if (args.otlpOut !== undefined) {
    throw new Error(
      `${args.command} was given both --otlp and --otlp-out. --otlp is the deprecated spelling of ` +
        '--otlp-out on writing commands; pass only --otlp-out.',
    )
  }
  console.error(
    `warning: --otlp is deprecated on \`${args.command}\` and will be removed in 0.12. ` +
      '--otlp now READS OTLP-JSONL; use --otlp-out <path> to write the artifact. ' +
      'Treating it as --otlp-out for this run.',
  )
  return { ...args, otlpOut: args.otlp, otlp: undefined }
}

function validateOtlpSelection(raw: Args): Args {
  const args = migrateWritingOtlpFlag(raw)
  if (args.otlp === undefined) return args
  if (args.input) throw new Error('--otlp cannot be combined with an input file')
  if (args.session) throw new Error('--otlp reads a file and cannot be combined with --session')
  if (args.supervisorRunDir) throw new Error('--otlp cannot be combined with --supervisor-run-dir')
  if (args.workflow || args.latestTurn) {
    throw new Error('--workflow and --latest-turn expand harness sessions and cannot be combined with --otlp')
  }
  return args
}

const CURRENT_SESSION_COMMANDS = new Set([
  'analyze',
  'investigate',
  'improve',
  'convert',
  'index',
  'evidence',
  'bundle',
  'stream',
])

const WORKFLOW_COMMANDS = new Set([
  'analyze',
  'investigate',
  'improve',
  'convert',
  'index',
  'evidence',
])

function applyCurrentSessionSelection(args: Args): Args {
  if (!args.current) return args
  if (!CURRENT_SESSION_COMMANDS.has(args.command)) {
    throw new Error(`--current is not supported by ${args.command}`)
  }
  if (args.input) throw new Error('--current cannot be combined with an input file')
  if (args.supervisorRunDir) throw new Error('--current cannot be combined with --supervisor-run-dir')
  if (args.session) throw new Error('--current cannot be combined with --session')
  if (args.last > 0) throw new Error('--current cannot be combined with --last')
  if (args.all) throw new Error('--current cannot be combined with --all')
  const adapter = resolveAdapter(args.harness)
  if (adapter?.harness !== 'codex') {
    throw new Error('--current uses CODEX_THREAD_ID and requires --harness codex')
  }
  const sessionId = process.env.CODEX_THREAD_ID?.trim()
  if (!sessionId) throw new Error('--current requires CODEX_THREAD_ID from the active Codex session')
  return { ...args, session: sessionId }
}

function validateWorkflowSelection(args: Args): Args {
  if (!args.workflow && !args.latestTurn) return args
  if (!WORKFLOW_COMMANDS.has(args.command)) {
    throw new Error(`${args.workflow ? '--workflow' : '--latest-turn'} is not supported by ${args.command}`)
  }
  if (args.input) throw new Error('--workflow and --latest-turn cannot be combined with an input file')
  if (args.supervisorRunDir) {
    throw new Error('--workflow and --latest-turn cannot be combined with --supervisor-run-dir')
  }
  const selected = resolveAdapter(args.harness)
  const supportsTaskTurns =
    selected?.harness === 'codex' || selected?.harness === 'claude-code'
  if (args.latestTurn && (args.all || !supportsTaskTurns)) {
    throw new Error('--latest-turn requires --harness codex or claude-code')
  }
  return args
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

function adaptersFor(args: Args): HarnessTraceAdapter[] {
  return selectAdapters({ all: args.all, harnesses: [args.harness] })
}

async function discover(args: Args): Promise<{ adapter: HarnessTraceAdapter; refs: SessionRef[] }[]> {
  const sinceMs = args.since ? Date.parse(args.since) : undefined
  const out: { adapter: HarnessTraceAdapter; refs: SessionRef[] }[] = []
  for (const adapter of adaptersFor(args)) {
    let refs = await locateSessions(adapter, { cwd: args.cwd, sinceMs })
    if (args.last > 0) refs = refs.slice(0, args.last)
    out.push({ adapter, refs })
  }
  return out
}

function missingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Resolve `--session` as either a concrete harness file or an ID printed by
 * `traces list`. An ID is only accepted when it identifies one session under
 * the selected harnesses, keeping reports reproducible as live files change. */
async function resolveSelectedSession(args: Args): Promise<{ adapter: HarnessTraceAdapter; ref: SessionRef }> {
  if (!args.session) throw new Error('resolveSelectedSession requires --session')

  const adapter = resolveAdapter(args.harness)
  if (!adapter && !args.all) throw new Error(`unknown harness "${args.harness}"`)

  try {
    const st = await stat(args.session)
    if (!adapter) {
      throw new Error('--session <path> requires --harness when --all is set')
    }
    return {
      adapter,
      ref: {
        harness: adapter.harness,
        sessionId: args.session,
        path: args.session,
        // --session is an explicit file; honor --cwd so adoption can find the
        // project's current or legacy skill-run log (locate() infers cwd in the scan path).
        cwd: args.cwd ?? null,
        mtimeMs: st.mtimeMs,
      },
    }
  } catch (error) {
    if (!missingPath(error)) throw error
  }

  const matches: Array<{ adapter: HarnessTraceAdapter; ref: SessionRef }> = []
  for (const candidate of args.all ? adaptersFor(args) : [adapter!]) {
    const refs = await locateSessions(candidate, { cwd: args.cwd })
    for (const ref of refs) {
      if (ref.sessionId === args.session) matches.push({ adapter: candidate, ref })
    }
  }
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) {
    throw new Error(
      `no ${args.all ? 'selected' : adapter!.harness} session with ID "${args.session}"; ` +
        'run `traces list` to select an ID, or pass an explicit session path',
    )
  }
  throw new Error(
    `session ID "${args.session}" is ambiguous across ${matches.length} files; ` +
      'select one harness or pass its explicit session path',
  )
}

/**
 * The recursive analysis engine behind `--llm`. agent-eval's model-backed
 * analysts run through DSPy RLM, which drives `agent-eval-rpc[dspy]` out of
 * process — so `--llm` needs a Python interpreter with that extra installed,
 * selectable via TRACES_PYTHON. Every deterministic command is unaffected and
 * still needs neither a key nor Python.
 */
function buildAnalysisEngine(model: string, budgetUsd?: number): TraceAnalysisEngine {
  // The router is the default endpoint, so TANGLE_API_KEY alone is enough.
  // OPENAI_API_KEY still works and, when it is the only key present, points at
  // OpenAI directly — otherwise a plain OpenAI key would be sent to the router.
  const tangleKey = process.env.TANGLE_API_KEY
  const openAiKey = process.env.OPENAI_API_KEY
  const apiKey = tangleKey || openAiKey
  if (!apiKey) {
    throw new Error(
      '--llm needs a model key: TANGLE_API_KEY for the Tangle router (the default endpoint), or ' +
        'OPENAI_API_KEY for OpenAI. Set OPENAI_BASE_URL to target any other OpenAI-compatible ' +
        'gateway. Deterministic analysis needs no key.',
    )
  }
  const baseUrl =
    process.env.OPENAI_BASE_URL ||
    (tangleKey ? TANGLE_ROUTER_BASE_URL : 'https://api.openai.com/v1')
  const python = process.env.TRACES_PYTHON
  return createDspyRlmTraceEngine({
    apiKey,
    baseUrl,
    model,
    // agent-eval 0.139.3's engine defaults are tuned below what real runs
    // need. maxOutputTokens 4096 is under what current coding models emit for
    // one findings array: glm-5.2 counts reasoning tokens in
    // completion_tokens, the first oversized completion breaches its cost
    // reservation, and the fail-closed ledger then refuses every later call
    // in the run.
    maxOutputTokens: 16_384,
    // maxCostUsd defaults to $1 per analyst — a proxy-side ceiling separate
    // from --budget. With the larger token cap the per-call reservation grows
    // ~4x, so that default binds before the registry's --budget allocation
    // and kills analysts mid-run. --budget is the operator's spend authority
    // and the registry still splits it across analysts, so forwarding it here
    // only stops the engine's own default from cutting runs short.
    ...(budgetUsd !== undefined && Number.isFinite(budgetUsd) && budgetUsd > 0
      ? { maxCostUsd: budgetUsd }
      : {}),
    ...(python ? { runner: { command: python } } : {}),
  })
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
 * `--llm` promises agentic findings; delivering a deterministic-only report
 * with exit 0 when every agentic analyst died reads as success. Throwing after
 * the report is written keeps the deterministic output AND fails loud. The
 * bridge-version read happens only once total failure is established, so a
 * package.json problem can never turn a successful run into exit 1.
 */
function assertAgenticAnalystsRan(args: Args, agenticPerAnalyst: TraceInvestigationResult['agenticPerAnalyst']): void {
  if (!args.llm) return
  if (!totalAgenticFailureMessage(agenticPerAnalyst)) return
  const message = totalAgenticFailureMessage(agenticPerAnalyst, { requiredBridgeVersion: requiredBridgeVersion() })
  throw new Error(message!)
}

async function cmdList(args: Args): Promise<void> {
  const groups = await discover({ ...args, last: args.last || 20 })
  for (const { adapter, refs } of groups) {
    console.log(`\n${adapter.harness}: ${refs.length} session(s)`)
    for (const r of refs) {
      console.log(`  ${new Date(r.mtimeMs).toISOString()}  ${r.sessionId}  ${r.cwd ?? ''}`)
    }
  }
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
}

/**
 * Read OTLP spans a foreign system emitted, skipping the adapter stage
 * entirely: the analysis engine is already OTLP-native, so conforming spans
 * need no translation to be analysed.
 */
async function collectOtlpSpans(path: string): Promise<CollectedSpans> {
  const input = await readOtlpInput(path)
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
  const byTrace = new Map<string, OtlpSpan[]>()
  for (const span of input.spans) {
    const grouped = byTrace.get(span.trace_id) ?? []
    grouped.push(span)
    byTrace.set(span.trace_id, grouped)
  }
  return {
    spans: [...input.spans],
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

async function collectSpans(args: Args): Promise<CollectedSpans> {
  if (args.otlp) return collectOtlpSpans(args.otlp)
  if (args.input) {
    if (args.workflow) throw new Error('--workflow reads discovered sessions and cannot be combined with an input file')
    return collectImportedSpans(args)
  }
  const selection = await collectSessionRows(args, false, args.last || 1)
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
    harness: [...harnesses].join('+') || args.harness,
    cwds,
    sources,
    ...(selection.workflow ? { workflow: selection.workflow } : {}),
  }
}

/**
 * `traces validate <file|dir>` — what a trace can and cannot answer, before
 * anyone spends a run on it. Exits non-zero on exactly one condition: the input
 * is not a trace, because not one entry in it could be read as a span. A
 * degraded trace exits 0 and states its degradation per capability; a gate that
 * fails on thinness would stop every real-world trace on day one.
 */
async function cmdValidate(args: Args): Promise<void> {
  const path = args.otlp ?? args.input
  if (!path) {
    throw new Error('validate needs an OTLP-JSONL file or directory: `traces validate <file|dir>`')
  }
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

async function cmdConvert(args: Args): Promise<void> {
  const { spans, workflow } = await collectSpans(args)
  if (spans.length === 0) throw new Error('no spans found for the given selection')
  warnIncompleteWorkflow(workflow)
  const path = await writeOtlpFile(spans, args.otlpOut)
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
  return `${issue.kind} ${issue.sessionId}, referenced as ${issue.relation} by ${issue.referencedBySessionId}`
}

function warnIncompleteWorkflow(workflow: SessionWorkflowSummary | undefined): void {
  if (!workflow || workflow.complete) return
  process.stderr.write(
    `warning: session workflow is incomplete (${workflow.issues.length} issue(s)): ` +
      `${workflow.issues.map(workflowIssueText).join('; ')}\n`,
  )
}

async function collectSessionRows(
  args: Args,
  bindExplicitSource = false,
  defaultLast = 20,
): Promise<SessionSelection> {
  const groups = args.session
    ? [await resolveSelectedSession(args).then(({ adapter, ref }) => ({ adapter, refs: [ref] }))]
    : await discover({ ...args, last: args.last || defaultLast })
  return collectSessionSelection(groups, {
    workflow: args.workflow,
    maxWorkflowSessions: args.maxWorkflowSessions,
    taskScope: args.latestTurn ? 'latest' : 'all',
    bindSources: bindExplicitSource && Boolean(args.session),
  })
}

async function cmdEvidence(args: Args): Promise<void> {
  const selection = await collectSessionRows(args, true)
  const rows = selection.rows.filter((row) => row.spans.length > 0)
  if (rows.length === 0) throw new Error('no spans found for the given selection')
  warnIncompleteWorkflow(selection.workflow)
  const otlpPath = args.otlpOut ? await writeOtlpFile(rows.flatMap((row) => row.spans), args.otlpOut) : undefined
  const generatedAt = new Date().toISOString()
  const records = await Promise.all(rows.map((row) =>
    buildPolicyEvidenceRecord(row.ref, row.spans, {
      generatedAt,
      minLoopOccurrences: args.minLoop,
      maxLoopExamples: 25,
      otlpPath,
      sourceSha256: row.sourceSha256,
    }),
  ))
  if (args.out) {
    const path = await writePolicyEvidenceFile(records, args.out)
    console.log(`policy evidence → ${path}  (${records.length} session rows${otlpPath ? `, OTLP: ${otlpPath}` : ''})`)
  } else {
    process.stdout.write(serializePolicyEvidence(records))
  }
}

async function cmdIndex(args: Args): Promise<void> {
  const selection = await collectSessionRows(args)
  const rows = selection.rows.filter((row) => row.spans.length > 0)
  if (rows.length === 0) throw new Error('no spans found for the given selection')
  warnIncompleteWorkflow(selection.workflow)
  const index = await buildSessionIndexFromRows(rows, {
    minLoopOccurrences: args.minLoop,
    selection: {
      command: 'index',
      harness: args.harnessExplicit ? args.harness : undefined,
      all: args.all || undefined,
      last: args.last || undefined,
      session: args.session,
      cwd: args.cwd,
      since: args.since,
      latestTurn: args.latestTurn || undefined,
      ...(selection.workflow ? { workflow: selection.workflow } : {}),
    },
  })
  if (args.out) {
    const path = await writeSessionIndexFile(index, args.out)
    console.log(`session index → ${path}  (${index.totals.sessions} session rows)`)
  } else {
    process.stdout.write(serializeSessionIndex(index))
  }
}

async function cmdBundle(args: Args): Promise<void> {
  if (!args.session) {
    throw new Error('bundle needs --session <id|path>; run `traces list` to pick a session ID')
  }
  if (!args.out) throw new Error('bundle needs --out <dir> — a new or empty directory for the bundle')
  const { adapter, ref } = await resolveSelectedSession(args)
  const result = await assembleSessionBundle({
    adapter,
    ref,
    outDir: args.out,
    minLoopOccurrences: args.minLoop,
    log: analystLog,
  })
  const { manifest } = result
  console.log(
    `session bundle → ${result.directory}  (${manifest.files.length} file(s), ` +
      `${manifest.ledgerSlices.length} ledger slice(s), ${manifest.absent.length} recorded absent)`,
  )
}

async function cmdInspect(args: Args): Promise<void> {
  if (!args.input) throw new Error('inspect needs an index file; run `traces index --out session-index.json` first')
  const index = await readSessionIndexFile(args.input)
  const report = inspectSessionIndex(index)
  if (args.out) {
    const path = await writeInspectionReportFile(report, args.out)
    console.log(`inspection report → ${path}  (${report.totals.findings} finding(s), high ${report.totals.high})`)
  } else {
    process.stdout.write(renderInspectionReport(report))
  }
}

async function cmdExport(args: Args): Promise<void> {
  if (!args.input) throw new Error('export needs an input file; run `traces export --help` for examples')
  const format = traceEvidenceFormat(args.format)
  const attributes = await loadExportAttributes(args)
  const outPath = args.out ?? args.otlpOut
  if (outPath) {
    const result = await writeTraceEvidenceExportFile(args.input, outPath, { format, attributes })
    console.log(
      `exported ${result.spans.length} OpenInference span(s) from ${result.format} → ${result.path}` +
        ` (${result.redactionCount} redaction${result.redactionCount === 1 ? '' : 's'})`,
    )
    return
  }
  const result = await exportTraceEvidenceFile(args.input, { format, attributes })
  process.stdout.write(serializeSpans(result.spans))
}

async function cmdImportCodeTraceBench(args: Args): Promise<void> {
  if (!args.input) {
    throw new Error(
      'import-codetracebench needs the native CodeTraceBench rows JSON or JSONL file',
    )
  }
  if (!args.trajectoryDir) {
    throw new Error(
      'import-codetracebench needs --trajectory-dir with <traj_id>/steps.json directories',
    )
  }
  if (!args.out) {
    throw new Error('import-codetracebench needs a new --out directory')
  }
  if (!args.revision) {
    throw new Error(
      'import-codetracebench needs --revision with a full 40- or 64-character hexadecimal commit or digest',
    )
  }
  const controller = new AbortController()
  const interrupt = () => controller.abort(
    new Error('import-codetracebench interrupted'),
  )
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const result = await importCodeTraceBench({
      rowsPath: args.input,
      trajectoryDir: args.trajectoryDir,
      outDir: args.out,
      revision: args.revision,
      concurrency: args.concurrency,
      signal: controller.signal,
    })
    const traceCount = result.receipt.counts.traces
    const stepCount = result.receipt.counts.steps
    const spanCount = result.receipt.counts.spans
    console.log(
      `imported ${traceCount} CodeTraceBench ${traceCount === 1 ? 'trajectory' : 'trajectories'} ` +
        `(${stepCount} ${stepCount === 1 ? 'step' : 'steps'}, ` +
        `${spanCount} ${spanCount === 1 ? 'span' : 'spans'}) ` +
        `→ ${result.directory}; receipt: ${result.receiptPath}`,
    )
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
}

function traceEvidenceFormat(raw: string | undefined): TraceEvidenceFormatOption {
  const format = raw ?? 'auto'
  if (
    format !== 'auto' &&
    format !== 'policy-evidence' &&
    format !== 'sandbox-events' &&
    format !== 'openinference' &&
    format !== 'intelligence-spans' &&
    format !== 'chat-trajectory'
  ) {
    throw new Error('--format must be auto, policy-evidence, sandbox-events, openinference, intelligence-spans, or chat-trajectory')
  }
  return format
}

function parseAttributeValue(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const number = Number(raw)
    if (Number.isFinite(number)) return number
  }
  return raw
}

async function loadExportAttributes(args: Args): Promise<Record<string, unknown>> {
  const attributes: Record<string, unknown> = {}
  if (args.metadata) {
    const parsed: unknown = JSON.parse(await readFile(args.metadata, 'utf8'))
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--metadata must point to a JSON object')
    }
    Object.assign(attributes, parsed as Record<string, unknown>)
  }
  for (const attr of args.attrs) {
    const eq = attr.indexOf('=')
    if (eq <= 0) throw new Error(`--attr must be key=value, got ${attr}`)
    attributes[attr.slice(0, eq)] = parseAttributeValue(attr.slice(eq + 1))
  }
  return attributes
}

async function cmdAnalyze(args: Args): Promise<void> {
  if (args.supervisorRunDir) return cmdAnalyzeSupervisorRun(args.supervisorRunDir, args)
  const result = await investigate(args, { loadDefaultConfig: false })
  let report = result.report
  let verifySummary = ''
  if (args.verifyFindings) {
    const run = await verifyAnalyzeFindings(args, result)
    report = `${report}\n${renderVerifiedFindingsSection(run)}`
    verifySummary =
      `, verified: ${run.counts.reproduced} reproduced / ${run.counts['fix-flipped']} fix-flipped / ` +
      `${run.counts.divergent} divergent / ${run.counts['not-replayable']} not-replayable → ${run.out}`
  }
  if (args.out) {
    await saveReport(args.out, report)
    console.log(
      `report → ${args.out}  (${result.findings.length} findings, ` +
        `${result.pipelines.stuckLoops.findings.length} loops, OTLP: ${result.otlpPath}${verifySummary})`,
    )
  } else {
    console.log(report)
  }
  assertAgenticAnalystsRan(args, result.agenticPerAnalyst)
}

/**
 * Executes the analyze run's findings as sandbox replay proofs. Findings name
 * their trajectory through trace:// evidence; the executable steps and docker
 * image come from --replay-corpus, because harness session stores carry no
 * docker_config to replay — requiring the corpus up front fails louder than
 * annotating every finding as not-replayable for the same missing reason.
 */
async function verifyAnalyzeFindings(args: Args, result: TraceInvestigationResult): Promise<VerifyFindingsRun> {
  if (args.replayCorpora.length === 0) {
    throw new Error(
      'analyze --verify-findings needs the executable trajectory source: pass ' +
        '--replay-corpus name=<labels.json>::<preparedDir> (repeatable). Harness sessions ' +
        'carry no docker_config, so findings cannot be replayed from the session store alone.',
    )
  }
  if (result.findings.length === 0) {
    throw new Error('analyze --verify-findings: the analysis produced no findings to verify')
  }
  const out = args.verifyOut ?? (args.out ? `${args.out}.verify` : 'traces-verify-findings')
  return verifyFindings(result.findings, {
    source: { kind: 'corpus', corpora: args.replayCorpora.map(parseCorpusFlag) },
    out,
    apiKey: process.env.SANDBOX_API_KEY,
    baseUrl: process.env.SANDBOX_API_URL ?? DEFAULT_SANDBOX_BASE_URL,
    onProgress: (message) => process.stderr.write(`${message}\n`),
  })
}

/**
 * Supervision-tree view: what the TREE did (steers, spawn waves, concurrency,
 * idle wall, cost by role, accepted vs rejected), as opposed to the rest of
 * this CLI, which reports what happened inside one harness session.
 *
 * Every metric comes from `@tangle-network/agent-eval/supervisor-run` — this
 * function only picks a READER, then single-run vs rollup, then prints. No
 * analysis is duplicated here, and none may be added.
 *
 * Two on-disk layouts reach the same analyzer through the same port: the loops
 * supervisor's `<runDir>/ws/.agent/supervisor/<id>`, and agent-runtime's
 * `createFileRunContext` directory (`spawn-journal.jsonl` at the top level).
 * The run-context layout is checked first because it is identified by a file
 * that is actually there, rather than by the absence of another layout.
 */
async function cmdAnalyzeSupervisorRun(runDir: string, args: Args): Promise<void> {
  const runContextDirs = await findFileRunContextDirs(runDir)
  const nested = runContextDirs.length > 0 ? [] : await findSupervisorRunDirs(runDir)
  let markdown: string
  if (runContextDirs.length > 1) {
    markdown = renderSupervisorRollupMarkdown(
      rollupSupervisorRuns(
        await Promise.all(
          runContextDirs.map((dir) => analyzeSupervisorRun(fileRunContextSupervisorRunReader(dir))),
        ),
      ),
      `Supervisor rollup — ${runDir}`,
    )
  } else if (runContextDirs.length === 1) {
    markdown = renderSupervisorRunMarkdown(
      await analyzeSupervisorRun(fileRunContextSupervisorRunReader(runContextDirs[0] as string)),
    )
  } else if (nested.length > 0) {
    markdown = renderSupervisorRollupMarkdown(
      rollupSupervisorRuns(await Promise.all(nested.map((dir) => analyzeSupervisorRun(dir)))),
      `Supervisor rollup — ${runDir}`,
    )
  } else {
    const report = await analyzeSupervisorRun(runDir)
    // A path with no supervision journal analyzes cleanly into a report whose
    // every metric is unavailable. Printing that reads as "the supervisor did
    // nothing" rather than "you pointed me at the wrong directory".
    if (isUnavailable(report.orchestration.workersSpawned)) {
      throw new Error(
        `no supervisor run found at ${runDir} — expected <runDir>/spawn-journal.jsonl ` +
          '(agent-runtime createFileRunContext), <runDir>/ws/.agent/supervisor/<id> ' +
          '(or the pre-rename <runDir>/ws/.loops/supervisor/<id>), ' +
          'or a parent directory containing such runs',
      )
    }
    markdown = renderSupervisorRunMarkdown(report)
  }
  const runs = Math.max(runContextDirs.length, nested.length, 1)
  if (args.out) {
    await saveReport(args.out, markdown)
    console.log(`supervisor report → ${args.out}  (${runs === 1 ? '1 run' : `${runs} runs`})`)
  } else {
    console.log(markdown)
  }
}

/**
 * The run-context directories at or immediately under `dir`. One level only:
 * a run directory is the unit a caller names, and a deep walk would sweep up
 * unrelated runs that merely share a parent.
 */
async function findFileRunContextDirs(dir: string): Promise<string[]> {
  if (await isFileRunContextDir(dir)) return [dir]
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const found: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = join(dir, entry.name)
    if (await isFileRunContextDir(child)) found.push(child)
  }
  return found.sort()
}

async function collectImportedSpans(args: Args): Promise<CollectedSpans> {
  if (!args.input) throw new Error('input file missing')
  const attributes = await loadExportAttributes(args)
  const result = await exportTraceEvidenceFile(args.input, {
    format: traceEvidenceFormat(args.format),
    attributes,
  })
  const { sessionByTrace } = indexSessionIdsByTrace(result.spans)
  const sessions = new Map<string, OtlpSpan[]>()
  for (const span of result.spans) {
    const sessionId = sessionByTrace.get(span.trace_id)
    if (!sessionId) continue
    const grouped = sessions.get(sessionId) ?? []
    grouped.push(span)
    sessions.set(sessionId, grouped)
  }
  return {
    spans: result.spans,
    harness: result.format,
    cwds: [],
    sources: [...sessions].map(([sessionId, spans]) => sessionReportSource({
      harness: result.format,
      sessionId,
      path: args.input!,
      cwd: null,
      mtimeMs: 0,
    }, spans, sessionId)),
  }
}

/**
 * Analyst progress log for stderr. The registry's `[analyst] FAIL <id>` line
 * carries its reason only in the structured fields; a message-only sink turns
 * every engine-startup failure into an unactionable one-liner.
 */
function analystLog(msg: string, fields?: Record<string, unknown>): void {
  const error = typeof fields?.error === 'string' && fields.error ? fields.error : undefined
  const errorClass = typeof fields?.error_class === 'string' && fields.error_class ? `${fields.error_class}: ` : ''
  process.stderr.write(error ? `${msg} — ${errorClass}${error}\n` : `${msg}\n`)
}

function externalAnalyzersFromArgs(args: Args) {
  return args.analyzers.map((spec) =>
    spec === 'halo'
      ? haloAnalyzer({ defaultPrompt: args.analyzerPrompt, model: args.model })
      : spec === 'hodoscope'
        ? hodoscopeAnalyzer({ summarizeModel: args.model })
      : spec === 'prime'
        ? primeAnalyzer({ defaultPrompt: args.analyzerPrompt, ...(args.model ? { model: args.model } : {}) })
      : commandAnalyzer({ name: spec, command: spec, args: (p, prompt) => (prompt ? [p, prompt] : [p]) }),
  )
}

async function cmdInvestigate(args: Args): Promise<void> {
  const result = await investigate(args)
  if (args.out) {
    await saveReport(args.out, result.report)
    console.log(`investigation report → ${args.out}  (${result.findings.length} findings with actions, OTLP: ${result.otlpPath})`)
  } else {
    console.log(result.report)
  }
  assertAgenticAnalystsRan(args, result.agenticPerAnalyst)
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

async function investigate(args: Args, options: { loadDefaultConfig?: boolean } = {}) {
  const collected = await collectSpans(args)
  const { spans, harness, cwds, sources, workflow } = collected
  if (spans.length === 0) throw new Error('no spans found for the given selection')
  const config = args.config !== undefined || options.loadDefaultConfig !== false
    ? await loadTracesConfig(args.config)
    : undefined
  const analystModel = args.model ?? process.env.TRACES_ANALYST_MODEL ?? DEFAULT_ANALYST_MODEL
  const engine = args.llm ? buildAnalysisEngine(analystModel, args.budget) : undefined
  return runTraceInvestigation(mergeTracesConfig({
    spans,
    harness,
    sources,
    workflow,
    cwds,
    minLoopOccurrences: args.minLoop,
    engine,
    model: args.llm ? analystModel : args.model,
    budgetUsd: args.budget,
    otlpOutPath: args.otlpOut,
    externalAnalyzers: externalAnalyzersFromArgs(args),
    analyzerPrompt: args.analyzerPrompt,
    log: analystLog,
    ...conformanceOptions(collected),
  }, config))
}

async function cmdImprove(args: Args): Promise<void> {
  const collected = await collectSpans(args)
  const { spans, harness, cwds, sources, workflow } = collected
  if (spans.length === 0) throw new Error('no spans found for the given selection')
  const config = await loadTracesConfig(args.config)
  const analystModel = args.model ?? process.env.TRACES_ANALYST_MODEL ?? DEFAULT_ANALYST_MODEL
  const engine = args.llm ? buildAnalysisEngine(analystModel, args.budget) : undefined
  const result = await runTraceImprovement({
    ...mergeTracesConfig({
      spans,
      harness,
      sources,
      workflow,
      cwds,
      minLoopOccurrences: args.minLoop,
      engine,
      model: args.llm ? analystModel : args.model,
      budgetUsd: args.budget,
      otlpOutPath: args.otlpOut,
      externalAnalyzers: externalAnalyzersFromArgs(args),
      analyzerPrompt: args.analyzerPrompt,
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
  assertAgenticAnalystsRan(args, result.agenticPerAnalyst)
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
  throw new Error(`unknown stream mode "${raw}" (expected visualizer, findings, or agent)`)
}

function streamPreset(args: Args): { mode: StreamMode; includeSpans: boolean; includeFindings: boolean; includeBatches: boolean; includeReports: boolean } {
  const mode = streamMode(args.mode)
  return {
    mode,
    includeSpans: !args.noSpans && mode === 'visualizer',
    includeFindings: !args.noFindings,
    includeBatches: true,
    includeReports: mode === 'agent',
  }
}

async function streamExplicitSession(args: Args, extraAnalysts: readonly TraceLiveAnalyst[] | undefined): Promise<void> {
  if (!args.session) throw new Error('streamExplicitSession needs --session')
  const adapter = resolveAdapter(args.harness)
  if (!adapter) throw new Error(`unknown harness "${args.harness}"`)
  const preset = streamPreset(args)
  const st = await stat(args.session)
  const ref: SessionRef = {
    harness: adapter.harness,
    sessionId: basename(args.session),
    path: resolve(args.session),
    cwd: args.cwd ?? null,
    mtimeMs: st.mtimeMs,
  }
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

async function cmdStream(args: Args): Promise<void> {
  const config = await loadTracesConfig(args.config)
  const preset = streamPreset(args)
  const source = args.otlp ?? args.input
  if (source) {
    const { spans, harness } = args.otlp
      ? await collectOtlpSpans(args.otlp)
      : await collectImportedSpans(args)
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
  if (args.session) {
    await streamExplicitSession(args, config?.liveAnalysts)
    return
  }

  const all = args.all || (!args.harnessExplicit && !args.cwd)
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
 * `traces watch <target>` tails one RUN TREE. The existing no-positional form
 * is untouched; a path selects the tree view.
 */
async function cmdWatch(args: Args): Promise<void> {
  const target = args.supervisorRunDir ?? args.input
  if (target !== undefined) return cmdWatchRunTarget(target, args)
  const all = args.all || (!args.harnessExplicit && !args.cwd)
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
    minLoopOccurrences: args.minLoop,
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
async function cmdWatchRunTarget(dir: string, args: Args): Promise<void> {
  const target = await resolveRunWatchTarget(resolve(dir))
  const controller = new AbortController()
  if (!args.once) {
    process.once('SIGINT', () => controller.abort())
    process.stderr.write(
      `traces watch: tailing ${target.requested} every ${args.interval}s; read-only, ` +
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

async function cmdUpload(args: Args): Promise<void> {
  const sinceMs = args.since ? parseSince(args.since) : Date.now() - 24 * 60 * 60 * 1000
  // Default to ALL harnesses unless a specific --harness was given.
  const all = args.all || !args.harnessExplicit
  const plan = await planUpload({
    all,
    harnesses: args.harnessExplicit ? [args.harness] : undefined,
    cwd: args.cwd,
    sinceMs,
  })

  const redactorParts = args.redactorCmd?.split(/\s+/).filter(Boolean) ?? []
  const redactor = redactorParts[0] ? commandRedactor({ command: redactorParts[0], args: redactorParts.slice(1) }) : undefined

  const candidates = plan.items
  const byRule: Record<string, number> = {}
  let totalRedactions = 0
  for (const i of candidates) {
    totalRedactions += i.redaction.redactionCount
    for (const [r, n] of Object.entries(i.redaction.byRule)) byRule[r] = (byRule[r] ?? 0) + n
  }

  const w = (s: string) => process.stderr.write(s)
  w(`\nWindow: since ${new Date(sinceMs).toISOString()}\n`)
  w(`Sessions found: ${plan.items.length}  ·  final privacy-mode dedup runs before upload\n`)
  w(`PII/secrets redacted: ${totalRedactions}${Object.keys(byRule).length ? ` (${Object.entries(byRule).map(([r, n]) => `${r}:${n}`).join(', ')})` : ''}\n`)
  for (const i of candidates.slice(0, 25)) {
    w(`  + [${i.ref.harness}] ${i.ref.sessionId.slice(0, 8)}  ${i.spans.length} spans  ${i.redaction.redactionCount} redacted  ${i.ref.cwd ?? ''}\n`)
  }
  if (candidates.length > 25) w(`  … and ${candidates.length - 25} more\n`)

  if (candidates.length === 0) {
    console.log('No sessions found to upload.')
    return
  }

  if (args.dryRun) {
    const res = await executeUpload(plan, { dryRun: true, otlpOut: args.otlpOut, stripContent: args.noContent, redactor })
    console.log(`dry run: ${candidates.length - res.skippedSessions} session(s), ${totalRedactions} redaction(s). Redacted OTLP -> ${res.otlpPath}`)
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

  const res = await executeUpload(plan, { log: (m) => w(`${m}\n`), stripContent: args.noContent, redactor })
  console.log(
    `Uploaded ${res.uploadedSessions} session(s), ${res.acceptedSpans} spans accepted, ` +
      `${res.redactionCount} redaction(s); ${res.skippedSessions} already-uploaded skipped.`,
  )
}

function usageExport(): void {
  console.log(`traces export: convert trace evidence files to OpenInference JSONL

Usage:
  traces export <input.jsonl|input.json> --out <spans.jsonl> [--format auto]
  traces export <input.json> --attr task.id=abc --attr arm=baseline --out spans.jsonl
  traces export <input.json> --metadata run-metadata.json --out spans.jsonl
  traces export <input.jsonl|input.json> > spans.jsonl

Input formats:
  policy-evidence  Compact JSONL rows from \`traces evidence --out policy-evidence.jsonl\`
  sandbox-events   JSON arrays with start/raw/result/done/error events
  openinference    Existing OpenInference JSONL; rewrites through traces redaction
  intelligence-spans  JSONL rows exported from Tangle Intelligence trace spans
  chat-trajectory  A message array or objects with a messages array
  auto             Detect the format from the file contents (default)

Examples:
  traces evidence --all --since 24h --out policy-evidence.jsonl
  traces export policy-evidence.jsonl --out spans.openinference.jsonl
  traces export sandbox-events.json --format sandbox-events --out spans.openinference.jsonl
  traces export intelligence-spans.jsonl --out spans.openinference.jsonl
  traces export sandbox-events.json --attr task.id=aec-001 --attr outcome.score=1 --out spans.openinference.jsonl
  halo spans.openinference.jsonl --prompt "Analyze this trace slice" --max-turns 1

Safety:
  export runs the same local regex redaction used by upload before writing spans.
  --metadata must be a JSON object; --attr key=value is repeatable and overrides matching metadata keys.`)
}

function usageImportCodeTraceBench(): void {
  console.log(`traces import-codetracebench: write one label-free OTLP file per trajectory

Usage:
  traces import-codetracebench <rows.jsonl|rows.json> \\
    --trajectory-dir <normalized-dir> --out <new-trace-dir> \\
    --revision <40-or-64-character-hex> [--concurrency 4]

Input layout:
  <normalized-dir>/<traj_id>/steps.json
  <normalized-dir>/<traj_id>/task.md    optional

The command validates every native step, rejects annotation leakage, writes
<traj_id>.otlp.jsonl files, and records input and output SHA-256 hashes in
codetracebench-import.json. The output directory must not already exist.`)
}

function usageValidate(): void {
  console.log(`traces validate: report what a trace can and cannot answer

Usage:
  traces validate <file.jsonl|dir> [--out conformance.md]

Reads OTLP-JSONL and prints the conformance report from
@tangle-network/agent-trace-contract:

  - findings by severity, each naming the CONSEQUENCE of the defect and the
    capabilities it blocks
  - the capability table: token-accounting, cost-attribution, tool-usage,
    loop-convergence, tree-comparison, steering-chain, latency-analysis —
    available or not, with the trace's own reason
  - rows that could not be read at all, with the line and the reason

A directory reads the OTLP files under it, recursively — only the otlp/
subdirectory when the producer made one. A run directory's raw event, stream and
SDK logs are also *.jsonl; they are listed with what they actually hold, not read
as several hundred broken spans. Identical re-declarations of a span across
per-shot files are counted as repeats, not defects; only a repeat with DIFFERENT
content is an error.

Exit code:
  0  no error findings, and at least one capability available (warnings mean
     thinner analysis, not wrong analysis)
  1  an error finding, or nothing analysable at all — an empty file, or one
     whose every line was unreadable, answers no question and is not a pass

Nothing is fixed up: a span with an unreadable timestamp is reported, never
repaired, because a synthesized value puts invented work into a total.

Examples:
  traces validate spans.otlp.jsonl
  traces validate results/sessions --out conformance.md
  traces validate spans.otlp.jsonl && traces analyze --otlp spans.otlp.jsonl`)
}

function usage(): void {
  console.log(`traces: analyze agent traces — yours, or any system's

Two ways in:
  --otlp <file|dir>   Spans a system already emitted in the
                      @tangle-network/agent-trace-contract shape. No adapter, no
                      translation. This is how you integrate a NEW system.
  --harness <id>      Run an adapter over a coding agent's proprietary session
                      store (Claude Code, Codex, OpenCode, …) — the legacy edge,
                      for formats we do not control.

Commands:
  validate  Report what a trace can and cannot answer (exit 1 on error findings)
  list      List discovered sessions
  analyze   Run analyst suite + loop/waste pipelines over OTLP (--otlp), sessions,
            or an input file; names every analysis the spans could not support
            (--supervisor-run-dir <dir> reports a supervision tree instead)
  investigate Run typed investigation flow, including BYO config + evidence-backed actions
  improve   Write findings, evidence, report, and canonical trace artifacts
  convert   Emit OTLP-JSONL only, to --otlp-out (HALO: use analyze --analyzer halo)
  index     Emit a reusable session index JSON for later investigation
  bundle    Assemble one session's durable evidence directory: transcript +
            subagents, derived index/report/evidence/OTLP, the repo's .evolve
            ledger sliced to the session window, git log, and a sha256 manifest
            (needs --session <id|path> and --out <new-dir>)
  inspect   Read a session index and print ranked improvement findings
  export    Convert evidence/events files to OpenInference JSONL for HALO
  import-codetracebench
            Convert CodeTracer-normalized CodeTraceBench trajectories in bulk
  replay-verify
            Replay a trajectory prefix in a sandbox, execute step k both recorded
            and corrected, and emit an executed-proof verdict (--help for flags)
  replay-verify-batch
            Measure replayability + fix-flip rates across gold-labeled corpora:
            arm A per replayable case, LLM-generated arm-B fixes (--help for flags)
  verify-findings
            Execute recorded analyst findings as sandbox replay proofs: each
            finding → reproduced | fix-flipped | divergent | not-replayable,
            with a receipt directory per finding (--help for flags)
  evidence  Emit compact session-evidence JSONL for downstream policy miners
  stream    Emit JSONL trace stream events for live visualizers or replay
  watch     Online observer: tail active sessions, notify on loops + semantic findings
            (watch <target> tails ONE run tree instead: a run directory or a span file)
  upload    Redact + upload sessions in a time window to the Tangle Intelligence Platform

Options:
  --harness <id>   Harness or alias (default: claude-code). Known: ${knownHarnesses().join(', ')}
  --all            Sweep every known harness
  --last <n>       Most-recent N sessions
  --current        Analyze the active Codex session named by CODEX_THREAD_ID
  --latest-turn    Limit a resumed Codex or Claude Code session to its latest task turn
  --session <id|path> Analyze one listed session ID or one explicit harness session file
  --workflow       Expand selected sessions through stable parent/child session IDs
  --max-workflow-sessions <n>
                   Stop workflow expansion before parsing more than N files (default 100)
  --cwd <dir>      Filter sessions by working directory
  --supervisor-run-dir <dir>
                   analyze: report a SUPERVISION TREE instead of harness sessions —
                   steers, spawn waves, concurrency, idle wall, cost by role,
                   accepted vs rejected. Rolls up when the dir holds many runs.
                   watch: same directory, live. Reads the loops layout, the
                   agent-runtime createFileRunContext journal, and OTLP span files.
  --since <t>      upload: window, 30m / 2h / 7d or an ISO date (default 24h); analyze: ISO cutoff
  --out <path>     Write report to a file
  --dir <path>     improve: write artifacts to this directory
  --otlp <file|dir>  READ OTLP-JSONL emitted by any system, skipping the adapters.
                   A directory reads the OTLP files under it — only the otlp/
                   subdirectory when the producer made one — and names the JSONL
                   that is not OTLP instead of reading it as broken spans.
                   Supported by: validate, analyze, investigate, improve, stream.
                   On a WRITING command it is the deprecated spelling of
                   --otlp-out; it still works, with a warning, until 0.12.
  --otlp-out <path>  WRITE the OTLP-JSONL artifact here (also evidence
                   provenance / dry-run upload preview)
  --format <kind>  analyze/export: auto | policy-evidence | sandbox-events | openinference | intelligence-spans | chat-trajectory
  --metadata <json> analyze/export file: attach JSON object fields as span attributes
  --attr <k=v>     analyze/export file: attach one span attribute (repeatable)
  --mode <kind>    stream: visualizer | findings | agent (default visualizer)
  --replay, --once stream: scan once and exit (default for positional input / --session)
  --once           watch <target>: print ONE snapshot and exit, for scripts and agents
  --no-spans       stream: omit per-span pulse events
  --no-findings    stream: omit semantic live-finding events
  --llm            Enable agentic RLM analysts. Runs on the Tangle router by
                   default (TANGLE_API_KEY); OPENAI_API_KEY alone targets OpenAI,
                   OPENAI_BASE_URL overrides the endpoint. Needs Python with
                   agent-eval-rpc[dspy] (TRACES_PYTHON selects the interpreter),
                   version-matched to this package's @tangle-network/agent-eval.
                   Exits 1 when every agentic analyst fails, with each reason.
  --model <id>     Model for --llm, HALO, and Hodoscope (default for --llm: ${DEFAULT_ANALYST_MODEL})
  --config <path>  investigate/improve/stream: JS config with analysts, liveAnalysts, or external analyzers
  --budget <usd>   USD cap for agentic analysts
  --analyzer <id>  analyze: also run halo, hodoscope, prime, or an installed command (repeatable)
                   prime posts the full span projection to an OpenAI-compatible bridge
                   (TRACES_PRIME_BRIDGE_URL, default http://localhost:4181;
                   TRACES_PRIME_MODEL, default prime/zai/glm-5.2; TRACES_PRIME_TIMEOUT_MS)
  --analyzer-prompt <p>  analyze: prompt passed to external analyzers (default: diagnose)
  --verify-findings analyze: execute the findings as sandbox replay proofs and mark
                   each VERIFIED (receipt path) or UNVERIFIABLE (reason). Needs
                   --replay-corpus + a running sandbox (SANDBOX_API_KEY/_URL)
  --replay-corpus name=<labels.json>::<preparedDir>
                   trajectory source for --verify-findings (repeatable)
  --verify-out <dir> receipt root for --verify-findings (default: <--out>.verify)
  --interval <s>   watch/stream: poll interval seconds (sessions 5, run tree 2)
  --window <m>     watch/stream: only sessions active in the last N minutes (default 30)
  --min-loop <n>   Min identical repeated calls to flag a loop (default 3)
  --dry-run        upload: redact + dedup + preview, write OTLP, but do NOT send
  --no-content     upload: strip prompt/response text; send metadata only
  --redactor <cmd> upload: external PII scrubber (JSON array stdin→stdout) after the regex pass
  --yes, -y        upload: skip the confirmation prompt
  --version, -v    Print the installed traces version
  --help, -h       Show help (use \`traces validate --help\`, \`traces export --help\`,
                   or \`traces import-codetracebench --help\`)

Watch a run tree (any depth; driver spend and child spend stay separate,
and a cost the harness never priced reads "unknown", never $0):
  traces watch runs/my-run                 live tree: status, budget, driver vs child spend
  traces watch runs/my-run --once          one snapshot, then exit
  traces watch traces.otlp.jsonl           OTLP spans only — works for ANY emitter
  traces analyze --supervisor-run-dir runs/my-run   the full tree report

Upload env: TANGLE_INGEST_URL (or TANGLE_ORCHESTRATOR_URL), TANGLE_INGEST_API_KEY (or TANGLE_API_KEY), TANGLE_TENANT_ID`)
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2)
  if (rawArgs[0] === '--version' || rawArgs[0] === '-v' || rawArgs[0] === 'version') {
    console.log(`traces ${packageVersion()}`)
    return
  }
  // replay-verify and replay-verify-batch own their flag sets; dispatch before the shared parser.
  if (rawArgs[0] === 'replay-verify') {
    await cmdReplayVerify(rawArgs.slice(1))
    return
  }
  if (rawArgs[0] === 'replay-verify-batch') {
    await cmdReplayVerifyBatch(rawArgs.slice(1))
    return
  }
  if (rawArgs[0] === 'verify-findings') {
    await cmdVerifyFindings(rawArgs.slice(1))
    return
  }
  const parsedArgs = parseArgs(rawArgs)
  if (parsedArgs.help) {
    if (
      parsedArgs.command === 'import-codetracebench' ||
      (parsedArgs.command === 'help' && parsedArgs.input === 'import-codetracebench')
    ) usageImportCodeTraceBench()
    else if (parsedArgs.command === 'export' || (parsedArgs.command === 'help' && parsedArgs.input === 'export')) usageExport()
    else if (parsedArgs.command === 'validate' || (parsedArgs.command === 'help' && parsedArgs.input === 'validate')) usageValidate()
    else usage()
    return
  }
  const args = validateOtlpSelection(validateWorkflowSelection(applyCurrentSessionSelection(parsedArgs)))
  switch (args.command) {
    case 'help':
      if (args.input === 'import-codetracebench') usageImportCodeTraceBench()
      else if (args.input === 'export') usageExport()
      else if (args.input === 'validate') usageValidate()
      else usage()
      break
    case 'list': await cmdList(args); break
    case 'analyze': await cmdAnalyze(args); break
    case 'validate': await cmdValidate(args); break
    case 'investigate': await cmdInvestigate(args); break
    case 'improve': await cmdImprove(args); break
    case 'convert': await cmdConvert(args); break
    case 'index': await cmdIndex(args); break
    case 'bundle': await cmdBundle(args); break
    case 'inspect': await cmdInspect(args); break
    case 'export': await cmdExport(args); break
    case 'import-codetracebench': await cmdImportCodeTraceBench(args); break
    case 'evidence': await cmdEvidence(args); break
    case 'stream': await cmdStream(args); break
    case 'watch': await cmdWatch(args); break
    case 'upload': await cmdUpload(args); break
    default: usage()
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
