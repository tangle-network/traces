/**
 * The `replay-verify`, `replay-verify-batch` and `verify-findings` commands.
 *
 * Replay verification itself lives in `@tangle-network/agent-eval/trajectory-replay`:
 * prefix replay, both arms, corpus enumeration, the fix loop, finding proofs and
 * their receipts. That package depends on no sandbox client, so this module adds
 * only what the CLI owns: a Tangle Sandbox execution backend, an
 * OpenAI-compatible chat caller for arm-B fixes, the reachability preflight, and
 * flag parsing.
 */

import { readFileSync } from 'node:fs'
import {
  type ChatCompletionCaller,
  type ChatOutcome,
  type CorpusSpec,
  enumerateReplayableCases,
  type FindingReplaySource,
  parseCorpusFlag,
  type ReplayExecBackend,
  type ReplayExecBackendFactory,
  type ReplayExecSession,
  readFindingsFile,
  replayVerify,
  runReplayBatch,
  type VerifiableFinding,
  type VerifyFindingsRun,
  verifyFindings,
} from '@tangle-network/agent-eval/trajectory-replay'
import { Sandbox } from '@tangle-network/sandbox'

export const DEFAULT_SANDBOX_BASE_URL = 'http://127.0.0.1:4097'

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
        async exec(command, timeoutMs) {
          const r = await box.exec(command, { timeoutMs })
          return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
        },
        async close() {
          await box.delete()
        },
      }
    },
  }
}

function sandboxBackendFactory(options: {
  apiKey: string
  baseUrl: string
  maxLifetimeSeconds?: number
}): ReplayExecBackendFactory {
  return (image) => sandboxReplayBackend({ ...options, image })
}

/**
 * Fails loud when the sandbox SDK adapter is not answering. Executed findings
 * require real infrastructure; verification is never silently skipped.
 */
