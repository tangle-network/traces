/**
 * Harness adapter registry — resolves a harness id (or alias) to the
 * adapter that knows its on-disk session format.
 *
 * The harness stores are read through `@tangle-network/harness-sessions`
 * (`SHARED_SESSION_ADAPTERS`). `codex-exec` is the one reader traces keeps for
 * itself: a Sandbox live stream is not a Codex rollout, and harness-sessions
 * has no reader for it.
 */

import { CodexExecAdapter } from './adapters/codex-exec.js'
import { SHARED_SESSION_ADAPTERS } from './adapters/harness-sessions.js'
import type { HarnessTraceAdapter } from './types.js'

const ADAPTERS: HarnessTraceAdapter[] = [
  ...SHARED_SESSION_ADAPTERS,
  new CodexExecAdapter(),
]

const BY_NAME = new Map<string, HarnessTraceAdapter>()
for (const a of ADAPTERS) {
  BY_NAME.set(a.harness, a)
  for (const alias of a.aliases ?? []) BY_NAME.set(alias, a)
}

export function listAdapters(): readonly HarnessTraceAdapter[] {
  return ADAPTERS
}

export function resolveAdapter(harness: string): HarnessTraceAdapter | undefined {
  return BY_NAME.get(harness) ?? BY_NAME.get(harness.toLowerCase())
}

export function knownHarnesses(): string[] {
  return [...BY_NAME.keys()].sort()
}

/** Options for selecting which adapters a command/SDK call operates on. */
export interface AdapterSelection {
  /** Use these adapters verbatim (e.g. a caller's own harness) — wins over all. */
  adapters?: readonly HarnessTraceAdapter[]
  /** Every known harness. Implied when no `adapters`/`harnesses` are given. */
  all?: boolean
  /** Specific harness ids/aliases. Unknown ids throw (fail-loud). */
  harnesses?: readonly string[]
}

/** Resolve a selection to the adapters to operate on. Precedence:
 *  explicit `adapters` → named `harnesses` → everything (`all` or unspecified).
 *  A named harness that doesn't resolve throws rather than silently dropping. */
export function selectAdapters(opts: AdapterSelection): HarnessTraceAdapter[] {
  if (opts.adapters && opts.adapters.length > 0) return [...opts.adapters]
  if (opts.all || !opts.harnesses || opts.harnesses.length === 0) return [...ADAPTERS]
  return opts.harnesses.map((h) => {
    const a = resolveAdapter(h)
    if (!a) throw new Error(`unknown harness "${h}". Known: ${knownHarnesses().join(', ')}`)
    return a
  })
}
