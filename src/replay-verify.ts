/**
 * Execution-replay verification for CodeTraceBench-style shell trajectories.
 *
 * Turns a cited analyst finding ("step k is the error-critical step") into an
 * executed proof: replay steps 1..k-1 inside a real sandbox on the
 * trajectory's own docker image, then
 *   arm A — run the recorded step k and check the recorded failure signature
 *           reproduces (returncode + a stable output substring), and
 *   arm B — run a corrected step k and check the failure vanishes.
 *
 * Built on the agent-eval counterfactual scaffold: the trajectory is ingested
 * into a TraceStore, each arm is a `runCounterfactual` meta-run, and the
 * sandbox-backed `CounterfactualRunner` here supplies the `executeFrom`
 * callback that scaffold deliberately leaves to consumers.
 *
 * Honest limits:
 * - Only SWE-style trajectories carry `docker_config.base_image`; tasks whose
 *   environment needs external compose peers cannot be replayed this way.
 * - Copy-on-write forks (`box.branch()`) are firecracker-only; on the docker
 *   driver each arm replays the prefix in its own fresh sandbox instead.
 * - Prefix divergence (recorded vs replayed returncode) is recorded per step
 *   and surfaced in the verdict, never hidden: a high divergence count is a
 *   finding about replayability, not an error of the harness.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CounterfactualContext,
  type CounterfactualRunner,
  InMemoryTraceStore,
  runCounterfactual,
  TraceEmitter,
  type TraceStore,
} from '@tangle-network/agent-eval'
import type { ToolSpan } from '@tangle-network/agent-eval'
import { Sandbox } from '@tangle-network/sandbox'
import type { CodeTraceBenchStep } from './codetracebench.js'

// ── Observation parsing ──────────────────────────────────────────────

/** Recorded returncode from a mini-SWE observation, or null when absent
 *  (terminal submit steps carry no returncode tag). */
export function parseRecordedReturncode(observation: string | null): number | null {
  if (!observation) return null
  const m = /<returncode>(-?\d+)<\/returncode>/.exec(observation)
  return m ? Number(m[1]) : null
}

/** Text between the observation's <output> tags, or the raw observation when
 *  the tags are absent. */
export function parseObservationOutput(observation: string | null): string {
  if (!observation) return ''
  const m = /<output>\n?([\s\S]*?)\n?<\/output>/.exec(observation)
  return m ? m[1]! : observation
}

/**
 * Stable failure-signature candidate: the first line of the recorded output
 * that contains the word "error". Null when no such line exists — the verdict
 * then falls back to returncode-only matching and says so.
 * Pass an explicit signature to override (compiler quote glyphs vary with
 * locale, so a hand-picked ASCII substring is often more robust).
 */
export function deriveFailureSignature(observation: string | null): string | null {
  const line = parseObservationOutput(observation)
    .split('\n')
    .find((l) => /\berror\b/i.test(l))
  return line ? line.trim().slice(0, 200) : null
}

// ── Ingest: CodeTraceBench steps → agent-eval trace run ──────────────

export interface IngestedTrajectory {
  runId: string
  stepCount: number
}

/**
 * Emit one tool span per trajectory step, in order, with a monotonic
 * injected clock so `buildTrajectory` ordering is deterministic even when
 * two spans would share a Date.now() millisecond.
 */
export async function ingestCodeTraceBenchSteps(
  store: TraceStore,
  steps: readonly CodeTraceBenchStep[],
  caseId: string,
): Promise<IngestedTrajectory> {
  let tick = 0
  const emitter = new TraceEmitter(store, { now: () => ++tick })
  await emitter.startRun({
    scenarioId: caseId,
    tags: { source: 'codetracebench-replay', caseId },
  })
  for (const step of steps) {
    if (typeof step.action !== 'string' || step.action.length === 0) {
      throw new Error(`replay-verify: step ${step.step_id} has no action`)
    }
    const handle = await emitter.tool({
      name: `step:${step.step_id}`,
      toolName: 'shell',
      args: { command: step.action },
      result: {
        returncode: parseRecordedReturncode(step.observation),
        observation: step.observation,
      },
    })
    await handle.end()
  }
  await emitter.endRun({ pass: true, notes: 'recorded trajectory (ingested for replay)' })
  return { runId: emitter.runId, stepCount: steps.length }
}

