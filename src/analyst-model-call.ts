import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
} from '@tangle-network/agent-interface'
import { profileOptimizerModelCall } from '@tangle-network/agent-runtime/kernel'
import { createDspyRlmTraceEngine, type TraceAnalysisEngine } from '@tangle-network/agent-eval/analyst'

/** Model the CLI's recursive analysts use when neither `--model` nor TRACES_ANALYST_MODEL names one. */
export const DEFAULT_ANALYST_MODEL = 'gpt-5.6-luna'

/**
 * Provider ceiling for one `ask` question when neither `--question-budget` nor
 * a smaller `--budget` names one. It equals the DSPy engine's own default
 * investigation ceiling, stated here so `ask` owns the value it applies.
 */
export const DEFAULT_QUESTION_MAX_COST_USD = 1

/** Default analysis endpoint: the Tangle router, reached with TANGLE_API_KEY. */
export const TANGLE_ROUTER_BASE_URL = 'https://router.tangle.tools/v1'

export const ANALYST_MAX_OUTPUT_TOKENS = 16_384
export const GPT_5_6_ANALYST_MAX_OUTPUT_TOKENS = 8_192

/**
 * Keep the wider window for model families that need it.
 * GPT-5.6 emits complete findings within 8,192 tokens; reserving twice that
 * amount on every recursive step makes the cost ledger reject later calls.
 */
export function analystMaxOutputTokens(model: string): number {
  return /(?:^|\/)gpt-5\.6-(?:luna|terra|sol)(?:$|[-:])/iu.test(model)
    ? GPT_5_6_ANALYST_MAX_OUTPUT_TOKENS
    : ANALYST_MAX_OUTPUT_TOKENS
}

/** Bind trace analysis to one exact profile and Runtime-owned execution path. */
export function createAnalystModelOwner(opts: {
  apiKey: string
  baseUrl: string
  model: string
  provider: string
}) {
  const maxOutputTokens = analystMaxOutputTokens(opts.model)
  const profile = {
    name: 'traces-analyst',
    harness: 'cli-base',
    model: {
      provider: opts.provider,
      default: opts.model,
      reasoningEffort: 'none',
      maxVisibleOutputTokens: maxOutputTokens,
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
  /** Receives one line per model call, in the CLI's analyst log format. */
  log?: (msg: string, fields?: Record<string, unknown>) => void
  /** Environment to read credentials and the Python interpreter from. Default: process.env. */
  env?: NodeJS.ProcessEnv
}

/**
 * The recursive analysis engine behind `--llm` and `ask`. agent-eval's
 * model-backed analysts run through DSPy RLM, which drives
 * `agent-eval-rpc[dspy]` out of process, so this needs a Python interpreter
 * with that extra installed, selectable via TRACES_PYTHON. Every deterministic
 * command is unaffected and still needs neither a key nor Python.
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
  const python = env.TRACES_PYTHON
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
  return createDspyRlmTraceEngine({
    call: owner.call,
    callRef: owner.callRef,
    recordExecution: (observation) => {
      log?.(
        `[analyst] model call ${observation.sequence} ${observation.succeeded ? 'ok' : 'FAIL'} ${observation.model}`,
        observation.succeeded ? undefined : { error: observation.error },
      )
    },
    model: opts.model,
    // Model-aware, not defaulted: GPT-5.6 needs less output room than models
    // such as GLM, and every recursive call reserves this full amount before
    // execution. An oversized reservation can reject useful later calls even
    // when the run's measured spend remains well below its limit.
    maxOutputTokens: analystMaxOutputTokens(opts.model),
    // maxCostUsd defaults to $1 per investigation, a proxy-side ceiling
    // separate from any shared ledger. With the larger token cap the per-call
    // reservation grows ~4x, so that default can bind before the caller's own
    // allocation and kill investigations mid-run.
    ...(opts.maxCostUsd !== undefined && Number.isFinite(opts.maxCostUsd) && opts.maxCostUsd > 0
      ? { maxCostUsd: opts.maxCostUsd }
      : {}),
    ...(python ? { runner: { command: python } } : {}),
  })
}
