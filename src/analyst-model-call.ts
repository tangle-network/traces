import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
} from '@tangle-network/agent-interface'
import { profileOptimizerModelCall } from '@tangle-network/agent-runtime/kernel'

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
