/**
 * Batch replay-verification across gold-labeled CodeTraceBench corpora.
 *
 * For every replayable case (SWE-style raw trajectory with a docker image AND
 * at least one gold incorrect step) the batch:
 *   1. derives the uid-1000 replay image (the sandbox platform pins customer
 *      commands to a non-root identity, so root-owned trees must be chowned),
 *   2. replays the prefix and runs arm A — the recorded gold step k, and
 *   3. optionally generates a corrected command with one LLM call and runs
 *      arm B in its own fresh sandbox.
 *
 * Headline metrics:
 *   replayability rate — fraction of replayable cases where the prefix
 *     replays with ≤10% returncode divergence AND arm A reproduces the
 *     recorded returncode at k;
 *   fix-flip rate — fraction of arm-B-executed cases where the failure
 *     vanished (exit 0, signature absent).
 *
 * Image pulls and sandbox execs run strictly serially: pulls contend on disk
 * and registry bandwidth, and serial cases keep wall-time attribution per
 * case honest. Pull failures are report rows, never silent skips.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  InMemoryTraceStore,
  runCounterfactual,
  type ToolSpan,
} from '@tangle-network/agent-eval'
import {
  type CorpusSpec,
  type EnumerationResult,
  enumerateReplayableCases,
  parseCorpusFlag,
  type ReplayableCase,
} from './replay-corpus.js'
import {
  type ChatCompletionCaller,
  type ChatUsage,
  generateFixCommand,
  zaiChatCaller,
} from './replay-fix.js'
import { type FixLoopAttemptRecord, runFixLoop } from './replay-fix-loop.js'
import {
  deriveFailureSignature,
  ingestCodeTraceBenchSteps,
  type ReplayExecBackend,
  type ReplayVerdict,
  replayVerify,
  SandboxCounterfactualRunner,
  sandboxReplayBackend,
} from './replay-verify.js'

const execFileAsync = promisify(execFile)

// ── Derived uid-1000 replay images ───────────────────────────────────

export type ImagePreparation =
  | {
      readonly succeeded: true
      readonly value: { derivedImage: string; pulled: boolean; built: boolean }
    }
  | { readonly succeeded: false; readonly error: string }

export interface ImagePreparer {
  ensure(image: string, cwd: string): Promise<ImagePreparation>
}

export interface DockerImagePreparerOptions {
  readonly pullTimeoutMs?: number
  readonly buildTimeoutMs?: number
}

export function derivedImageTag(image: string, cwd: string): string {
  const digest = createHash('sha256').update(`${image}\n${cwd}`).digest('hex').slice(0, 12)
  return `ctb-replay:${digest}-uid1000`
}

/**
 * Pulls the base image when absent and builds `FROM <base>; RUN chown -R
 * 1000:1000 <cwd>` tagged by content hash, so repeated batches reuse both
 * the pull and the build. cwd `/` skips the chown (never chown -R /) and
 * replays on the base image directly.
 */
