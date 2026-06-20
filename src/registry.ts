/**
 * Harness adapter registry — resolves a harness id (or alias) to the
 * adapter that knows its on-disk session format.
 *
 * Format families collapse many harnesses onto few adapters:
 *   - claude family (claude / claudish / openclaw / nanoclaw) share the
 *     `~/.claude`-style transcript JSONL
 *   - codex family (codex / codex-acp) share the rollout JSONL
 *   - gemini (gemini-cli) and its fork qwen (qwen-code) share the chat JSON
 *     under distinct home dirs
 *   - factory-droids (droid) has its own `~/.factory` rollout JSONL
 */

import { AmpAdapter } from './adapters/amp.js'
import { ClaudeAdapter } from './adapters/claude.js'
import { CodexAdapter } from './adapters/codex.js'
import { CopilotAdapter } from './adapters/copilot.js'
import { FactoryAdapter } from './adapters/factory.js'
import { ForgeAdapter } from './adapters/forge.js'
import { GeminiAdapter } from './adapters/gemini.js'
import { OpencodeAdapter } from './adapters/opencode.js'
import { PiAdapter } from './adapters/pi.js'
import { QwenAdapter } from './adapters/qwen.js'
import type { HarnessTraceAdapter } from './types.js'

const ADAPTERS: HarnessTraceAdapter[] = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new OpencodeAdapter(),
  new GeminiAdapter(),
  new QwenAdapter(),
  new FactoryAdapter(),
  new PiAdapter(),
  new AmpAdapter(),
  new CopilotAdapter(),
  new ForgeAdapter(),
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
