/**
 * The deterministic measures and the one rule set `analyze` and `watch` share.
 *
 * Measures (`runPipelines`) are agent-eval's shipped detectors over the
 * runtime trace store: `stuckLoopView` (same tool and arguments 3 or more
 * times in a short interval), `failureClusterView` and
 * `computeToolUseMetrics`, plus `classifyFailureFollowUps`, which splits each
 * failed call's same-tool follow-up into blind and adapted. Calls marked
 * `traces.expected_blocking` stay in the usage totals and leave the loop count.
 *
 * Rules (`defaultTraceLiveAnalysts`) turn a session's spans into findings with
 * an action and a check. `analyze` runs them over a whole session and `watch`
 * over each live batch, so a finding means the same thing in both. They read
 * the session's own agent: a span inherited from a parent, synthesized by an
 * adapter, or folded in from a subagent's transcript is not one of its acts.
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { computeToolUseMetrics } from '@tangle-network/agent-eval'
import type { ToolUseMetrics } from '@tangle-network/agent-eval'
import {
  failureClusterView,
  stuckLoopView,
  type FailureCluster,
  type FailureClusterReport,
  type StuckLoopReport,
} from '@tangle-network/agent-eval/pipelines'
import { isInheritedSpan, isSubagentSpan, isSynthesizedSpan } from './adapters/provenance.js'
import { appendAll } from './arrays.js'
import {
  failureFollowUpReport,
  failureFollowUpSequences,
  type FailureFollowUpReport,
  type FailureFollowUpSequence,
} from './failure-followup.js'
import type { OtlpSpan } from './otlp.js'
import { toRuntimeStore } from './runtime-store.js'
import { computeSessionFacts, type SessionFacts } from './session-facts.js'
import { commandLines, commandTextFromInput } from './shell-commands.js'

export interface PipelineReport {
  stuckLoops: StuckLoopReport
  failureClusters: FailureClusterReport
  toolUse: ToolUseMetrics[]
  /** Absent only on hand-built reports; runPipelines always computes it. */
  failureFollowUps?: FailureFollowUpReport
}

export interface PipelineOptions {
  /** Minimum repeated identical calls to flag a loop (default 3). */
  minLoopOccurrences?: number
}

/** The measures of one trace's spans: every view reads one run at a time. */
async function tracePipelines(spans: readonly OtlpSpan[], opts: PipelineOptions): Promise<Omit<PipelineReport, 'failureFollowUps'>> {
  const { store, runIds } = await toRuntimeStore(spans)
  // A second store only when some call is an expected wait: it would be the same store otherwise.
  const loopEligible = spans.filter((item) => item.attributes['traces.expected_blocking'] !== true)
  const loopStore = loopEligible.length === spans.length ? store : (await toRuntimeStore(loopEligible)).store
  const [stuckLoops, failureClusters, toolUse] = await Promise.all([
    stuckLoopView(loopStore, { minOccurrences: opts.minLoopOccurrences ?? 3 }),
    failureClusterView(store),
    Promise.all(runIds.map((runId) => computeToolUseMetrics(store, runId))),
  ])
  return { stuckLoops, failureClusters, toolUse }
}

/** The key `failureClusterView` groups failed runs by. */
const clusterKey = (cluster: FailureCluster): string =>
  `${cluster.failureClass}|${cluster.toolName ?? ''}|${cluster.argPrefix ?? ''}|${cluster.dimension ?? ''}`

export interface PipelineAccumulator {
  /** One batch of whole traces: a trace's spans never span two batches. */
  add(spans: readonly OtlpSpan[]): Promise<void>
  report(): PipelineReport
}

/**
 * The measures over many batches of spans, holding only what each view
 * reports. `stuckLoopView`, `failureClusterView` and `computeToolUseMetrics`
 * each read one run (trace) at a time, so running them trace by trace and
 * merging in trace order gives the report one store of every span would,
 * without that store.
 */