// ── Exec backend (sandbox-backed in production, fakeable in tests) ───

export interface ReplayExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface ReplayExecSession {
  exec(command: string, timeoutMs: number): Promise<ReplayExecResult>
  close(): Promise<void>
}

export interface ReplayExecBackend {
  open(): Promise<ReplayExecSession>
}

export interface SandboxReplayBackendOptions {
  image: string
  apiKey: string
  baseUrl: string
  maxLifetimeSeconds?: number
  /**
   * The local SDK-adapter test harness does not translate `agent: false`
   * into the platform-control-runtime marker the way the production
   * sandbox API does, so images without node need the marker passed as
   * container env. Harmless against the production API path. Default true.
   */
  platformRuntimeEnvMarker?: boolean
}

/** One fresh sandbox per open(); close() deletes it. */
export function sandboxReplayBackend(options: SandboxReplayBackendOptions): ReplayExecBackend {
  const client = new Sandbox({ apiKey: options.apiKey, baseUrl: options.baseUrl })
  return {
    async open(): Promise<ReplayExecSession> {
      const box = await client.create({
        environment: options.image,
        agent: false,
        ephemeral: true,
        maxLifetimeSeconds: options.maxLifetimeSeconds ?? 1800,
        ...(options.platformRuntimeEnvMarker === false
          ? {}
          : { env: { SIDECAR_PLATFORM_CONTROL_RUNTIME: 'true' } }),
      })
      await box.waitFor('running')
      return {
        async exec(command: string, timeoutMs: number): Promise<ReplayExecResult> {
          const r = await box.exec(command, { timeoutMs })
          return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
        },
        async close(): Promise<void> {
          await box.delete()
        },
      }
    },
  }
}

/**
 * mini-SWE runs every action as a fresh /bin/sh subshell from a fixed
 * workdir. Reproduce that exactly — and stay quote-proof for arbitrary
 * recorded actions — by piping the base64 of the action into `sh` after
 * cd-ing to the workdir. Exit code is sh's, i.e. the action's.
 */
