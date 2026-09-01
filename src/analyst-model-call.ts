import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
} from '@tangle-network/agent-interface'
import { profileOptimizerModelCall } from '@tangle-network/agent-runtime/kernel'

export const ANALYST_MAX_OUTPUT_TOKENS = 16_384

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