export function createPipelineAccumulator(opts: PipelineOptions = {}): PipelineAccumulator {
  const loops: StuckLoopReport['findings'] = []
  let loopRuns = 0
  const clusters = new Map<string, FailureCluster>()
  let totalFailures = 0
  let totalRuns = 0
  const toolUse: ToolUseMetrics[] = []
  const sequences: FailureFollowUpSequence[] = []
  return {
    async add(spans) {
      if (spans.length === 0) return
      const groups = new Map<string, OtlpSpan[]>()
      for (const span of spans) {
        const group = groups.get(span.trace_id)
        if (group) group.push(span)
        else groups.set(span.trace_id, [span])
      }
      for (const group of groups.values()) {
        const one = await tracePipelines(group, opts)
        appendAll(loops, one.stuckLoops.findings)
        loopRuns += one.stuckLoops.totalRuns
        for (const cluster of one.failureClusters.clusters) {
          const key = clusterKey(cluster)
          const held = clusters.get(key)
          if (!held) {
            clusters.set(key, { ...cluster, scenarioIds: [...cluster.scenarioIds] })
            continue
          }
          held.runCount += cluster.runCount
          for (const id of cluster.scenarioIds) if (!held.scenarioIds.includes(id)) held.scenarioIds.push(id)
        }
        totalFailures += one.failureClusters.totalFailures
        totalRuns += one.failureClusters.totalRuns
        appendAll(toolUse, one.toolUse)
      }
      appendAll(sequences, failureFollowUpSequences(spans))
    },
    report() {
      const affected = new Set(loops.map((finding) => finding.runId))
      return {
        stuckLoops: { findings: [...loops], affectedRunRatio: loopRuns > 0 ? affected.size / loopRuns : 0, totalRuns: loopRuns },
        failureClusters: { clusters: [...clusters.values()].sort((a, b) => b.runCount - a.runCount), totalFailures, totalRuns },
        toolUse: [...toolUse],
        failureFollowUps: failureFollowUpReport(sequences),
      }
    },
  }
}

export async function runPipelines(spans: readonly OtlpSpan[], opts: PipelineOptions = {}): Promise<PipelineReport> {
  const accumulator = createPipelineAccumulator(opts)
  await accumulator.add(spans)
  return accumulator.report()
}

// ── the rule set analyze and watch share ────────────────────────────────────

export type TraceLiveSeverity = 'info' | 'low' | 'medium' | 'high'

export interface TraceLiveEvidence {
  readonly kind: 'metric' | 'span' | 'pattern'
  readonly label: string
  readonly value: string
  readonly spanIds?: readonly string[]
}

export interface TraceLiveFinding {
  readonly schemaVersion: 1
  readonly kind: 'traces.live_finding'
  readonly id: string
  readonly ruleId: string
  readonly fingerprint: string
  readonly severity: TraceLiveSeverity
  readonly title: string
  readonly claim: string
  readonly action: string
  readonly check: string
  readonly evidence: readonly TraceLiveEvidence[]
  readonly session: TraceStreamSession
  readonly observedAt: string
}

export interface TraceStreamSession {
  readonly harness: string
  readonly sessionId: string
  readonly cwd: string | null
  readonly path?: string
}

export type TraceLiveActionKind = 'tool' | 'read' | 'edit' | 'verify' | 'other'

export interface TraceLiveAction {
  readonly kind: TraceLiveActionKind
  readonly spanId: string
  readonly span: OtlpSpan
  readonly toolName?: string
  /** The commands a shell call ran, one simple command per line; else the tool name. */
  readonly signature: string
  readonly errored: boolean
}

export interface TraceLiveAnalysisContext {
  readonly spans: readonly OtlpSpan[]
  /** The session's own acts, in order: no inherited, synthesized or subagent span. */
  readonly actions: readonly TraceLiveAction[]
  readonly tools: readonly OtlpSpan[]
  readonly erroredTools: readonly OtlpSpan[]
  readonly verificationActions: readonly TraceLiveAction[]
  readonly changeActions: readonly TraceLiveAction[]
  readonly session: TraceStreamSession
  readonly generatedAt: string
  readonly newSpanCount: number
  /** The facts sheet of each session in `spans`: computed on first call, or the one the caller already has. */
  readonly facts: () => readonly SessionFacts[]
}

export interface TraceLiveAnalyst {
  readonly id: string
  analyze(context: TraceLiveAnalysisContext): readonly TraceLiveFinding[]
}

function hash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function spanKind(span: OtlpSpan): string {
  return asString(span.attributes['openinference.span.kind'])?.toUpperCase() ?? 'UNKNOWN'
}

function toolName(span: OtlpSpan): string {
  return asString(span.attributes['tool.name']) ?? span.name.replace(/^tool\./, '')
}

/** The script a shell call ran (a Codex code-mode script's commands included), or undefined for a call that ran none. */
function scriptOf(span: OtlpSpan): string | undefined {
  const input = span.attributes['input.value']
  return typeof input === 'string' ? commandTextFromInput(input) : undefined
}

