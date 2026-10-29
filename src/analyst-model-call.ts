import { accessSync, constants, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
} from '@tangle-network/agent-interface'
import { profileOptimizerModelCall } from '@tangle-network/agent-runtime/kernel'
import { createDspyRlmTraceEngine, type TraceAnalysisEngine } from '@tangle-network/agent-eval/analyst'

import { DEFAULT_ANALYST_MODEL, DEFAULT_QUESTION_TIMEOUT_MS } from './ask-defaults.js'

export { DEFAULT_ANALYST_MODEL }

/** Default analysis endpoint: the Tangle router, reached with TANGLE_API_KEY. */
const TANGLE_ROUTER_BASE_URL = 'https://router.tangle.tools/v1'

/** The DSPy bridge module agent-eval's engine runs (`python -m <module>`). */
const BRIDGE_MODULE = 'agent_eval_rpc.dspy_rlm_bridge'

/**
 * The completion cap of every analyst call, for every model. The bridge's DSPy
 * refuses an OpenAI reasoning model (gpt-5 and o-series names) whose cap is
 * below 16,000 before any call, so a smaller cap for one family fails every
 * question that asks with it.
 */
export const ANALYST_MAX_OUTPUT_TOKENS = 16_384

/**
 * The PyPI version of `agent-eval-rpc`, the Python bridge, that speaks this
 * package's engine protocol: its installed `@tangle-network/agent-eval` version.
 * Other versions can refuse its exact-key input before a model call.
 */
export function bridgeVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@tangle-network/agent-eval')), 'utf8')) as {
    version?: unknown
  }
  const version = pkg.version
  if (typeof version !== 'string' || !version) {
    throw new Error('installed agent-eval package has no version')
  }
  return version
}

/**
 * The bridge process: TRACES_PYTHON when set (a Python with
 * `agent-eval-rpc[dspy]` installed), else uv runs the pinned bridge with
 * nothing installed beforehand.
 */
function bridgeRunner(env: NodeJS.ProcessEnv): { command: string; args?: string[] } {
  if (env.TRACES_PYTHON) return { command: env.TRACES_PYTHON }
  return { command: 'uvx', args: ['--from', `agent-eval-rpc[dspy]==${bridgeVersion()}`, 'python', '-m', BRIDGE_MODULE] }
}

/** True when `command` is an executable path, or an executable on PATH. */
function runnable(command: string, path: string | undefined): boolean {
  const candidates = command.includes('/') ? [command] : (path ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command))
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/**
 * What `ask` needs before it can spend anything, each missing one named with
 * how to supply it. Empty when the run can start.
 */
export function missingAskRequirements(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = []
  if (!env.TANGLE_API_KEY && !env.OPENAI_API_KEY) {
    missing.push(
      'a model key: set TANGLE_API_KEY for the Tangle router, or OPENAI_API_KEY ' +
        '(OPENAI_BASE_URL names any other OpenAI-compatible endpoint)',
    )
  }
  const bridge = env.TRACES_PYTHON ? runnable(env.TRACES_PYTHON, env.PATH) : runnable('uvx', env.PATH)
  if (!bridge) {
    missing.push(
      env.TRACES_PYTHON
        ? `the Python bridge: TRACES_PYTHON=${env.TRACES_PYTHON} is not an executable`
        : `the Python bridge: install uv (https://docs.astral.sh/uv/), or set TRACES_PYTHON to a Python with agent-eval-rpc[dspy]==${bridgeVersion()}`,
    )
  }
  return missing
}

/** A model-call failure no retry clears. */
export interface PermanentModelFailure {
  /** `auth`: the endpoint refused the key. `model`: it cannot serve or price the model. */
  readonly code: 'auth' | 'model'
  readonly message: string
}

/** The engine could not be built for this model: no price is known for it. */
export class UnservableModelError extends Error {
  readonly failure: PermanentModelFailure

  constructor(failure: PermanentModelFailure) {
    super(failure.message)
    this.name = 'UnservableModelError'
    this.failure = failure
  }
}

type ModelFailure =
  | { readonly kind: 'transient'; readonly reason: string }
  | { readonly kind: 'permanent'; readonly failure: PermanentModelFailure }
  | { readonly kind: 'other' }

/** Endpoint statuses a later attempt can clear: busy, rate limited, or briefly down. */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524])

/**
 * Router answers that name a model the key cannot use, whatever their status.
 * A key with no allow-list answers an unknown model with a 503 (no trusted
 * price), which a status alone would retry for minutes.
 */
const UNSERVABLE_MODEL = /model_not_allowed|model_not_found|provider_pricing_unavailable|not in this key's allow-list|unknown model/iu

/**
 * The endpoint's own words from a `router <status>: <body>` failure. Runtime
 * cuts the body at 200 characters, so the message may have no closing quote.
 */