export function wrapActionForExec(action: string, cwd: string): string {
  const b64 = Buffer.from(action, 'utf8').toString('base64')
  const quotedCwd = `'${cwd.replaceAll("'", `'\\''`)}'`
  return `cd ${quotedCwd} && printf %s ${b64} | base64 -d | sh`
}

// ── Sandbox-backed CounterfactualRunner ──────────────────────────────

export interface PrefixDivergence {
  step: number
  expectedReturncode: number | null
  actualExit: number
}

export interface PrefixReplayResult {
  prefixExecuted: number
  prefixDivergences: PrefixDivergence[]
  wallMs: number
}

export interface ArmExecutionResult {
  command: string
  exitCode: number
  stdout: string
  stderr: string
  wallMs: number
}

export interface SandboxCounterfactualRunnerOptions {
  cwd: string
  stepTimeoutMs: number
  /** Execute at most this many prefix steps (from the start). Fast-iteration
   *  knob; a truncated prefix weakens state fidelity and the verdict says so. */
  prefixLimit?: number
  onProgress?: (message: string) => void
}

function toolCommand(span: ToolSpan): string {
  const args = span.args as { command?: unknown } | null
  if (!args || typeof args.command !== 'string') {
    throw new Error(`replay-verify: span ${span.name} carries no command`)
  }
  return args.command
}

function recordedReturncodeOf(span: ToolSpan): number | null {
  const result = span.result as { returncode?: unknown } | null
  return typeof result?.returncode === 'number' ? result.returncode : null
}

/**
 * Replays `ctx.prefix` in a fresh sandbox session, then executes the mutated
 * step. Divergences are recorded and never abort the replay. Results land on
 * `lastPrefix` / `lastArm` for the caller; spans for every exec land in the
 * counterfactual meta-run.
 */
export class SandboxCounterfactualRunner implements CounterfactualRunner {
  lastPrefix: PrefixReplayResult | null = null
  lastArm: ArmExecutionResult | null = null

  constructor(
    private readonly backend: ReplayExecBackend,
    private readonly options: SandboxCounterfactualRunnerOptions,
  ) {}

  async executeFrom(ctx: CounterfactualContext, emitter: TraceEmitter): Promise<void> {
    const { cwd, stepTimeoutMs, prefixLimit, onProgress } = this.options
    const session = await this.backend.open()
    try {
      const toolSteps = ctx.prefix.filter(
        (s): s is typeof s & { span: ToolSpan } => s.span.kind === 'tool',
      )
      const toExecute =
        prefixLimit !== undefined ? toolSteps.slice(0, prefixLimit) : toolSteps
      const divergences: PrefixDivergence[] = []
      const prefixStart = Date.now()
      for (const step of toExecute) {
        const command = toolCommand(step.span)
        const expected = recordedReturncodeOf(step.span)
        const started = Date.now()
        const result = await session.exec(wrapActionForExec(command, cwd), stepTimeoutMs)
        const handle = await emitter.sandbox({
          name: step.span.name,
          command,
          exitCode: result.exitCode,
          wallMs: Date.now() - started,
        })
        await handle.end()
        if (expected !== null && expected !== result.exitCode) {
          divergences.push({
            step: step.index + 1,
            expectedReturncode: expected,
            actualExit: result.exitCode,
          })
        }
        onProgress?.(
          `prefix ${step.span.name}: exit=${result.exitCode}` +
            (expected !== null && expected !== result.exitCode ? ` (recorded ${expected})` : ''),
        )
      }
      this.lastPrefix = {
        prefixExecuted: toExecute.length,
        prefixDivergences: divergences,
        wallMs: Date.now() - prefixStart,
      }

      if (ctx.mutatedStep.span.kind !== 'tool') {
        throw new Error('replay-verify: mutation target is not a tool span')
      }
      const armCommand = toolCommand(ctx.mutatedStep.span as ToolSpan)
      const armStart = Date.now()
      const armResult = await session.exec(wrapActionForExec(armCommand, cwd), stepTimeoutMs)
      const armWallMs = Date.now() - armStart
      const armHandle = await emitter.sandbox({
        name: `candidate:${ctx.mutatedStep.span.name}`,
        command: armCommand,
        exitCode: armResult.exitCode,
        wallMs: armWallMs,
      })
      await armHandle.end()
      this.lastArm = {
        command: armCommand,
        exitCode: armResult.exitCode,
        stdout: armResult.stdout,
        stderr: armResult.stderr,
        wallMs: armWallMs,
      }
      onProgress?.(`candidate step: exit=${armResult.exitCode} in ${armWallMs}ms`)
      await emitter.endRun({
        pass: armResult.exitCode === 0,
        notes: `prefix ${toExecute.length} steps, ${divergences.length} divergences`,
      })
    } finally {
      await session.close()
    }
  }
}

// ── Verdict assembly ─────────────────────────────────────────────────

export interface ReplayVerifyOptions {
  stepsPath: string
  image: string
  /** 1-based step_id of the error-critical step (matches CodeTraceBench). */
  at: number
  /** Corrected command for arm B. Omit to run arm A only. */
  fixCommand?: string
  cwd: string
  out: string
  caseId?: string
  /** Override the auto-derived failure signature substring. */
  signature?: string
  stepTimeoutMs?: number
  prefixLimit?: number
  /** Label of the orchestrator driver backing the sandbox (reported, not probed). */
  driverLabel?: string
  /** Injectable for tests; defaults to sandboxReplayBackend(). */
  backend?: ReplayExecBackend
  apiKey?: string
  baseUrl?: string
  maxLifetimeSeconds?: number
  onProgress?: (message: string) => void
}

export interface ReplayArmVerdict {
  command: string
  exitCode: number
  wallMs: number
  prefix: PrefixReplayResult
}

export interface ReplayVerdict {
  case: string
  image: string
  driver: string
  k: number
  cwd: string
  recordedReturncode: number | null
  signature: string | null
  signatureBasis: 'returncode+output-substring' | 'returncode-only'
  prefixExecuted: number
  prefixDivergences: PrefixDivergence[]
  armA: ReplayArmVerdict & { failureSignatureMatch: boolean }
  armB: (ReplayArmVerdict & { failureVanished: boolean }) | null
  timings: { armAMs: number; armBMs: number | null; totalMs: number }
  runIds: { original: string; armA: string; armB: string | null }
}

function excerpt(text: string, limit = 2400): string {
  if (text.length <= limit) return text
  const head = text.slice(0, limit / 2)
  const tail = text.slice(-limit / 2)
  return `${head}\n… [${text.length - limit} chars elided] …\n${tail}`
}

export async function replayVerify(options: ReplayVerifyOptions): Promise<ReplayVerdict> {
  const totalStart = Date.now()
  const steps = JSON.parse(readFileSync(options.stepsPath, 'utf8')) as CodeTraceBenchStep[]
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`replay-verify: ${options.stepsPath} is not a non-empty steps array`)
  }
  const index = options.at - 1
  if (index < 0 || index >= steps.length) {
    throw new Error(`replay-verify: --at ${options.at} out of range [1, ${steps.length}]`)
  }
  const target = steps[index]!
  if (target.step_id !== options.at) {
    throw new Error(
      `replay-verify: steps[${index}].step_id=${target.step_id} != --at ${options.at}; ` +
        'steps.json must be ordered with 1-based contiguous step_ids',
    )
  }
  const caseId = options.caseId ?? options.stepsPath
  const recordedReturncode = parseRecordedReturncode(target.observation)
  const signature = options.signature ?? deriveFailureSignature(target.observation)
  const signatureBasis = signature ? 'returncode+output-substring' : 'returncode-only'

  const backend =
    options.backend ??
    sandboxReplayBackend({
      image: options.image,
      apiKey: requireOption(options.apiKey, 'apiKey'),
      baseUrl: requireOption(options.baseUrl, 'baseUrl'),
      maxLifetimeSeconds: options.maxLifetimeSeconds,
    })
  const runnerOptions: SandboxCounterfactualRunnerOptions = {
    cwd: options.cwd,
    stepTimeoutMs: options.stepTimeoutMs ?? 300_000,
    prefixLimit: options.prefixLimit,
    onProgress: options.onProgress,
  }

  const store = new InMemoryTraceStore()
  const { runId } = await ingestCodeTraceBenchSteps(store, steps, caseId)

  options.onProgress?.(`arm A: replaying ${index} prefix steps then recorded step ${options.at}`)
  const armARunner = new SandboxCounterfactualRunner(backend, runnerOptions)
  const armAStart = Date.now()
  const armAResult = await runCounterfactual(
    store,
    runId,
    { kind: 'custom', at: index, describe: 'arm-A identity replay', apply: (s) => s },
    armARunner,
  )
  const armAMs = Date.now() - armAStart
  const armAExec = requireExec(armARunner, 'arm A')
  const armAOutput = `${armAExec.stdout}\n${armAExec.stderr}`
  const failureSignatureMatch =
    recordedReturncode !== null &&
    armAExec.exitCode === recordedReturncode &&
    (signature ? armAOutput.includes(signature) : true)

  let armBRunner: SandboxCounterfactualRunner | null = null
  let armBExec: ArmExecutionResult | null = null
  let armBRunId: string | null = null
  let armBMs: number | null = null
  if (options.fixCommand) {
    const fixCommand = options.fixCommand
    options.onProgress?.(`arm B: replaying prefix then corrected step`)
    armBRunner = new SandboxCounterfactualRunner(backend, runnerOptions)
    const armBStart = Date.now()
    const armBResult = await runCounterfactual(
      store,
      runId,
      {
        kind: 'custom',
        at: index,
        describe: 'arm-B corrected step',
        apply: (step) => ({
          ...step,
          span: { ...(step.span as ToolSpan), args: { command: fixCommand } },
        }),
      },
      armBRunner,
    )
    armBMs = Date.now() - armBStart
    armBRunId = armBResult.counterfactualRunId
    armBExec = requireExec(armBRunner, 'arm B')
  }

  const armBOutput = armBExec ? `${armBExec.stdout}\n${armBExec.stderr}` : null
  const verdict: ReplayVerdict = {
    case: caseId,
    image: options.image,
    driver: options.driverLabel ?? 'docker',
    k: options.at,
    cwd: options.cwd,
    recordedReturncode,
    signature,
    signatureBasis,
    prefixExecuted: armARunner.lastPrefix?.prefixExecuted ?? 0,
    prefixDivergences: armARunner.lastPrefix?.prefixDivergences ?? [],
    armA: {
      command: armAExec.command,
      exitCode: armAExec.exitCode,
      wallMs: armAExec.wallMs,
      prefix: armARunner.lastPrefix!,
      failureSignatureMatch,
    },
    armB:
      armBExec && armBRunner
        ? {
            command: armBExec.command,
            exitCode: armBExec.exitCode,
            wallMs: armBExec.wallMs,
            prefix: armBRunner.lastPrefix!,
            failureVanished:
              armBExec.exitCode === 0 &&
              (signature && armBOutput ? !armBOutput.includes(signature) : true),
          }
        : null,
    timings: { armAMs, armBMs, totalMs: Date.now() - totalStart },
    runIds: {
      original: runId,
      armA: armAResult.counterfactualRunId,
      armB: armBRunId,
    },
  }

  mkdirSync(options.out, { recursive: true })
  writeFileSync(join(options.out, 'replay-verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`)
  writeFileSync(
    join(options.out, 'report.md'),
    renderReport(verdict, target, armAExec, armBExec),
  )
  return verdict
}