/**
 * A tool call the model issued. A synthesized span (a subagent lifecycle the
 * adapter assembled from harness events) matches every surface heuristic below,
 * so it is rejected first — otherwise the tool count, and the error ratio
 * derived from it, run high by one per child thread.
 */
function isTool(span: OtlpSpan): boolean {
  if (isSynthesizedSpan(span.attributes)) return false
  return spanKind(span) === 'TOOL' || span.attributes['tool.name'] != null || span.name.startsWith('tool.')
}

/** The session's own act: not history copied from a parent, not an adapter's summary, not a subagent's. */
function isOwnAct(span: OtlpSpan): boolean {
  return !isInheritedSpan(span.attributes) && !isSynthesizedSpan(span.attributes) && !isSubagentSpan(span.attributes)
}

/** Package managers whose script names say what they run. */
const PACKAGE_RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx'])
/** A package script that checks the work: `test`, `test:unit`, `check:source`, `typecheck`, … */
const CHECK_SCRIPT = /^(?:test|tests|vitest|jest|build|typecheck|tsc|lint|check|verify|e2e|ci|gate|signoff|preflight)(?::[\w:-]+)?$/u
const CHECK_PROGRAMS = new Set(['vitest', 'jest', 'pytest', 'tsc', 'eslint', 'biome', 'mocha', 'playwright', 'ruff', 'mypy', 'tox', 'bats', 'shellcheck', 'beelink-gate'])
/** Interpreters whose first argument is the script they run. */
const INTERPRETERS = new Set(['python', 'python3', 'node', 'bash', 'sh', 'zsh', 'bun', 'deno', 'tsx', 'ts-node', 'ruby'])
/** A script whose name says it checks: `verify.py`, `test_delivery.py`, `check-links.sh`, `smoke.test.ts`. */
const CHECK_SCRIPT_FILE = /(?:^|[_.-])(?:test|tests|spec|verify|check|checks|smoke|lint)(?:[_.-]|$)/u
const CHECK_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  cargo: new Set(['test', 'build', 'check', 'clippy', 'nextest']),
  go: new Set(['test', 'build', 'vet']),
  make: new Set(['test', 'check', 'build', 'lint', 'verify']),
  forge: new Set(['test', 'build']),
  deno: new Set(['test', 'check', 'lint']),
  node: new Set(['--test']),
  python: new Set(['-m']),
  python3: new Set(['-m']),
}

/**
 * True when one simple command runs a check of the work: a test, build,
 * typecheck or lint runner, or a package script of that name. The command's
 * own words decide, never its output, so a `gh pr view` whose output mentions
 * tests is not a check.
 */
function isCheckCommand(line: string): boolean {
  const words = line.split(' ').filter((word) => word.length > 0)
  const program = basename(words[0] ?? '')
  if (CHECK_PROGRAMS.has(program)) return true
  if (/[./]/u.test(words[0] ?? '') && CHECK_SCRIPT_FILE.test(program)) return true
  if (INTERPRETERS.has(program)) {
    const script = words.slice(1).find((word) => !word.startsWith('-'))
    if (script !== undefined && /\.(?:py|sh|js|mjs|cjs|ts|mts|rb)$/u.test(script) && CHECK_SCRIPT_FILE.test(basename(script))) return true
  }
  const sub = CHECK_SUBCOMMANDS[program]
  if (sub && words[1] !== undefined && sub.has(words[1])) {
    return !(program.startsWith('python') && !/^(?:pytest|unittest|mypy)$/u.test(words[2] ?? ''))
  }
  if (!PACKAGE_RUNNERS.has(program)) return false
  // `pnpm --filter pkg test`, `npm run build`, `pnpm exec vitest`, `npx tsc`: the first word that is not a flag or its value.
  for (let at = 1; at < words.length; at++) {
    const word = words[at]!
    if (word === 'run' || word === 'exec' || word === 'dlx') continue
    if (word.startsWith('-')) {
      if (/^(?:--filter|-F|-C|--dir|--prefix|-w|--workspace)$/u.test(word)) at++
      continue
    }
    return CHECK_SCRIPT.test(word) || CHECK_PROGRAMS.has(basename(word))
  }
  return false
}

/**
 * A simple command that edits source in place: `sed -i`, `perl -pi`, a patch.
 * A redirect, copy or delete is not counted: sessions write notes, scripts and
 * state files that way far more often than they change the work.
 */