function endpointWords(body: string): string {
  const message = /"message":"((?:[^"\\]|\\.)*)/u.exec(body)?.[1]
  return (message ?? body).replace(/\\"/gu, '"').slice(0, 240)
}

/**
 * Sort a failed model call by what another attempt would do. Runtime reports
 * an endpoint refusal as `router <status>: <body>` inside its error text, and
 * a served model that is not the one asked for by name.
 */
function classifyModelFailure(error: string, model: string): ModelFailure {
  const served = /reported model ("[^"]*") but AgentProfile requires ("[^"]*")/u.exec(error)
  if (served) {
    return {
      kind: 'permanent',
      failure: {
        code: 'model',
        message: `the endpoint served ${served[1]} for --model ${served[2]}, and ask refuses an answer from a model it did not ask for; ` +
          'pass the provider-qualified model id (for example zai/glm-5.3)',
      },
    }
  }
  const refused = /\brouter (\d{3}): (.*)$/su.exec(error)
  if (!refused) {
    return /router network failure|router request timeout|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/u.test(error)
      ? { kind: 'transient', reason: 'the endpoint could not be reached' }
      : { kind: 'other' }
  }
  const status = Number(refused[1])
  const words = endpointWords(refused[2]!)
  if (status === 401 || status === 402 || status === 403) {
    return {
      kind: 'permanent',
      failure: { code: 'auth', message: `the model endpoint refused the key (${status}: ${words}). Check TANGLE_API_KEY, or OPENAI_API_KEY and OPENAI_BASE_URL` },
    }
  }
  if (UNSERVABLE_MODEL.test(refused[2]!)) {
    return {
      kind: 'permanent',
      failure: { code: 'model', message: `the model endpoint cannot serve --model ${model} (${status}: ${words})` },
    }
  }
  return TRANSIENT_STATUSES.has(status) ? { kind: 'transient', reason: `${status}: ${words}` } : { kind: 'other' }
}

/** Attempts per model call, the first included. With the delays below, about five minutes of waiting. */
const MODEL_CALL_ATTEMPTS = 10
const FIRST_RETRY_DELAY_MS = 2_000
const MAX_RETRY_DELAY_MS = 60_000

function retryDelayMs(attempt: number): number {
  const delay = Math.min(MAX_RETRY_DELAY_MS, FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1))
  return Math.round(delay * (0.75 + Math.random() * 0.5))
}

/** Wait `ms`, or less when `signal` aborts. True when the whole wait ran. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const done = (slept: boolean) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      resolve(slept)
    }
    const aborted = () => done(false)
    const timer = setTimeout(() => done(true), ms)
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

type ModelCall = ReturnType<typeof profileOptimizerModelCall>

/**
 * One model call, retried while the endpoint is busy, rate limited or
 * briefly down: a router billing outage or a provider's rate limit that
 * outlasts a few seconds otherwise fails the whole question. A retried refusal
 * was never served, so it costs nothing, and the wait ends when the
 * question's deadline aborts the call. A permanent refusal (the key, or the
 * model) is reported at once, so the run stops before it spends more.
 */
function retryingModelCall(
  call: ModelCall,
  opts: {
    model: string
    log?: (msg: string, fields?: Record<string, unknown>) => void
    onPermanentFailure?: (failure: PermanentModelFailure) => void
  },
): ModelCall {
  return async (request) => {
    for (let attempt = 1; ; attempt += 1) {
      const result = await call(request)
      if (result.succeeded) return result
      const failure = classifyModelFailure(result.error, opts.model)
      if (failure.kind === 'permanent') {
        opts.onPermanentFailure?.(failure.failure)
        return result
      }
      if (failure.kind === 'other' || attempt >= MODEL_CALL_ATTEMPTS) return result
      const delay = retryDelayMs(attempt)
      opts.log?.(
        `[analyst] WARN model call failed (${failure.reason}); attempt ${attempt + 1} of ${MODEL_CALL_ATTEMPTS} in ${(delay / 1000).toFixed(1)} s`,
      )
      if (!(await pause(delay, request.signal))) return result
    }
  }
}