function requireOption<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`replay-verify: ${name} is required`)
  return value
}

function requireExec(runner: SandboxCounterfactualRunner, arm: string): ArmExecutionResult {
  if (!runner.lastArm) throw new Error(`replay-verify: ${arm} finished without executing step k`)
  return runner.lastArm
}

function renderReport(
  verdict: ReplayVerdict,
  target: CodeTraceBenchStep,
  armA: ArmExecutionResult,
  armB: ArmExecutionResult | null,
): string {
  const lines: string[] = []
  const divergencePct =
    verdict.prefixExecuted > 0
      ? ((verdict.prefixDivergences.length / verdict.prefixExecuted) * 100).toFixed(1)
      : '0.0'
  lines.push(`# Replay verification — ${verdict.case}`)
  lines.push('')
  lines.push(`- image: \`${verdict.image}\` (driver: ${verdict.driver})`)
  lines.push(`- error-critical step k = ${verdict.k}, cwd \`${verdict.cwd}\``)
  lines.push(`- recorded returncode at k: ${verdict.recordedReturncode ?? 'none recorded'}`)
  lines.push(
    `- failure signature (${verdict.signatureBasis}): ${
      verdict.signature ? `\`${verdict.signature}\`` : '—'
    }`,
  )
  lines.push('')
  lines.push(`## Prefix replay (steps 1..${verdict.k - 1})`)
  lines.push('')
  lines.push(
    `Executed ${verdict.prefixExecuted} steps; ${verdict.prefixDivergences.length} returncode divergences (${divergencePct}%).`,
  )
  if (verdict.prefixDivergences.length > 0) {
    lines.push('')
    lines.push('| step | recorded rc | replayed exit |')
    lines.push('| --- | --- | --- |')
    for (const d of verdict.prefixDivergences) {
      lines.push(`| ${d.step} | ${d.expectedReturncode} | ${d.actualExit} |`)
    }
  }
  lines.push('')
  lines.push('## Arm A — recorded step k, replayed')
  lines.push('')
  lines.push('```sh')
  lines.push(armA.command)
  lines.push('```')
  lines.push('')
  lines.push(
    `Exit ${armA.exitCode} in ${armA.wallMs}ms — failureSignatureMatch: **${verdict.armA.failureSignatureMatch}**`,
  )
  lines.push('')
  lines.push('Recorded observation excerpt:')
  lines.push('')
  lines.push('```')
  lines.push(excerpt(parseObservationOutput(target.observation)))
  lines.push('```')
  lines.push('')
  lines.push('Replayed stdout+stderr excerpt:')
  lines.push('')
  lines.push('```')
  lines.push(excerpt(`${armA.stdout}\n${armA.stderr}`.trim()))
  lines.push('```')
  if (armB && verdict.armB) {
    lines.push('')
    lines.push('## Arm B — corrected step k')
    lines.push('')
    lines.push('```sh')
    lines.push(armB.command)
    lines.push('```')
    lines.push('')
    lines.push(
      `Exit ${armB.exitCode} in ${armB.wallMs}ms — failureVanished: **${verdict.armB.failureVanished}** ` +
        `(prefix re-replayed in a fresh sandbox: ${verdict.armB.prefix.prefixExecuted} steps, ` +
        `${verdict.armB.prefix.prefixDivergences.length} divergences)`,
    )
    lines.push('')
    lines.push('Replayed stdout+stderr excerpt:')
    lines.push('')
    lines.push('```')
    lines.push(excerpt(`${armB.stdout}\n${armB.stderr}`.trim()))
    lines.push('```')
  }
  lines.push('')
  lines.push('## Timings')
  lines.push('')
  lines.push(
    `arm A ${verdict.timings.armAMs}ms, arm B ${verdict.timings.armBMs ?? '—'}ms, total ${verdict.timings.totalMs}ms.`,
  )
  lines.push('')
  return lines.join('\n')
}