export async function assertSandboxReachable(baseUrl: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(new URL('/health', baseUrl), { signal: AbortSignal.timeout(5000) })
  } catch (err) {
    throw new Error(
      `verify-findings: sandbox API unreachable at ${baseUrl} — ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'Executing findings requires a running sandbox orchestrator + SDK adapter ' +
        '(see docs/replay-verify.md); start them or pass --base-url.',
    )
  }
  if (!response.ok) {
    throw new Error(
      `verify-findings: sandbox API at ${baseUrl} answered /health with HTTP ${response.status} — refusing to run proofs against degraded infrastructure`,
    )
  }
}

export interface ZaiChatCallerOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly maxTokens?: number
  readonly timeoutMs?: number
}

interface ChatCompletionResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[]
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown }
  readonly error?: { readonly message?: unknown }
}

/** OpenAI-compatible /chat/completions caller (z.ai coding endpoint shape). */
export function zaiChatCaller(options: ZaiChatCallerOptions): ChatCompletionCaller {
  async function callOnce(system: string, user: string, maxTokens: number): Promise<ChatOutcome> {
    try {
      const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
      })
      const bodyText = await response.text()
      if (!response.ok) return { succeeded: false, error: `HTTP ${response.status}: ${bodyText.slice(0, 400)}` }
      const body = JSON.parse(bodyText) as ChatCompletionResponse
      if (body.error) return { succeeded: false, error: String(body.error.message ?? 'provider error') }
      const content = body.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.length === 0) {
        return { succeeded: false, error: `empty completion content: ${bodyText.slice(0, 400)}` }
      }
      const promptTokens = body.usage?.prompt_tokens
      const completionTokens = body.usage?.completion_tokens
      const usage =
        typeof promptTokens === 'number' && typeof completionTokens === 'number'
          ? { promptTokens, completionTokens }
          : null
      return { succeeded: true, value: { content, usage } }
    } catch (err) {
      return { succeeded: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return {
    async complete(system, user) {
      // Reasoning models spend output budget on reasoning before content; a cap
      // that fits the answer alone returns finish_reason=length with EMPTY
      // content. One doubled retry covers long-reasoning cases without masking
      // real provider errors.
      const baseCap = options.maxTokens ?? 16_384
      const first = await callOnce(system, user, baseCap)
      if (first.succeeded || !/finish_reason":"length/.test(first.error)) return first
      return callOnce(system, user, baseCap * 2)
    },
  }
}

// ── Flag parsing shared by the three commands ────────────────────────

interface ParsedFlags {
  readonly values: Map<string, string>
  readonly corpora: CorpusSpec[]
  readonly switches: Set<string>
}

function parseFlags(command: string, argv: readonly string[], switches: readonly string[] = []): ParsedFlags | 'help' {
  const values = new Map<string, string>()
  const corpora: CorpusSpec[] = []
  const seen = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--help' || arg === '-h') return 'help'
    if (switches.includes(arg)) {
      seen.add(arg)
      continue
    }
    if (!arg.startsWith('--')) throw new Error(`${command}: unexpected positional argument: ${arg}`)
    const value = argv[++i]
    if (value === undefined) throw new Error(`${command}: missing value for ${arg}`)
    if (arg === '--corpus') corpora.push(parseCorpusFlag(value))
    else values.set(arg, value)
  }
  return { values, corpora, switches: seen }
}

function flagReader(command: string, values: Map<string, string>) {
  return {
    required(flag: string): string {
      const v = values.get(flag)
      if (v === undefined) throw new Error(`${command}: ${flag} is required`)
      return v
    },
    number(flag: string): number | undefined {
      const v = values.get(flag)
      if (v === undefined) return undefined
      const n = Number(v)
      if (!Number.isFinite(n)) throw new Error(`${command}: ${flag} must be a number, got ${v}`)
      return n
    },
  }
}

function sandboxOptions(command: string, values: Map<string, string>, requireKey: boolean) {
  const apiKeyEnv = values.get('--api-key-env') ?? 'SANDBOX_API_KEY'
  const apiKey = process.env[apiKeyEnv]
  if (requireKey && !apiKey) {
    throw new Error(`${command}: env var ${apiKeyEnv} is empty — pass --api-key-env or export it`)
  }
  const maxLifetime = flagReader(command, values).number('--max-lifetime')
  return {
    apiKey: apiKey ?? '',
    baseUrl: values.get('--base-url') ?? process.env.SANDBOX_API_URL ?? DEFAULT_SANDBOX_BASE_URL,
    ...(maxLifetime === undefined ? {} : { maxLifetimeSeconds: maxLifetime }),
  }
}

const progress = (message: string) => process.stderr.write(`${message}\n`)

// ── replay-verify ────────────────────────────────────────────────────

const REPLAY_VERIFY_USAGE = `traces replay-verify — replay a trajectory prefix in a sandbox and execute the counterfactual at step k

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
  --base-url         sandbox API url (default $SANDBOX_API_URL or ${DEFAULT_SANDBOX_BASE_URL})
  --api-key-env      env var holding the sandbox API key (default SANDBOX_API_KEY)

Requires a running sandbox orchestrator; only SWE-style trajectories that carry a
docker image are replayable. See docs/replay-verify.md for setup and limits.
`

export async function cmdReplayVerify(argv: readonly string[]): Promise<void> {
  const parsed = parseFlags('replay-verify', argv)
  if (parsed === 'help') {
    process.stdout.write(REPLAY_VERIFY_USAGE)
    return
  }
  const { values } = parsed
  const flags = flagReader('replay-verify', values)
  const at = Number(flags.required('--at'))
  if (!Number.isInteger(at) || at < 1) {
    throw new Error(`replay-verify: --at must be a positive step_id, got ${values.get('--at')}`)
  }
  const fixFile = values.get('--fix-command-file')
  if (values.has('--fix-command') && fixFile !== undefined) {
    throw new Error('replay-verify: pass --fix-command or --fix-command-file, not both')
  }
  const fixCommand = fixFile === undefined ? values.get('--fix-command') : readFileSync(fixFile, 'utf8').trimEnd()
  const image = flags.required('--image')
  const out = flags.required('--out')
  const verdict = await replayVerify({
    stepsPath: flags.required('--steps'),
    image,
    at,
    fixCommand,
    cwd: flags.required('--cwd'),
    out,
    caseId: values.get('--case'),
    signature: values.get('--signature'),
    stepTimeoutMs: flags.number('--step-timeout'),
    prefixLimit: flags.number('--prefix-limit'),
    driverLabel: values.get('--driver-label'),
    backend: sandboxReplayBackend({ ...sandboxOptions('replay-verify', values, true), image }),
    onProgress: progress,
  })
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`)
  const verdictLine = verdict.armB
    ? `armA.failureSignatureMatch=${verdict.armA.failureSignatureMatch} armB.failureVanished=${verdict.armB.failureVanished}`
    : `armA.failureSignatureMatch=${verdict.armA.failureSignatureMatch}`
  progress(
    `replay-verify: ${verdictLine} (${verdict.prefixDivergences.length}/${verdict.prefixExecuted} prefix divergences) → ${out}`,
  )
}

// ── replay-verify-batch ──────────────────────────────────────────────