/** Bind trace analysis to one exact profile and Runtime-owned execution path. */
export function createAnalystModelOwner(opts: {
  apiKey: string
  baseUrl: string
  model: string
  provider: string
}) {
  const profile = {
    name: 'traces-analyst',
    harness: 'cli-base',
    model: {
      provider: opts.provider,
      default: opts.model,
      reasoningEffort: 'none',
      maxVisibleOutputTokens: ANALYST_MAX_OUTPUT_TOKENS,
      metadata: {
        // Stream every analyst call. The Tangle Router bounds a buffered request by a deadline that
        // ends when response headers are sent, and a thinking model's long recursive step outlives
        // it (`request_deadline_exceeded`). A streamed response sends headers at the first byte.
        stream: true,
        // One attempt per call: `retryingModelCall` decides what to retry from the endpoint's
        // status and code, because Runtime's retry reads the status alone.
        retry: { maxAttempts: 1 },
      },
    },
  } satisfies AgentProfile

  return {
    call: profileOptimizerModelCall({
      profile,
      context: 'traces analyst',
      executor: {
        backend: 'router',
        routerBaseUrl: opts.baseUrl,
        routerKey: opts.apiKey,
      },
    }),
    callRef: canonicalCandidateDigest({
      profile: canonicalAgentProfileDigest(profile),
      endpoint: opts.baseUrl,
    }),
    profile,
  }
}

export interface AnalysisEngineFromEnvOptions {
  model: string
  /**
   * Provider-side spend ceiling for ONE investigation (one analyst or one
   * question). Omitted, the engine keeps its own default. A caller that runs
   * several investigations under one shared ledger passes the per-investigation
   * cap here and the total to the ledger.
   */
  maxCostUsd?: number
  /** Wall-clock deadline for ONE investigation. Default: {@link DEFAULT_QUESTION_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Receives one line per model call, in the CLI's analyst log format. */
  log?: (msg: string, fields?: Record<string, unknown>) => void
  /** Called once per model call the endpoint refused for good: the key, or the model. */
  onPermanentFailure?: (failure: PermanentModelFailure) => void
  /** Environment to read credentials and the Python interpreter from. Default: process.env. */
  env?: NodeJS.ProcessEnv
}

/**
 * The recursive analysis engine behind `ask`. agent-eval's model-backed
 * analysts run through DSPy RLM, which drives `agent-eval-rpc[dspy]` out of
 * process: TRACES_PYTHON names a Python with it installed, and without it uv
 * runs the pinned bridge. Every deterministic command needs neither a key nor
 * Python.
 */
export function analysisEngineFromEnv(opts: AnalysisEngineFromEnvOptions): TraceAnalysisEngine {
  const env = opts.env ?? process.env
  // The router is the default endpoint, so TANGLE_API_KEY alone is enough.
  // OPENAI_API_KEY still works and, when it is the only key present, points at
  // OpenAI directly; otherwise a plain OpenAI key would be sent to the router.
  const tangleKey = env.TANGLE_API_KEY
  const openAiKey = env.OPENAI_API_KEY
  const apiKey = tangleKey || openAiKey
  if (!apiKey) {
    throw new Error(
      'model-backed analysis needs a model key: TANGLE_API_KEY for the Tangle router (the default endpoint), or ' +
        'OPENAI_API_KEY for OpenAI. Set OPENAI_BASE_URL to target any other OpenAI-compatible ' +
        'gateway. Deterministic analysis needs no key.',
    )
  }
  const baseUrl =
    env.OPENAI_BASE_URL ||
    (tangleKey ? TANGLE_ROUTER_BASE_URL : 'https://api.openai.com/v1')
  const owner = createAnalystModelOwner({
    apiKey,
    baseUrl,
    model: opts.model,
    provider:
      baseUrl === TANGLE_ROUTER_BASE_URL
        ? 'tangle-router'
        : baseUrl.startsWith('https://api.openai.com/')
          ? 'openai'
          : 'openai-compatible',
  })
  const log = opts.log
  try {
    return createDspyRlmTraceEngine({
      call: retryingModelCall(owner.call, {
        model: opts.model,
        ...(log ? { log } : {}),
        ...(opts.onPermanentFailure ? { onPermanentFailure: opts.onPermanentFailure } : {}),
      }),
      callRef: owner.callRef,
      recordExecution: (observation) => {
        log?.(
          `[analyst] model call ${observation.sequence} ${observation.succeeded ? 'ok' : 'FAIL'} ${observation.model}`,
          observation.succeeded ? undefined : { error: observation.error },
        )
      },
      model: opts.model,
      maxOutputTokens: ANALYST_MAX_OUTPUT_TOKENS,
      // The engine's own default ceiling is $1 per investigation, a proxy-side
      // ceiling separate from any shared ledger; the caller's allocation wins.
      ...(opts.maxCostUsd !== undefined && Number.isFinite(opts.maxCostUsd) && opts.maxCostUsd > 0
        ? { maxCostUsd: opts.maxCostUsd }
        : {}),
      timeoutMs: opts.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS,
      runner: bridgeRunner(env),
    })
  } catch (error) {
    // agent-eval refuses a model it has no price for: the run could not bound its spend.
    const message = error instanceof Error ? error.message : String(error)
    if (/no pricing is configured/u.test(message)) {
      throw new UnservableModelError({ code: 'model', message: `ask cannot price --model ${opts.model}, so it cannot bound the spend: ${message}` })
    }
    throw error
  }
}