// ── CLI ──────────────────────────────────────────────────────────────

export interface ReplayVerifyCliArgs {
  stepsPath: string
  image: string
  at: number
  fixCommand?: string
  cwd: string
  out: string
  caseId?: string
  signature?: string
  stepTimeoutMs?: number
  prefixLimit?: number
  driverLabel?: string
  baseUrl: string
  apiKeyEnv: string
  maxLifetimeSeconds?: number
}

export function parseReplayVerifyArgs(argv: readonly string[]): ReplayVerifyCliArgs | 'help' {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--help' || arg === '-h') return 'help'
    if (!arg.startsWith('--')) throw new Error(`unexpected positional argument: ${arg}`)
    const value = argv[++i]
    if (value === undefined) throw new Error(`missing value for ${arg}`)
    values.set(arg, value)
  }
  const required = (flag: string): string => {
    const v = values.get(flag)
    if (v === undefined) throw new Error(`replay-verify: ${flag} is required`)
    return v
  }
  const optionalNumber = (flag: string): number | undefined => {
    const v = values.get(flag)
    if (v === undefined) return undefined
    const n = Number(v)
    if (!Number.isFinite(n)) throw new Error(`replay-verify: ${flag} must be a number, got ${v}`)
    return n
  }
  const stepsPath = required('--steps')
  const image = required('--image')
  const at = Number(required('--at'))
  const cwd = required('--cwd')
  const out = required('--out')
  if (!Number.isInteger(at) || at < 1) {
    throw new Error(`replay-verify: --at must be a positive step_id, got ${values.get('--at')}`)
  }
  let fixCommand = values.get('--fix-command')
  const fixFile = values.get('--fix-command-file')
  if (fixCommand !== undefined && fixFile !== undefined) {
    throw new Error('replay-verify: pass --fix-command or --fix-command-file, not both')
  }
  if (fixFile !== undefined) fixCommand = readFileSync(fixFile, 'utf8').trimEnd()
  return {
    stepsPath,
    image,
    at,
    fixCommand,
    cwd,
    out,
    caseId: values.get('--case'),
    signature: values.get('--signature'),
    stepTimeoutMs: optionalNumber('--step-timeout'),
    prefixLimit: optionalNumber('--prefix-limit'),
    driverLabel: values.get('--driver-label'),
    baseUrl: values.get('--base-url') ?? process.env.SANDBOX_API_URL ?? 'http://127.0.0.1:4097',
    apiKeyEnv: values.get('--api-key-env') ?? 'SANDBOX_API_KEY',
    maxLifetimeSeconds: optionalNumber('--max-lifetime'),
  }
}