const REPLAY_BATCH_USAGE = `traces replay-verify-batch — measure replayability and fix-flip rates across gold-labeled corpora

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
  action. Excluded cases and image pull failures are report rows, never
  skipped silently. --enumerate-only prints the enumeration without touching a
  sandbox.

  --fix generate runs ONE LLM call per arm-A-reproduced case (cap
  --max-fix-cases, seeded sample beyond it) and executes the corrected command
  as arm B in a fresh sandbox. --fix loop feeds each failed attempt's REAL
  executed output into the next prompt, up to --fix-attempts attempts.

Outputs batch-report.json, batch-report.md, cases.jsonl (incremental), and one
directory per case with the full replay-verify artifacts.
See docs/replay-verify.md for orchestrator setup and honest limits.
`

export async function cmdReplayVerifyBatch(argv: readonly string[]): Promise<void> {
  const parsed = parseFlags('replay-verify-batch', argv, ['--enumerate-only'])
  if (parsed === 'help') {
    process.stdout.write(REPLAY_BATCH_USAGE)
    return
  }
  const { values, corpora } = parsed
  const flags = flagReader('replay-verify-batch', values)
  if (corpora.length === 0) {
    throw new Error('replay-verify-batch: at least one --corpus name=<labels>::<prepared> is required')
  }
  if (parsed.switches.has('--enumerate-only')) {
    const enumeration = enumerateReplayableCases(corpora)
    const replayable = enumeration.replayable.map((c) => ({
      corpus: c.corpus,
      trajId: c.trajId,
      image: c.image,
      cwd: c.cwd,
      cwdSource: c.cwdSource,
      k: c.k,
      submitGoldsSkipped: c.submitGoldsSkipped,
      recordedReturncodeAtK: c.recordedReturncodeAtK,
      goldIncorrectSteps: c.goldIncorrectSteps,
    }))
    const report = { labelEntries: enumeration.labelEntryCount, replayable, excluded: enumeration.excluded }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  const out = flags.required('--out')
  const fix = values.get('--fix') ?? 'none'
  if (fix !== 'none' && fix !== 'generate' && fix !== 'loop') {
    throw new Error(`replay-verify-batch: --fix must be none, generate, or loop, got ${fix}`)
  }
  const fixAttempts = flags.number('--fix-attempts') ?? 3
  if (!Number.isInteger(fixAttempts) || fixAttempts < 1) {
    throw new Error(`replay-verify-batch: --fix-attempts must be a positive integer, got ${fixAttempts}`)
  }
  const fixModel = values.get('--fix-model') ?? 'glm-5.2'
  let fixCaller: ChatCompletionCaller | undefined
  if (fix !== 'none') {
    const fixApiKeyEnv = values.get('--fix-api-key-env') ?? 'ZAI_GLM_API_KEY'
    const fixApiKey = process.env[fixApiKeyEnv]
    if (!fixApiKey) {
      throw new Error(`replay-verify-batch: env var ${fixApiKeyEnv} is empty — pass --fix-api-key-env or export it`)
    }
    fixCaller = zaiChatCaller({
      baseUrl: values.get('--fix-base-url') ?? 'https://api.z.ai/api/coding/paas/v4',
      apiKey: fixApiKey,
      model: fixModel,
    })
  }
  const report = await runReplayBatch({
    corpora,
    out,
    fix,
    fixAttempts,
    fixCaller,
    fixModelLabel: fixModel,
    maxFixCases: flags.number('--max-fix-cases') ?? 30,
    seed: flags.number('--seed') ?? 17,
    stepTimeoutMs: flags.number('--step-timeout'),
    prefixLimit: flags.number('--prefix-limit'),
    caseFilter: values.get('--case-filter'),
    caseLimit: flags.number('--case-limit'),
    backendFactory: sandboxBackendFactory(sandboxOptions('replay-verify-batch', values, true)),
    onProgress: progress,
  })
  const { replayabilityRate, fixFlipRate } = report.headline
  progress(
    `replay-verify-batch: replayability ${replayabilityRate.numerator}/${replayabilityRate.denominator}` +
      (fixFlipRate ? `, fix-flip ${fixFlipRate.numerator}/${fixFlipRate.denominator}` : '') +
      ` → ${out}`,
  )
}

// ── verify-findings (and analyze --verify-findings) ──────────────────

const VERIFY_FINDINGS_USAGE = `traces verify-findings — execute analyst findings as sandbox replay proofs

Usage:
  traces verify-findings --findings FINDINGS.json --out DIR \\
      ( --steps STEPS.json --image IMG --cwd DIR [--case ID]
      | --corpus name=<labels.json>::<preparedDir> [--corpus ...] ) \\
      [--fix-command CMD] [--step-timeout MS] [--prefix-limit N] \\
      [--base-url URL] [--api-key-env VAR] [--max-lifetime SECONDS]

  --findings         JSON array of analyst findings (or an object with a findings
                     array) — the shape agent-eval analysts emit: subject
                     incorrect-step-<n>, metadata.block_first_step, trace:// evidence
  --out              receipt root; one directory per finding + verifications.json
  --steps/--image/--cwd
                     verify against one trajectory; the image must be replay-ready
                     (uid-1000 derived), exactly like traces replay-verify
  --case             trajectory id of --steps; findings citing other trajectories
                     are marked not-replayable
  --corpus           resolve each finding's trajectory in CodeTraceBench corpora;
                     images are derived via the batch uid-1000 preparer (docker)
  --fix-command      corrected step for arm B; a reproduced finding whose fix
                     flips becomes fix-flipped
  --base-url         sandbox API url (default $SANDBOX_API_URL or ${DEFAULT_SANDBOX_BASE_URL})
  --api-key-env      env var holding the sandbox API key (default SANDBOX_API_KEY)

Every finding gets a verdict: reproduced | fix-flipped | divergent | not-replayable,
with a receipt directory carrying the executed evidence or the precise reason.
Requires a running sandbox orchestrator when any finding is replayable — infra
absence is an error, never a silent skip. See docs/replay-verify.md for setup.
`

/** Runs finding proofs against the Tangle Sandbox, refusing absent infrastructure. */
export function verifyFindingsInSandbox(
  findings: readonly VerifiableFinding[],
  options: {
    source: FindingReplaySource
    out: string
    sandbox: { apiKey: string; baseUrl: string; maxLifetimeSeconds?: number }
    fixCommand?: string
    stepTimeoutMs?: number
    prefixLimit?: number
  },
): Promise<VerifyFindingsRun> {
  if (findings.length === 0) throw new Error('verify-findings: no findings to verify')
  const { sandbox, ...rest } = options
  return verifyFindings(findings, {
    ...rest,
    backendFactory: sandboxBackendFactory(sandbox),
    preflight: async () => {
      if (!sandbox.apiKey) {
        throw new Error(
          'verify-findings: replayable findings need a sandbox API key — export SANDBOX_API_KEY or pass --api-key-env',
        )
      }
      await assertSandboxReachable(sandbox.baseUrl)
    },
    onProgress: progress,
  })
}

export async function cmdVerifyFindings(argv: readonly string[]): Promise<void> {
  const parsed = parseFlags('verify-findings', argv)
  if (parsed === 'help') {
    process.stdout.write(VERIFY_FINDINGS_USAGE)
    return
  }
  const { values, corpora } = parsed
  const flags = flagReader('verify-findings', values)
  const findingsPath = flags.required('--findings')
  const out = flags.required('--out')
  const direct = values.has('--steps') || values.has('--image') || values.has('--cwd')
  if (direct && corpora.length > 0) {
    throw new Error('verify-findings: pass --steps/--image/--cwd or --corpus, not both')
  }
  let source: FindingReplaySource
  if (direct) {
    const caseId = values.get('--case')
    source = {
      kind: 'direct',
      stepsPath: flags.required('--steps'),
      image: flags.required('--image'),
      cwd: flags.required('--cwd'),
      ...(caseId === undefined ? {} : { caseId }),
    }
  } else if (corpora.length > 0) {
    source = { kind: 'corpus', corpora }
  } else {
    throw new Error('verify-findings: a replay source is required — --steps/--image/--cwd or --corpus')
  }
  const run = await verifyFindingsInSandbox(readFindingsFile(findingsPath), {
    source,
    out,
    sandbox: sandboxOptions('verify-findings', values, false),
    fixCommand: values.get('--fix-command'),
    stepTimeoutMs: flags.number('--step-timeout'),
    prefixLimit: flags.number('--prefix-limit'),
  })
  process.stdout.write(`${JSON.stringify(run, null, 2)}\n`)
  progress(
    `verify-findings: ${run.verifications.length} finding(s) → ` +
      `${run.counts.reproduced} reproduced, ${run.counts['fix-flipped']} fix-flipped, ` +
      `${run.counts.divergent} divergent, ${run.counts['not-replayable']} not-replayable ` +
      `(${run.executions} execution(s)) → ${run.out}`,
  )
}