const WRITE_COMMAND = /^(?:sed (?:-E |-r )?-i|perl -p?i|git apply(?! --(?:check|stat|numstat))|patch |apply_patch)/u
/** Tool names that write files. */
const WRITE_TOOL = /^(?:edit|write|multiedit|notebookedit|apply_patch|write_file|create_file|edit_file|str_replace_editor|str_replace_based_edit_tool)$/iu
/**
 * Scratch space and agent state: a file written here is a note, a script or a
 * memory, not the work a check would cover: temp directories, a scratchpad,
 * and the harness's own `.claude` and `.codex` directories.
 */
const SCRATCH_PATH = /(?:^|\s)(?:\/private)?\/tmp\/|(?:^|\s)\/var\/folders\/|\/scratchpad\/|\/\.claude\/|\/\.codex[^/]*\//u

/** The files a write tool's input names: `file_path`, `path`, `notebook_path`, or a patch's `*** Update File:` lines. */
function writtenPaths(span: OtlpSpan): string[] {
  const input = span.attributes['input.value']
  if (typeof input !== 'string') return []
  const patched = [...input.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\n"\\]+)/gu)].map((match) => match[1]!.trim())
  if (patched.length > 0) return patched
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>
    return [parsed.file_path, parsed.path, parsed.notebook_path].filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

/** A write tool call that changed the work: not one that only wrote scratch files. */
function writesWork(span: OtlpSpan): boolean {
  if (!WRITE_TOOL.test(toolName(span))) return false
  const paths = writtenPaths(span)
  return paths.length === 0 || paths.some((path) => !SCRATCH_PATH.test(path))
}

const READ_COMMAND = /^(?:cat|less|head|tail|grep|rg|sed -n|nl|ls|find|fd|git show|git diff|git log|jq)\b/u
const READ_TOOL = /^(?:read|grep|glob|ls|view|read_file|list_dir|search|find_files)$|grep|find_files/iu

/** Programs that run the command after their own options: `timeout 600 pnpm test`, `env CI=1 pnpm test`. */
const WRAPPERS = new Set(['timeout', 'env', 'nice', 'nohup', 'setsid', 'time', 'sudo', 'stdbuf', 'ionice', 'caffeinate'])
/** ssh options that take a value. */
const SSH_VALUE_OPTION = /^-[BbcDEeFIiJLlmOoPpQRSWw]$/u

/**
 * The commands one simple command runs: itself, the command a wrapper runs, or
 * each command of the script `ssh host '…'` runs on the other host. A check
 * run on a Beelink over ssh is a check.
 */
function runCommands(line: string, depth = 0): string[] {
  const words = line.split(' ').filter((word) => word.length > 0)
  let at = 0
  while (at < words.length) {
    if (/^\w+=/u.test(words[at]!)) {
      at++
      continue
    }
    if (!WRAPPERS.has(basename(words[at]!))) break
    at++
    while (at < words.length && (words[at]!.startsWith('-') || /^\d+(?:\.\d+)?[smhd]?$/u.test(words[at]!) || /^\w+=/u.test(words[at]!))) at++
  }
  const rest = words.slice(at)
  if (rest.length === 0) return []
  if (basename(rest[0]!) !== 'ssh' || depth >= 2) return [rest.join(' ')]
  let host = 1
  while (host < rest.length && rest[host]!.startsWith('-')) host += SSH_VALUE_OPTION.test(rest[host]!) ? 2 : 1
  const remote = rest.slice(host + 1).join(' ')
  return remote ? commandLines(remote).flatMap((command) => runCommands(command, depth + 1)) : []
}

/** `line` with `$NAME` and `${NAME}` replaced by the values earlier `NAME=value` commands of the script set. */
function expand(line: string, vars: ReadonlyMap<string, string>): string {
  return vars.size === 0 ? line : line.replace(/\$\{?(\w+)\}?/gu, (whole, name: string) => vars.get(name) ?? whole)
}

/** Each command line of a script with the script's own simple assignments expanded. */
function expandedLines(lines: readonly string[]): string[] {
  const vars = new Map<string, string>()
  return lines.map((line) => {
    const assignment = /^(\w+)=(\S+)$/u.exec(line)
    if (assignment) vars.set(assignment[1]!, expand(assignment[2]!, vars))
    return expand(line, vars)
  })
}

function actionKind(span: OtlpSpan, commands: readonly string[]): TraceLiveActionKind {
  if (isTool(span)) {
    const lines = expandedLines(commands)
    if (lines.flatMap((line) => runCommands(line)).some(isCheckCommand)) return 'verify'
    if (writesWork(span) || lines.flatMap((line) => runCommands(line)).some((line) => WRITE_COMMAND.test(line) && !SCRATCH_PATH.test(line))) return 'edit'
    if (READ_TOOL.test(toolName(span)) || (commands.length > 0 && commands.every((line) => READ_COMMAND.test(line)))) return 'read'
    return 'tool'
  }
  return 'other'
}

/** The session's own acts, in order, each classified as a check, an edit, a read, another tool call, or something else. */
export function classifyLiveActions(spans: readonly OtlpSpan[]): TraceLiveAction[] {
  return orderSpans(spans).filter(isOwnAct).map((span) => {
    const tool = isTool(span) ? toolName(span) : undefined
    const script = tool ? scriptOf(span) : undefined
    const commands = script === undefined ? [] : commandLines(script)
    return {
      kind: actionKind(span, commands),
      spanId: span.span_id,
      span,
      ...(tool ? { toolName: tool } : {}),
      signature: commands.length > 0 ? commands.join('\n') : tool ?? span.name,
      errored: span.status.code === 'ERROR',
    }
  })
}

function timeOf(span: OtlpSpan): number {
  const parsed = Date.parse(span.start_time)
  return Number.isFinite(parsed) ? parsed : 0
}

export function orderSpans(spans: readonly OtlpSpan[]): OtlpSpan[] {
  return [...spans].sort((a, b) => {
    const stepA = typeof a.attributes.step === 'number' ? a.attributes.step : undefined
    const stepB = typeof b.attributes.step === 'number' ? b.attributes.step : undefined
    if (stepA != null && stepB != null && stepA !== stepB) return stepA - stepB
    return timeOf(a) - timeOf(b)
  })
}

function evidence(kind: TraceLiveEvidence['kind'], label: string, value: string, spanIds?: readonly string[]): TraceLiveEvidence {
  return { kind, label, value, ...(spanIds && spanIds.length > 0 ? { spanIds } : {}) }
}

function finding(input: {
  ruleId: string
  severity: TraceLiveSeverity
  title: string
  claim: string
  action: string
  check: string
  evidence: readonly TraceLiveEvidence[]
  session: TraceStreamSession
  observedAt: string
  signature: readonly string[]
}): TraceLiveFinding {
  const fingerprint = hash([input.ruleId, ...input.signature])
  return {
    schemaVersion: 1,
    kind: 'traces.live_finding',
    id: `live.${input.ruleId}.${fingerprint}`,
    fingerprint,
    ruleId: input.ruleId,
    severity: input.severity,
    title: input.title,
    claim: input.claim,
    action: input.action,
    check: input.check,
    evidence: input.evidence,
    session: input.session,
    observedAt: input.observedAt,
  }
}

const oneLine = (text: string, cap: number): string => {
  const line = text.replace(/\s+/gu, ' ').trim()
  return line.length > cap ? `${line.slice(0, cap - 1)}…` : line
}

/**
 * A command that failed 3 or more times in a row, read from the facts sheet's
 * failing streaks (`measurements.waste.failingStreaks`): a success of the
 * command, or a turn sent in, ends a streak. `facts` and `analyze` count it
 * once, the same way.
 */
const sameFailingCommandAnalyst: TraceLiveAnalyst = {
  id: 'same-failing-command',
  analyze(context) {
    return context.facts().flatMap((facts) => (facts.measurements.waste.failingStreaks.value ?? []).map((streak) => {
      const command = streak.command === null ? `a ${streak.tool} command` : `\`${oneLine(streak.command, 120)}\``
      return finding({
        ruleId: 'same-failing-command',
        severity: 'high',
        title: 'The same command failed again and again',
        claim: `${command} failed ${streak.runs}× in a row (${streak.minutes} min).`,
        action: 'Stop rerunning it; read the first failure, change state, or choose a different diagnostic path before another run.',
        check: 'The next action should read the failing output, edit code or config, or run a narrower command before this one runs again.',
        evidence: [
          evidence('pattern', 'command', streak.command ?? streak.tool, streak.spanIds),
          evidence('metric', 'failed_runs_in_a_row', String(streak.runs)),
          evidence('metric', 'minutes', String(streak.minutes)),
        ],
        session: context.session,
        observedAt: context.generatedAt,
        signature: [streak.command ?? streak.tool, streak.at, String(streak.runs)],
      })
    }))
  },
}

/** Runs of one check command with no edit between them that make a rerun without a change. */
const RERUN_CHECKS = 3

const verificationWithoutChangeAnalyst: TraceLiveAnalyst = {
  id: 'verification-without-change',
  analyze(context) {
    // The check run most often between two edits, anywhere in the spans.
    let worst: readonly [string, string[]] | undefined
    let runs = new Map<string, string[]>()
    const settle = (): void => {
      for (const entry of runs) if (!worst || entry[1].length > worst[1].length) worst = entry
      runs = new Map()
    }
    for (const action of context.actions) {
      if (action.kind === 'edit') settle()
      else if (action.kind === 'verify') runs.set(action.signature, [...(runs.get(action.signature) ?? []), action.spanId])
    }
    settle()
    const [signature, spanIds] = worst ?? []
    if (signature === undefined || spanIds === undefined || spanIds.length < RERUN_CHECKS) return []
    return [finding({
      ruleId: 'verification-without-change',
      severity: spanIds.length >= 5 ? 'high' : 'medium',
      title: 'A check is rerun without a change',
      claim: `\`${oneLine(signature, 120)}\` ran ${spanIds.length}× with no edit between.`,
      action: 'Do not run the check again until the agent edits state or says what new signal the rerun will reveal.',
      check: 'The next action should be an edit, a targeted read, or a different, narrower check.',
      evidence: [evidence('pattern', 'check', signature, spanIds), evidence('metric', 'runs_without_an_edit', String(spanIds.length))],
      session: context.session,
      observedAt: context.generatedAt,
      signature: [signature, String(spanIds.length)],
    })]
  },
}

const highToolErrorRateAnalyst: TraceLiveAnalyst = {
  id: 'high-tool-error-rate',
  analyze(context) {
    if (context.tools.length < 4 || context.erroredTools.length / context.tools.length < 0.5) return []
    return [finding({
      ruleId: 'high-tool-error-rate',
      severity: context.erroredTools.length / context.tools.length >= 0.75 ? 'high' : 'medium',
      title: 'Tool calls are mostly failing',
      claim: `${context.erroredTools.length}/${context.tools.length} tool call(s) ended with ERROR.`,
      action: 'Switch from broad execution to diagnosis: classify the dominant error, then run one targeted command to validate the fix path.',
      check: 'The next calls should reduce the error ratio or show a new targeted diagnostic result.',
      evidence: [
        evidence('metric', 'errored_tool_calls', `${context.erroredTools.length}/${context.tools.length}`, context.erroredTools.slice(0, 20).map((span) => span.span_id)),
      ],
      session: context.session,
      observedAt: context.generatedAt,
      signature: [String(context.erroredTools.length), String(context.tools.length)],
    })]
  },
}

export const defaultTraceLiveAnalysts: readonly TraceLiveAnalyst[] = [
  sameFailingCommandAnalyst,
  verificationWithoutChangeAnalyst,
  highToolErrorRateAnalyst,
]

export interface RuleRunOptions {
  readonly session: TraceStreamSession
  readonly generatedAt: string
  readonly newSpanCount?: number
  /** The sessions' facts sheets, when the caller has them; otherwise computed on first use. */
  readonly facts?: readonly SessionFacts[]
  /** Replaces the built-in rules. */
  readonly analysts?: readonly TraceLiveAnalyst[]
  /** Adds custom rules after the built-ins. */
  readonly extraAnalysts?: readonly TraceLiveAnalyst[]
}

/** The rule context for one session's spans: its own acts, classified once. */
export function ruleContext(spans: readonly OtlpSpan[], opts: RuleRunOptions): TraceLiveAnalysisContext {
  const ordered = orderSpans(spans)
  const actions = classifyLiveActions(ordered)
  const tools = actions.filter((action) => action.toolName !== undefined).map((action) => action.span)
  let facts = opts.facts
  return {
    spans: ordered,
    actions,
    tools,
    erroredTools: tools.filter((span) => span.status.code === 'ERROR'),
    verificationActions: actions.filter((action) => action.kind === 'verify'),
    changeActions: actions.filter((action) => action.kind === 'edit'),
    session: opts.session,
    generatedAt: opts.generatedAt,
    newSpanCount: opts.newSpanCount ?? ordered.length,
    facts: () => (facts ??= computeSessionFacts(ordered)),
  }
}

/** Every rule over one context. */
export function runRules(context: TraceLiveAnalysisContext, opts: Pick<RuleRunOptions, 'analysts' | 'extraAnalysts'> = {}): TraceLiveFinding[] {
  return [...(opts.analysts ?? defaultTraceLiveAnalysts), ...(opts.extraAnalysts ?? [])].flatMap((analyst) => [...analyst.analyze(context)])
}