export function replayVerifyUsage(): string {
  return `traces replay-verify — replay a trajectory prefix in a sandbox and execute the counterfactual at step k

Usage:
  traces replay-verify --steps STEPS.json --image IMG --at K --cwd DIR --out DIR \\
      [--fix-command CMD | --fix-command-file FILE] [--signature SUBSTRING] \\
      [--prefix-limit N] [--step-timeout MS] [--case ID] [--driver-label NAME] \\
      [--base-url URL] [--api-key-env VAR] [--max-lifetime SECONDS]

  --steps            CodeTraceBench-normalized steps.json (1-based contiguous step_ids)
  --image            docker image from the trajectory's docker_config.base_image
  --at               step_id of the error-critical step k (arm A replays it verbatim)
  --cwd              fixed workdir every action runs from (mini-SWE semantics)
  --out              output dir; writes replay-verdict.json + report.md
  --fix-command      corrected step k for arm B; omit to run arm A only
  --signature        stable output substring proving the failure (default: first
                     line of the recorded observation containing "error")
  --prefix-limit     execute at most N prefix steps (weakens fidelity; reported)
  --step-timeout     per-exec timeout in ms (default 300000)
  --base-url         sandbox API url (default $SANDBOX_API_URL or http://127.0.0.1:4097)
  --api-key-env      env var holding the sandbox API key (default SANDBOX_API_KEY)

Requires a running sandbox orchestrator; only SWE-style trajectories that carry a
docker image are replayable. See docs/replay-verify.md for setup and limits.
`
}