export function dockerImagePreparer(options: DockerImagePreparerOptions = {}): ImagePreparer {
  const pullTimeoutMs = options.pullTimeoutMs ?? 1_200_000
  const buildTimeoutMs = options.buildTimeoutMs ?? 900_000
  const imageExists = async (tag: string): Promise<boolean> => {
    try {
      await execFileAsync('docker', ['image', 'inspect', tag], { maxBuffer: 8 * 1024 * 1024 })
      return true
    } catch {
      return false
    }
  }
  const errorTail = (err: unknown): string => {
    const raw =
      err && typeof err === 'object' && 'stderr' in err && typeof err.stderr === 'string' && err.stderr.length > 0
        ? err.stderr
        : err instanceof Error
          ? err.message
          : String(err)
    return raw.trim().split('\n').slice(-3).join(' | ').slice(0, 400)
  }
  return {
    async ensure(image: string, cwd: string): Promise<ImagePreparation> {
      if (cwd === '/') {
        if (await imageExists(image)) {
          return { succeeded: true, value: { derivedImage: image, pulled: false, built: false } }
        }
        try {
          await execFileAsync('docker', ['pull', image], {
            timeout: pullTimeoutMs,
            maxBuffer: 32 * 1024 * 1024,
          })
        } catch (err) {
          return { succeeded: false, error: `pull ${image}: ${errorTail(err)}` }
        }
        return { succeeded: true, value: { derivedImage: image, pulled: true, built: false } }
      }
      const derived = derivedImageTag(image, cwd)
      if (await imageExists(derived)) {
        return { succeeded: true, value: { derivedImage: derived, pulled: false, built: false } }
      }
      let pulled = false
      if (!(await imageExists(image))) {
        try {
          await execFileAsync('docker', ['pull', image], {
            timeout: pullTimeoutMs,
            maxBuffer: 32 * 1024 * 1024,
          })
          pulled = true
        } catch (err) {
          return { succeeded: false, error: `pull ${image}: ${errorTail(err)}` }
        }
      }
      const contextDir = mkdtempSync(join(tmpdir(), 'ctb-replay-image-'))
      const quotedCwd = `'${cwd.replaceAll("'", `'\\''`)}'`
      writeFileSync(
        join(contextDir, 'Dockerfile'),
        `FROM ${image}\nRUN chown -R 1000:1000 ${quotedCwd}\n`,
      )
      try {
        await execFileAsync('docker', ['build', '-t', derived, contextDir], {
          timeout: buildTimeoutMs,
          maxBuffer: 32 * 1024 * 1024,
        })
      } catch (err) {
        return { succeeded: false, error: `build ${derived} from ${image}: ${errorTail(err)}` }
      }
      return { succeeded: true, value: { derivedImage: derived, pulled, built: true } }
    },
  }
}

// ── Batch execution ──────────────────────────────────────────────────

export interface ReplayBatchOptions {
  readonly corpora: readonly CorpusSpec[]
  readonly out: string
  readonly baseUrl?: string
  readonly apiKey?: string
  /** 'generate' = one LLM call per arm-A-reproduced case, then arm B.
   *  'loop' = iterative: failed arms feed their real output into up to
   *  --fix-attempts prompts, each executed in its own fresh sandbox. */
  readonly fix: 'none' | 'generate' | 'loop'
  /** Attempt budget per case in loop mode (default 3). */
  readonly fixAttempts?: number
  readonly fixCaller?: ChatCompletionCaller
  readonly fixModelLabel?: string
  /** Cap on LLM fix calls; eligible cases beyond it are seeded-sampled out. */
  readonly maxFixCases?: number
  readonly seed?: number
  /** Overrides the per-case recorded step timeout. */
  readonly stepTimeoutMs?: number
  readonly prefixLimit?: number
  /** Run only cases whose trajId contains this substring (smoke knob). */
  readonly caseFilter?: string
  /** Run only the first N replayable cases (smoke knob). */
  readonly caseLimit?: number
  readonly maxLifetimeSeconds?: number
  readonly preparer?: ImagePreparer
  /** Test seam: receives the derived image, returns the exec backend. */
  readonly backendFactory?: (derivedImage: string) => ReplayExecBackend
  readonly onProgress?: (message: string) => void
}

export interface ReplayBatchFixResult {
  /** false when the case was eligible but seeded-sampled out of the cap. */
  readonly attempted: boolean
  readonly sampledOut: boolean
  readonly command: string | null
  readonly llmError: string | null
  /** Loop mode: token totals summed across every attempt (null when the
   *  provider reported no usage). */
  readonly usage: ChatUsage | null
  readonly armBExit: number | null
  readonly armBPrefixExecuted: number | null
  readonly armBPrefixDivergences: number | null
  readonly failureVanished: boolean | null
  readonly armBError: string | null
  /** Loop mode only: the full per-attempt trail. Null in generate mode. */
  readonly attempts: readonly FixLoopAttemptRecord[] | null
  /** 1-based attempt that flipped the failure; null when none did.
   *  Generate mode: 1 when the single attempt flipped. */
  readonly flippedAtAttempt: number | null
}

export interface ReplayBatchCaseRow {
  readonly corpus: string
  readonly trajId: string
  readonly image: string
  readonly derivedImage: string | null
  readonly cwd: string
  readonly cwdSource: string
  readonly k: number
  readonly stepCount: number
  readonly goldIncorrectSteps: readonly number[]
  /** Gold steps before k skipped because their action is the submit command. */
  readonly submitGoldsSkipped: number
  readonly recordedReturncodeAtK: number | null
  readonly signature: string | null
  readonly status: 'ok' | 'image-unavailable' | 'replay-error'
  readonly error: string | null
  readonly imagePulled: boolean
  readonly imageBuilt: boolean
  readonly prefixExecuted: number | null
  readonly prefixDivergences: number | null
  readonly prefixDivergencePct: number | null
  readonly armAExit: number | null
  readonly armAReturncodeMatch: boolean
  readonly armASignatureMatch: boolean
  /** Headline predicate: divergence ≤10% AND arm A reproduced the returncode. */
  readonly replayed: boolean
  readonly fix: ReplayBatchFixResult | null
  readonly wallMs: number
}

export interface ReplayBatchReport {
  readonly generatedAt: string
  readonly corpora: readonly { name: string; labelsPath: string; preparedDir: string }[]
  readonly totals: {
    readonly labelEntries: number
    readonly replayable: number
    readonly executed: number
    readonly excludedByReason: Record<string, number>
    /** Per-corpus submit-gold accounting: cases dropped because every gold is
     *  the submit command, and golds skipped inside still-replayable cases. */
    readonly submitGoldsByCorpus: Record<
      string,
      { submitOnlyCases: number; goldsSkippedWithinReplayable: number }
    >
  }
  readonly headline: {
    readonly replayabilityRate: { numerator: number; denominator: number; value: number | null }
    readonly signatureStrictRate: { numerator: number; denominator: number; value: number | null }
    readonly fixFlipRate: { numerator: number; denominator: number; value: number | null } | null
    /** Fix-flip restricted to cases whose recorded returncode at k is nonzero —
     *  real recorded failures, where "the failure vanished" is not vacuous. */
    readonly fixFlipRateNonzeroRc: {
      numerator: number
      denominator: number
      value: number | null
    } | null
    /** Loop mode only: flips at attempt 1 over cases whose attempt 1 executed —
     *  the number directly comparable to the one-shot fixFlipRate. */
    readonly fixFlipAttempt1: {
      numerator: number
      denominator: number
      value: number | null
    } | null
    /** Loop mode only: flip count keyed by the attempt number that flipped. */
    readonly flipsByAttempt: Record<string, number> | null
  }
  readonly llm: {
    readonly model: string
    readonly calls: number
    readonly failures: number
    readonly promptTokens: number
    readonly completionTokens: number
  } | null
  readonly excluded: readonly { corpus: string; trajId: string; reason: string; detail?: string }[]
  readonly pullFailures: readonly { corpus: string; trajId: string; image: string; error: string }[]
  readonly cases: readonly ReplayBatchCaseRow[]
}

/** Deterministic PRNG for the fix-case sample; the seed lands in the report. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seededSample<T>(items: readonly T[], size: number, seed: number): Set<T> {
  const pool = [...items]
  const random = mulberry32(seed)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  return new Set(pool.slice(0, size))
}

function caseOutDirName(row: { corpus: string; trajId: string }): string {
  return `${row.corpus}--${row.trajId}`.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 180)
}

interface ArmBExecution {
  readonly exitCode: number
  readonly prefixExecuted: number
  readonly prefixDivergences: number
  readonly failureVanished: boolean
  readonly stdout: string
  readonly stderr: string
}

/**
 * Arm B standalone: fresh sandbox, prefix replay, corrected step k. Reuses
 * the same counterfactual scaffold as replayVerify without re-running arm A.
 */
async function executeArmB(
  replayCase: ReplayableCase,
  fixCommand: string,
  backend: ReplayExecBackend,
  signature: string | null,
  stepTimeoutMs: number,
  prefixLimit: number | undefined,
  onProgress?: (message: string) => void,
): Promise<ArmBExecution> {
  const store = new InMemoryTraceStore()
  const { runId } = await ingestCodeTraceBenchSteps(store, replayCase.steps, replayCase.trajId)
  const runner = new SandboxCounterfactualRunner(backend, {
    cwd: replayCase.cwd,
    stepTimeoutMs,
    prefixLimit,
    onProgress,
  })
  await runCounterfactual(
    store,
    runId,
    {
      kind: 'custom',
      at: replayCase.k - 1,
      describe: 'arm-B corrected step',
      apply: (step) => ({
        ...step,
        span: { ...(step.span as ToolSpan), args: { command: fixCommand } },
      }),
    },
    runner,
  )
  const exec = runner.lastArm
  if (!exec) throw new Error('arm B finished without executing the corrected step')
  const output = `${exec.stdout}\n${exec.stderr}`
  return {
    exitCode: exec.exitCode,
    prefixExecuted: runner.lastPrefix?.prefixExecuted ?? 0,
    prefixDivergences: runner.lastPrefix?.prefixDivergences.length ?? 0,
    failureVanished: exec.exitCode === 0 && (signature ? !output.includes(signature) : true),
    stdout: exec.stdout,
    stderr: exec.stderr,
  }
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

export async function runReplayBatch(options: ReplayBatchOptions): Promise<ReplayBatchReport> {
  const onProgress = options.onProgress ?? (() => {})
  const enumeration: EnumerationResult = enumerateReplayableCases(options.corpora)
  let selected = enumeration.replayable
  if (options.caseFilter) {
    selected = selected.filter((c) => c.trajId.includes(options.caseFilter!))
  }
  if (options.caseLimit !== undefined) selected = selected.slice(0, options.caseLimit)
  onProgress(
    `enumerated ${enumeration.labelEntryCount} label entries → ${enumeration.replayable.length} replayable, ` +
      `${enumeration.excluded.length} excluded; executing ${selected.length}`,
  )

  const preparer = options.preparer ?? dockerImagePreparer()
  const backendFactory =
    options.backendFactory ??
    ((derivedImage: string) =>
      sandboxReplayBackend({
        image: derivedImage,
        apiKey: requireOption(options.apiKey, 'apiKey'),
        baseUrl: requireOption(options.baseUrl, 'baseUrl'),
        maxLifetimeSeconds: options.maxLifetimeSeconds ?? 3600,
      }))

  mkdirSync(options.out, { recursive: true })
  const progressPath = join(options.out, 'cases.jsonl')
  const rows: ReplayBatchCaseRow[] = []
  const pullFailures: { corpus: string; trajId: string; image: string; error: string }[] = []

  // Phase 1 — arm A for every selected case, serially.
  const verdictByTraj = new Map<string, ReplayVerdict>()
  for (const [index, replayCase] of selected.entries()) {
    const caseStart = Date.now()
    const label = `[${index + 1}/${selected.length}] ${replayCase.corpus}/${replayCase.trajId}`
    onProgress(`${label}: preparing image ${replayCase.image}`)
    const preparation = await preparer.ensure(replayCase.image, replayCase.cwd)
    const base = {
      corpus: replayCase.corpus,
      trajId: replayCase.trajId,
      image: replayCase.image,
      cwd: replayCase.cwd,
      cwdSource: replayCase.cwdSource,
      k: replayCase.k,
      stepCount: replayCase.steps.length,
      goldIncorrectSteps: replayCase.goldIncorrectSteps,
      submitGoldsSkipped: replayCase.submitGoldsSkipped,
      recordedReturncodeAtK: replayCase.recordedReturncodeAtK,
    }
    if (!preparation.succeeded) {
      pullFailures.push({
        corpus: replayCase.corpus,
        trajId: replayCase.trajId,
        image: replayCase.image,
        error: preparation.error,
      })
      const row: ReplayBatchCaseRow = {
        ...base,
        derivedImage: null,
        signature: null,
        status: 'image-unavailable',
        error: preparation.error,
        imagePulled: false,
        imageBuilt: false,
        prefixExecuted: null,
        prefixDivergences: null,
        prefixDivergencePct: null,
        armAExit: null,
        armAReturncodeMatch: false,
        armASignatureMatch: false,
        replayed: false,
        fix: null,
        wallMs: Date.now() - caseStart,
      }
      rows.push(row)
      appendFileSync(progressPath, `${JSON.stringify(row)}\n`)
      onProgress(`${label}: image unavailable — ${preparation.error}`)
      continue
    }
    const { derivedImage, pulled, built } = preparation.value
    const stepTimeoutMs = options.stepTimeoutMs ?? replayCase.recordedStepTimeoutMs ?? 120_000
    const caseOut = join(options.out, caseOutDirName(replayCase))
    onProgress(`${label}: arm A on ${derivedImage} (k=${replayCase.k}, timeout ${stepTimeoutMs}ms)`)
    try {
      const verdict = await replayVerify({
        stepsPath: replayCase.stepsPath,
        image: derivedImage,
        at: replayCase.k,
        cwd: replayCase.cwd,
        out: caseOut,
        caseId: replayCase.trajId,
        stepTimeoutMs,
        prefixLimit: options.prefixLimit,
        backend: backendFactory(derivedImage),
        onProgress: (message) => onProgress(`${label}: ${message}`),
      })
      verdictByTraj.set(replayCase.trajId, verdict)
      const divergencePct =
        verdict.prefixExecuted > 0
          ? (verdict.prefixDivergences.length / verdict.prefixExecuted) * 100
          : 0
      const returncodeMatch =
        verdict.recordedReturncode !== null && verdict.armA.exitCode === verdict.recordedReturncode
      const row: ReplayBatchCaseRow = {
        ...base,
        derivedImage,
        signature: verdict.signature,
        status: 'ok',
        error: null,
        imagePulled: pulled,
        imageBuilt: built,
        prefixExecuted: verdict.prefixExecuted,
        prefixDivergences: verdict.prefixDivergences.length,
        prefixDivergencePct: Number(divergencePct.toFixed(1)),
        armAExit: verdict.armA.exitCode,
        armAReturncodeMatch: returncodeMatch,
        armASignatureMatch: verdict.armA.failureSignatureMatch,
        replayed: divergencePct <= 10 && returncodeMatch,
        fix: null,
        wallMs: Date.now() - caseStart,
      }
      rows.push(row)
      appendFileSync(progressPath, `${JSON.stringify(row)}\n`)
      onProgress(
        `${label}: armA exit=${verdict.armA.exitCode} rcMatch=${returncodeMatch} ` +
          `divergences=${verdict.prefixDivergences.length}/${verdict.prefixExecuted}`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const row: ReplayBatchCaseRow = {
        ...base,
        derivedImage,
        signature: null,
        status: 'replay-error',
        error: message.slice(0, 500),
        imagePulled: pulled,
        imageBuilt: built,
        prefixExecuted: null,
        prefixDivergences: null,
        prefixDivergencePct: null,
        armAExit: null,
        armAReturncodeMatch: false,
        armASignatureMatch: false,
        replayed: false,
        fix: null,
        wallMs: Date.now() - caseStart,
      }
      rows.push(row)
      appendFileSync(progressPath, `${JSON.stringify(row)}\n`)
      onProgress(`${label}: replay error — ${message.slice(0, 200)}`)
    }
  }

  // Phase 2 — counterfactual fixes for cases where arm A reproduced.
  let llm: ReplayBatchReport['llm'] = null
  if (options.fix !== 'none') {
    const caller = options.fixCaller
    if (!caller) throw new Error(`replay-verify-batch: fix=${options.fix} requires a fixCaller`)
    const fixAttempts = options.fixAttempts ?? 3
    const maxFixCases = options.maxFixCases ?? 30
    const seed = options.seed ?? 17
    const eligible = rows.filter((r) => r.status === 'ok' && r.replayed)
    const sampled =
      eligible.length > maxFixCases
        ? seededSample(eligible, maxFixCases, seed)
        : new Set(eligible)
    if (eligible.length > maxFixCases) {
      onProgress(
        `fix phase: ${eligible.length} eligible > cap ${maxFixCases}; seeded sample (seed=${seed})`,
      )
    }
    let calls = 0
    let failures = 0
    let promptTokens = 0
    let completionTokens = 0
    for (const row of eligible) {
      const index = rows.indexOf(row)
      if (!sampled.has(row)) {
        rows[index] = {
          ...row,
          fix: {
            attempted: false,
            sampledOut: true,
            command: null,
            llmError: null,
            usage: null,
            armBExit: null,
            armBPrefixExecuted: null,
            armBPrefixDivergences: null,
            failureVanished: null,
            armBError: null,
            attempts: null,
            flippedAtAttempt: null,
          },
        }
        continue
      }
      const replayCase = selected.find((c) => c.trajId === row.trajId && c.corpus === row.corpus)!
      const label = `fix ${row.corpus}/${row.trajId}`
      const signature = verdictByTraj.get(row.trajId)?.signature ?? null
      const stepTimeoutMs = options.stepTimeoutMs ?? replayCase.recordedStepTimeoutMs ?? 120_000
      const promptInput = {
        taskStatement: replayCase.taskStatement,
        steps: replayCase.steps,
        k: replayCase.k,
      }
      const caseOut = join(options.out, caseOutDirName(row))

      if (options.fix === 'loop') {
        onProgress(`${label}: fix loop (budget ${fixAttempts} attempts)`)
        const result = await runFixLoop(
          caller,
          promptInput,
          async (command, attempt) => {
            onProgress(
              `${label}: attempt ${attempt} arm B — ${command.split('\n')[0]!.slice(0, 120)}`,
            )
            const armB = await executeArmB(
              replayCase,
              command,
              backendFactory(row.derivedImage!),
              signature,
              stepTimeoutMs,
              options.prefixLimit,
              (message) => onProgress(`${label}: attempt ${attempt}: ${message}`),
            )
            mkdirSync(caseOut, { recursive: true })
            writeFileSync(
              join(caseOut, `armB-attempt${attempt}-result.json`),
              `${JSON.stringify({ command, ...armB }, null, 2)}\n`,
            )
            // armB-result.json always holds the LAST executed attempt — the
            // flipped one when the loop flips (it stops there).
            writeFileSync(
              join(caseOut, 'armB-result.json'),
              `${JSON.stringify({ command, attempt, ...armB }, null, 2)}\n`,
            )
            return armB
          },
          { maxAttempts: fixAttempts, onProgress: (message) => onProgress(`${label}: ${message}`) },
        )
        calls += result.llmCalls
        failures += result.llmFailures
        promptTokens += result.promptTokens
        completionTokens += result.completionTokens
        const usage =
          result.promptTokens + result.completionTokens > 0
            ? { promptTokens: result.promptTokens, completionTokens: result.completionTokens }
            : null
        const flippedRecord =
          result.flippedAtAttempt !== null
            ? result.attempts.find((a) => a.attempt === result.flippedAtAttempt)!
            : null
        const summary = flippedRecord ?? [...result.attempts].reverse().find((a) => a.executed) ?? null
        const lastRecord = result.attempts.at(-1) ?? null
        rows[index] = {
          ...row,
          fix: summary
            ? {
                attempted: true,
                sampledOut: false,
                command: summary.command,
                llmError: null,
                usage,
                armBExit: summary.exitCode,
                armBPrefixExecuted: summary.prefixExecuted,
                armBPrefixDivergences: summary.prefixDivergences,
                failureVanished: summary.failureVanished,
                armBError: null,
                attempts: result.attempts,
                flippedAtAttempt: result.flippedAtAttempt,
              }
            : result.aborted
              ? {
                  attempted: true,
                  sampledOut: false,
                  command: lastRecord?.command ?? null,
                  llmError: null,
                  usage,
                  armBExit: null,
                  armBPrefixExecuted: null,
                  armBPrefixDivergences: null,
                  failureVanished: null,
                  armBError: lastRecord?.armBError ?? 'sandbox error',
                  attempts: result.attempts,
                  flippedAtAttempt: null,
                }
              : {
                  attempted: true,
                  sampledOut: false,
                  command: null,
                  llmError: lastRecord?.llmError ?? 'no attempt produced a runnable fix',
                  usage,
                  armBExit: null,
                  armBPrefixExecuted: null,
                  armBPrefixDivergences: null,
                  failureVanished: null,
                  armBError: null,
                  attempts: result.attempts,
                  flippedAtAttempt: null,
                },
        }
        onProgress(
          `${label}: loop done — flipped=${result.flipped}` +
            (result.flippedAtAttempt !== null ? ` at attempt ${result.flippedAtAttempt}` : '') +
            ` (${result.llmCalls} calls, ${result.attempts.filter((a) => a.executed).length} arms)`,
        )
        continue
      }

      onProgress(`${label}: generating corrected command`)
      calls += 1
      const generated = await generateFixCommand(caller, promptInput)
      if (!generated.succeeded) {
        failures += 1
        rows[index] = {
          ...row,
          fix: {
            attempted: true,
            sampledOut: false,
            command: null,
            llmError: generated.error,
            usage: null,
            armBExit: null,
            armBPrefixExecuted: null,
            armBPrefixDivergences: null,
            failureVanished: null,
            armBError: null,
            attempts: null,
            flippedAtAttempt: null,
          },
        }
        onProgress(`${label}: LLM failed — ${generated.error.slice(0, 200)}`)
        continue
      }
      promptTokens += generated.value.usage?.promptTokens ?? 0
      completionTokens += generated.value.usage?.completionTokens ?? 0
      onProgress(`${label}: arm B — ${generated.value.command.split('\n')[0]!.slice(0, 120)}`)
      try {
        const armB = await executeArmB(
          replayCase,
          generated.value.command,
          backendFactory(row.derivedImage!),
          signature,
          stepTimeoutMs,
          options.prefixLimit,
          (message) => onProgress(`${label}: ${message}`),
        )
        rows[index] = {
          ...row,
          fix: {
            attempted: true,
            sampledOut: false,
            command: generated.value.command,
            llmError: null,
            usage: generated.value.usage,
            armBExit: armB.exitCode,
            armBPrefixExecuted: armB.prefixExecuted,
            armBPrefixDivergences: armB.prefixDivergences,
            failureVanished: armB.failureVanished,
            armBError: null,
            attempts: null,
            flippedAtAttempt: armB.failureVanished ? 1 : null,
          },
        }
        mkdirSync(caseOut, { recursive: true })
        writeFileSync(
          join(caseOut, 'armB-result.json'),
          `${JSON.stringify({ command: generated.value.command, ...armB }, null, 2)}\n`,
        )
        onProgress(`${label}: armB exit=${armB.exitCode} failureVanished=${armB.failureVanished}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        rows[index] = {
          ...row,
          fix: {
            attempted: true,
            sampledOut: false,
            command: generated.value.command,
            llmError: null,
            usage: generated.value.usage,
            armBExit: null,
            armBPrefixExecuted: null,
            armBPrefixDivergences: null,
            failureVanished: null,
            armBError: message.slice(0, 500),
            attempts: null,
            flippedAtAttempt: null,
          },
        }
        onProgress(`${label}: arm B error — ${message.slice(0, 200)}`)
      }
    }
    llm = {
      model: options.fixModelLabel ?? 'unknown',
      calls,
      failures,
      promptTokens,
      completionTokens,
    }
  }

  const executedRows = rows.filter((r) => r.status === 'ok')
  const replayed = executedRows.filter((r) => r.replayed)
  const signatureStrict = executedRows.filter(
    (r) => r.replayed && r.armASignatureMatch,
  )
  const armBExecuted = rows.filter((r) => r.fix?.attempted && r.fix.failureVanished !== null)
  const flipped = armBExecuted.filter((r) => r.fix!.failureVanished === true)
  const armBNonzeroRc = armBExecuted.filter(
    (r) => r.recordedReturncodeAtK !== null && r.recordedReturncodeAtK !== 0,
  )
  const flippedNonzeroRc = armBNonzeroRc.filter((r) => r.fix!.failureVanished === true)
  const attempt1Executed = rows.filter(
    (r) => r.fix?.attempts?.find((a) => a.attempt === 1)?.executed === true,
  )
  const flippedAt1 = rows.filter((r) => r.fix?.flippedAtAttempt === 1)
  const flipsByAttempt: Record<string, number> = {}
  for (const row of rows) {
    const at = row.fix?.flippedAtAttempt
    if (typeof at === 'number') flipsByAttempt[String(at)] = (flipsByAttempt[String(at)] ?? 0) + 1
  }
  const excludedByReason: Record<string, number> = {}
  for (const excluded of enumeration.excluded) {
    excludedByReason[excluded.reason] = (excludedByReason[excluded.reason] ?? 0) + 1
  }
  const submitGoldsByCorpus: Record<
    string,
    { submitOnlyCases: number; goldsSkippedWithinReplayable: number }
  > = {}
  const submitEntry = (corpus: string) =>
    (submitGoldsByCorpus[corpus] ??= { submitOnlyCases: 0, goldsSkippedWithinReplayable: 0 })
  for (const excluded of enumeration.excluded) {
    if (excluded.reason === 'gold-only-submit-step') submitEntry(excluded.corpus).submitOnlyCases += 1
  }
  for (const replayCase of enumeration.replayable) {
    if (replayCase.submitGoldsSkipped > 0) {
      submitEntry(replayCase.corpus).goldsSkippedWithinReplayable += replayCase.submitGoldsSkipped
    }
  }

  const report: ReplayBatchReport = {
    generatedAt: new Date().toISOString(),
    corpora: options.corpora.map((c) => ({
      name: c.name,
      labelsPath: c.labelsPath,
      preparedDir: c.preparedDir,
    })),
    totals: {
      labelEntries: enumeration.labelEntryCount,
      replayable: enumeration.replayable.length,
      executed: selected.length,
      excludedByReason,
      submitGoldsByCorpus,
    },
    headline: {
      replayabilityRate: {
        numerator: replayed.length,
        denominator: selected.length,
        value: rate(replayed.length, selected.length),
      },
      signatureStrictRate: {
        numerator: signatureStrict.length,
        denominator: selected.length,
        value: rate(signatureStrict.length, selected.length),
      },
      fixFlipRate:
        options.fix !== 'none'
          ? {
              numerator: flipped.length,
              denominator: armBExecuted.length,
              value: rate(flipped.length, armBExecuted.length),
            }
          : null,
      fixFlipRateNonzeroRc:
        options.fix !== 'none'
          ? {
              numerator: flippedNonzeroRc.length,
              denominator: armBNonzeroRc.length,
              value: rate(flippedNonzeroRc.length, armBNonzeroRc.length),
            }
          : null,
      fixFlipAttempt1:
        options.fix === 'loop'
          ? {
              numerator: flippedAt1.length,
              denominator: attempt1Executed.length,
              value: rate(flippedAt1.length, attempt1Executed.length),
            }
          : null,
      flipsByAttempt: options.fix === 'loop' ? flipsByAttempt : null,
    },
    llm,
    excluded: enumeration.excluded,
    pullFailures,
    cases: rows,
  }
  writeFileSync(join(options.out, 'batch-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(options.out, 'batch-report.md'), renderBatchReport(report))
  return report
}

function requireOption<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`replay-verify-batch: ${name} is required`)
  return value
}

