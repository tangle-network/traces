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
  /** 'generate' runs one LLM call per arm-A-reproduced case, then arm B. */
  readonly fix: 'none' | 'generate'
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
  readonly usage: ChatUsage | null
  readonly armBExit: number | null
  readonly armBPrefixExecuted: number | null
  readonly armBPrefixDivergences: number | null
  readonly failureVanished: boolean | null
  readonly armBError: string | null
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
  }
  readonly headline: {
    readonly replayabilityRate: { numerator: number; denominator: number; value: number | null }
    readonly signatureStrictRate: { numerator: number; denominator: number; value: number | null }
    readonly fixFlipRate: { numerator: number; denominator: number; value: number | null } | null
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
  if (options.fix === 'generate') {
    const caller = options.fixCaller
    if (!caller) throw new Error('replay-verify-batch: fix=generate requires a fixCaller')
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
          },
        }
        continue
      }
      const replayCase = selected.find((c) => c.trajId === row.trajId && c.corpus === row.corpus)!
      const label = `fix ${row.corpus}/${row.trajId}`
      onProgress(`${label}: generating corrected command`)
      calls += 1
      const generated = await generateFixCommand(caller, {
        taskStatement: replayCase.taskStatement,
        steps: replayCase.steps,
        k: replayCase.k,
      })
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
          },
        }
        onProgress(`${label}: LLM failed — ${generated.error.slice(0, 200)}`)
        continue
      }
      promptTokens += generated.value.usage?.promptTokens ?? 0
      completionTokens += generated.value.usage?.completionTokens ?? 0
      const signature = verdictByTraj.get(row.trajId)?.signature ?? null
      const stepTimeoutMs = options.stepTimeoutMs ?? replayCase.recordedStepTimeoutMs ?? 120_000
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
          },
        }
        const caseOut = join(options.out, caseOutDirName(row))
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
  const excludedByReason: Record<string, number> = {}
  for (const excluded of enumeration.excluded) {
    excludedByReason[excluded.reason] = (excludedByReason[excluded.reason] ?? 0) + 1
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
        options.fix === 'generate'
          ? {
              numerator: flipped.length,
              denominator: armBExecuted.length,
              value: rate(flipped.length, armBExecuted.length),
            }
          : null,
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
  readonly fix: 'none' | 'generate'
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
  if (fix !== 'none' && fix !== 'generate') {
    throw new Error(`replay-verify-batch: --fix must be none or generate, got ${fix}`)
  }
  return {
    corpora,
    out: out ?? '.',
    fix,
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
      --out DIR [--fix none|generate] [--enumerate-only] \\
      [--fix-model glm-5.2] [--fix-base-url URL] [--fix-api-key-env ZAI_GLM_API_KEY] \\
      [--max-fix-cases 30] [--seed 17] [--step-timeout MS] [--prefix-limit N] \\
      [--case-filter SUBSTRING] [--case-limit N] \\
      [--base-url URL] [--api-key-env SANDBOX_API_KEY] [--max-lifetime SECONDS]

  Replayable = the raw trajectory carries info.docker_config.base_image AND the
  labels mark at least one gold incorrect step. k = the first gold incorrect
  step. Excluded cases and image pull failures are report rows, never skipped
  silently. --enumerate-only prints the enumeration without touching a sandbox.

  --fix generate runs ONE LLM call per arm-A-reproduced case (cap
  --max-fix-cases, seeded sample beyond it) and executes the corrected command
  as arm B in a fresh sandbox.

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
  if (parsed.fix === 'generate') {
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