export async function cmdReplayVerify(argv: readonly string[]): Promise<void> {
  const parsed = parseReplayVerifyArgs(argv)
  if (parsed === 'help') {
    process.stdout.write(replayVerifyUsage())
    return
  }
  const apiKey = process.env[parsed.apiKeyEnv]
  if (!apiKey) {
    throw new Error(
      `replay-verify: env var ${parsed.apiKeyEnv} is empty — pass --api-key-env or export it`,
    )
  }
  const verdict = await replayVerify({
    stepsPath: parsed.stepsPath,
    image: parsed.image,
    at: parsed.at,
    fixCommand: parsed.fixCommand,
    cwd: parsed.cwd,
    out: parsed.out,
    caseId: parsed.caseId,
    signature: parsed.signature,
    stepTimeoutMs: parsed.stepTimeoutMs,
    prefixLimit: parsed.prefixLimit,
    driverLabel: parsed.driverLabel,
    baseUrl: parsed.baseUrl,
    apiKey,
    maxLifetimeSeconds: parsed.maxLifetimeSeconds,
    onProgress: (message) => process.stderr.write(`${message}\n`),
  })
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`)
  const verdictLine = verdict.armB
    ? `armA.failureSignatureMatch=${verdict.armA.failureSignatureMatch} armB.failureVanished=${verdict.armB.failureVanished}`
    : `armA.failureSignatureMatch=${verdict.armA.failureSignatureMatch}`
  process.stderr.write(
    `replay-verify: ${verdictLine} (${verdict.prefixDivergences.length}/${verdict.prefixExecuted} prefix divergences) → ${parsed.out}\n`,
  )
}