// ── Report rendering ─────────────────────────────────────────────────

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

export function renderBatchReport(report: ReplayBatchReport): string {
  const lines: string[] = []
  const { headline, totals } = report
  lines.push('# Replay-verify batch report')
  lines.push('')
  lines.push(`Generated ${report.generatedAt}.`)
  lines.push('')
  lines.push('## Headline')
  lines.push('')
  lines.push(
    `- **Replayability rate: ${pct(headline.replayabilityRate.value)}** ` +
      `(${headline.replayabilityRate.numerator}/${headline.replayabilityRate.denominator} replayable cases ` +
      'where the prefix replayed with ≤10% returncode divergence AND arm A reproduced the recorded returncode at the gold step k).',
  )
  lines.push(
    `- Signature-strict rate: ${pct(headline.signatureStrictRate.value)} ` +
      `(${headline.signatureStrictRate.numerator}/${headline.signatureStrictRate.denominator}; additionally requires the recorded error substring in arm A output).`,
  )
  if (headline.fixFlipRate) {
    lines.push(
      `- **Fix-flip rate: ${pct(headline.fixFlipRate.value)}** ` +
        `(${headline.fixFlipRate.numerator}/${headline.fixFlipRate.denominator} arm-B-executed cases where the generated fix made the failure vanish).`,
    )
  }
  if (headline.fixFlipRateNonzeroRc) {
    lines.push(
      `- Fix-flip rate on recorded-rc≠0 cases: ${pct(headline.fixFlipRateNonzeroRc.value)} ` +
        `(${headline.fixFlipRateNonzeroRc.numerator}/${headline.fixFlipRateNonzeroRc.denominator}; real recorded failures — a gold step recorded with rc 0 flips vacuously).`,
    )
  }
  if (headline.fixFlipAttempt1) {
    lines.push(
      `- Fix-flip@1: ${pct(headline.fixFlipAttempt1.value)} ` +
        `(${headline.fixFlipAttempt1.numerator}/${headline.fixFlipAttempt1.denominator} cases whose attempt 1 executed — the one-shot-comparable number).`,
    )
  }
  if (headline.flipsByAttempt && Object.keys(headline.flipsByAttempt).length > 0) {
    const parts = Object.entries(headline.flipsByAttempt)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([attempt, count]) => `attempt ${attempt}: ${count}`)
    lines.push(`- Flips by attempt: ${parts.join(', ')}.`)
  }
  lines.push('')
  lines.push('## Enumeration')
  lines.push('')
  lines.push(
    `${totals.labelEntries} label entries across ${report.corpora.length} corpora → ` +
      `${totals.replayable} replayable (SWE-style docker image + ≥1 gold incorrect step), ${totals.executed} executed.`,
  )
  lines.push('')
  lines.push('| exclusion reason | count |')
  lines.push('| --- | --- |')
  for (const [reason, count] of Object.entries(totals.excludedByReason).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${reason} | ${count} |`)
  }
  const submitEntries = Object.entries(totals.submitGoldsByCorpus)
  if (submitEntries.length > 0) {
    lines.push('')
    lines.push(
      'Submit-command golds are never counterfactual targets ' +
        '(a gold on the submit step marks a bad submit decision, not a failed command):',
    )
    lines.push('')
    lines.push('| corpus | cases excluded (all golds = submit) | golds skipped within replayable cases |')
    lines.push('| --- | --- | --- |')
    for (const [corpus, stats] of submitEntries.sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`| ${corpus} | ${stats.submitOnlyCases} | ${stats.goldsSkippedWithinReplayable} |`)
    }
  }
  if (report.pullFailures.length > 0) {
    lines.push('')
    lines.push('## Image pull/build failures')
    lines.push('')
    lines.push('| corpus | trajectory | image | error |')
    lines.push('| --- | --- | --- | --- |')
    for (const failure of report.pullFailures) {
      lines.push(
        `| ${failure.corpus} | ${failure.trajId} | \`${failure.image}\` | ${failure.error.replaceAll('|', '\\|')} |`,
      )
    }
  }
  lines.push('')
  lines.push('## Per-case results')
  lines.push('')
  lines.push(
    '| corpus | trajectory | k | rc@k | prefix | div | div% | armA exit | rc match | sig match | replayed | fix | armB exit | vanished | wall s |',
  )
  lines.push(
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  )
  for (const row of report.cases) {
    const fix = row.fix
    const fixCell = !fix
      ? '—'
      : fix.sampledOut
        ? 'sampled-out'
        : fix.llmError
          ? 'llm-failed'
          : fix.armBError
            ? 'armB-error'
            : fix.attempts
              ? fix.flippedAtAttempt !== null
                ? `flip@${fix.flippedAtAttempt}`
                : `exhausted(${fix.attempts.length})`
              : 'generated'
    lines.push(
      [
        row.corpus,
        row.trajId.length > 48 ? `${row.trajId.slice(0, 45)}…` : row.trajId,
        row.k,
        row.recordedReturncodeAtK ?? 'null',
        row.prefixExecuted ?? '—',
        row.prefixDivergences ?? '—',
        row.prefixDivergencePct ?? '—',
        row.status === 'ok' ? row.armAExit : row.status,
        row.armAReturncodeMatch ? 'yes' : 'no',
        row.armASignatureMatch ? 'yes' : 'no',
        row.replayed ? '**yes**' : 'no',
        fixCell,
        fix?.armBExit ?? '—',
        fix?.failureVanished === null || fix === null ? '—' : fix.failureVanished ? '**yes**' : 'no',
        (row.wallMs / 1000).toFixed(1),
      ].join(' | '),
    )
  }
  if (report.llm) {
    lines.push('')
    lines.push('## LLM fix generation')
    lines.push('')
    lines.push(
      `Model ${report.llm.model}: ${report.llm.calls} calls (${report.llm.failures} failed), ` +
        `${report.llm.promptTokens} prompt + ${report.llm.completionTokens} completion tokens.`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

// ── CLI ──────────────────────────────────────────────────────────────

export interface ReplayBatchCliArgs {
  readonly corpora: CorpusSpec[]
  readonly out: string
  readonly fix: 'none' | 'generate' | 'loop'
  readonly fixAttempts: number
  readonly fixModel: string
  readonly fixBaseUrl: string
  readonly fixApiKeyEnv: string
  readonly maxFixCases: number
  readonly seed: number
  readonly stepTimeoutMs?: number
  readonly prefixLimit?: number
  readonly caseFilter?: string
  readonly caseLimit?: number
  readonly baseUrl: string
  readonly apiKeyEnv: string
  readonly maxLifetimeSeconds?: number
  readonly enumerateOnly: boolean
}

export function parseReplayBatchArgs(argv: readonly string[]): ReplayBatchCliArgs | 'help' {
  const corpora: CorpusSpec[] = []
  const values = new Map<string, string>()
  let enumerateOnly = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--help' || arg === '-h') return 'help'
    if (arg === '--enumerate-only') {
      enumerateOnly = true
      continue
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected positional argument: ${arg}`)
    const value = argv[++i]
    if (value === undefined) throw new Error(`missing value for ${arg}`)
    if (arg === '--corpus') corpora.push(parseCorpusFlag(value))
    else values.set(arg, value)
  }
  if (corpora.length === 0) {
    throw new Error('replay-verify-batch: at least one --corpus name=<labels>::<prepared> is required')
  }
  const out = values.get('--out')
  if (!out && !enumerateOnly) throw new Error('replay-verify-batch: --out is required')
  const optionalNumber = (flag: string): number | undefined => {
    const v = values.get(flag)
    if (v === undefined) return undefined
    const n = Number(v)
    if (!Number.isFinite(n)) throw new Error(`replay-verify-batch: ${flag} must be a number, got ${v}`)
    return n
  }
  const fix = values.get('--fix') ?? 'none'
  if (fix !== 'none' && fix !== 'generate' && fix !== 'loop') {
    throw new Error(`replay-verify-batch: --fix must be none, generate, or loop, got ${fix}`)
  }
  const fixAttempts = optionalNumber('--fix-attempts') ?? 3
  if (!Number.isInteger(fixAttempts) || fixAttempts < 1) {
    throw new Error(
      `replay-verify-batch: --fix-attempts must be a positive integer, got ${values.get('--fix-attempts')}`,
    )
  }
  return {
    corpora,
    out: out ?? '.',
    fix,
    fixAttempts,
    fixModel: values.get('--fix-model') ?? 'glm-5.2',
    fixBaseUrl: values.get('--fix-base-url') ?? 'https://api.z.ai/api/coding/paas/v4',
    fixApiKeyEnv: values.get('--fix-api-key-env') ?? 'ZAI_GLM_API_KEY',
    maxFixCases: optionalNumber('--max-fix-cases') ?? 30,
    seed: optionalNumber('--seed') ?? 17,
    stepTimeoutMs: optionalNumber('--step-timeout'),
    prefixLimit: optionalNumber('--prefix-limit'),
    caseFilter: values.get('--case-filter'),
    caseLimit: optionalNumber('--case-limit'),
    baseUrl: values.get('--base-url') ?? process.env.SANDBOX_API_URL ?? 'http://127.0.0.1:4097',
    apiKeyEnv: values.get('--api-key-env') ?? 'SANDBOX_API_KEY',
    maxLifetimeSeconds: optionalNumber('--max-lifetime'),
    enumerateOnly,
  }
}

export function replayBatchUsage(): string {
  return `traces replay-verify-batch — measure replayability and fix-flip rates across gold-labeled corpora

Usage:
  traces replay-verify-batch \\
      --corpus NAME=<labels.json>::<prepared-dir> [--corpus ...] \\
      --out DIR [--fix none|generate|loop] [--fix-attempts 3] [--enumerate-only] \\
      [--fix-model glm-5.2] [--fix-base-url URL] [--fix-api-key-env ZAI_GLM_API_KEY] \\
      [--max-fix-cases 30] [--seed 17] [--step-timeout MS] [--prefix-limit N] \\
      [--case-filter SUBSTRING] [--case-limit N] \\
      [--base-url URL] [--api-key-env SANDBOX_API_KEY] [--max-lifetime SECONDS]

  Replayable = the raw trajectory carries info.docker_config.base_image AND the
  labels mark at least one gold incorrect step that is a real mid-trajectory
  action. k = the first such gold step; golds whose action is the agent's
  submit command (COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT) are skipped and
  counted, and cases whose golds are all submit steps are excluded as
  gold-only-submit-step. Excluded cases and image pull failures are report
  rows, never skipped silently. --enumerate-only prints the enumeration
  without touching a sandbox.

  --fix generate runs ONE LLM call per arm-A-reproduced case (cap
  --max-fix-cases, seeded sample beyond it) and executes the corrected command
  as arm B in a fresh sandbox.

  --fix loop iterates: attempt 1 is the one-shot prompt; when an arm fails
  (nonzero exit or the failure signature persists) or the model call fails,
  the next prompt carries every prior command with its REAL executed
  stdout/stderr, up to --fix-attempts attempts (default 3). Retries may
  answer with a short script (<=5 commands) executed as one /bin/sh unit.
  Every attempt runs in its own fresh sandbox with the same replayed prefix.

Outputs batch-report.json, batch-report.md, cases.jsonl (incremental), and one
directory per case with the full replay-verify artifacts.
See docs/replay-verify.md for orchestrator setup and honest limits.
`
}

export async function cmdReplayVerifyBatch(argv: readonly string[]): Promise<void> {
  const parsed = parseReplayBatchArgs(argv)
  if (parsed === 'help') {
    process.stdout.write(replayBatchUsage())
    return
  }
  if (parsed.enumerateOnly) {
    const enumeration = enumerateReplayableCases(parsed.corpora)
    process.stdout.write(
      `${JSON.stringify(
        {
          labelEntries: enumeration.labelEntryCount,
          replayable: enumeration.replayable.map((c) => ({
            corpus: c.corpus,
            trajId: c.trajId,
            image: c.image,
            cwd: c.cwd,
            cwdSource: c.cwdSource,
            k: c.k,
            submitGoldsSkipped: c.submitGoldsSkipped,
            recordedReturncodeAtK: c.recordedReturncodeAtK,
            goldIncorrectSteps: c.goldIncorrectSteps,
          })),
          excluded: enumeration.excluded,
        },
        null,
        2,
      )}\n`,
    )
    return
  }
  const apiKey = process.env[parsed.apiKeyEnv]
  if (!apiKey) {
    throw new Error(
      `replay-verify-batch: env var ${parsed.apiKeyEnv} is empty — pass --api-key-env or export it`,
    )
  }
  let fixCaller: ChatCompletionCaller | undefined
  if (parsed.fix !== 'none') {
    const fixApiKey = process.env[parsed.fixApiKeyEnv]
    if (!fixApiKey) {
      throw new Error(
        `replay-verify-batch: env var ${parsed.fixApiKeyEnv} is empty — pass --fix-api-key-env or export it`,
      )
    }
    fixCaller = zaiChatCaller({
      baseUrl: parsed.fixBaseUrl,
      apiKey: fixApiKey,
      model: parsed.fixModel,
    })
  }
  const report = await runReplayBatch({
    corpora: parsed.corpora,
    out: parsed.out,
    baseUrl: parsed.baseUrl,
    apiKey,
    fix: parsed.fix,
    fixAttempts: parsed.fixAttempts,
    fixCaller,
    fixModelLabel: parsed.fixModel,
    maxFixCases: parsed.maxFixCases,
    seed: parsed.seed,
    stepTimeoutMs: parsed.stepTimeoutMs,
    prefixLimit: parsed.prefixLimit,
    caseFilter: parsed.caseFilter,
    caseLimit: parsed.caseLimit,
    maxLifetimeSeconds: parsed.maxLifetimeSeconds,
    onProgress: (message) => process.stderr.write(`${message}\n`),
  })
  const { replayabilityRate, fixFlipRate } = report.headline
  process.stderr.write(
    `replay-verify-batch: replayability ${replayabilityRate.numerator}/${replayabilityRate.denominator}` +
      (fixFlipRate ? `, fix-flip ${fixFlipRate.numerator}/${fixFlipRate.denominator}` : '') +
      ` → ${parsed.out}\n`,
  )
}
