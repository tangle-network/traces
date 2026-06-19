/**
 * Run agent-eval's shipped trace pipelines over normalized harness spans.
 *
 * These are the deterministic loop/thrash detectors that already exist in
 * `@tangle-network/agent-eval`:
 *   - stuckLoopView         — same tool + same args ≥ N times (the loop signal)
 *   - computeToolUseMetrics — duplicate-call / retry / error rates per run
 *
 * `toolWasteView` is intentionally NOT used: its default heuristic needs
 * verbatim tool *results* + per-turn LLM `messages`, which tangle-traces
 * doesn't capture from harness logs (we store tool args + error status). Its
 * signal — repeated/failed calls — is already covered by the duplicate/retry/
 * error rates above, so adding it would only emit a misleading waste %.
 *
 * Both are cheap ($0, deterministic), so they're safe to run continuously in
 * `watch` mode, over the OTLP spans tangle-traces already produces.
 */

import { computeToolUseMetrics } from '@tangle-network/agent-eval'
import type { ToolUseMetrics } from '@tangle-network/agent-eval'
import { stuckLoopView } from '@tangle-network/agent-eval/pipelines'
import type { StuckLoopReport } from '@tangle-network/agent-eval/pipelines'
import type { OtlpSpan } from './otlp.js'
import { toRuntimeStore } from './runtime-store.js'

export interface PipelineReport {
  stuckLoops: StuckLoopReport
  toolUse: ToolUseMetrics[]
}

export interface PipelineOptions {
  /** Minimum repeated identical calls to flag a loop (default 3). */
  minLoopOccurrences?: number
}

export async function runPipelines(spans: readonly OtlpSpan[], opts: PipelineOptions = {}): Promise<PipelineReport> {
  const { store, runIds } = await toRuntimeStore(spans)
  const stuckLoops = await stuckLoopView(store, { minOccurrences: opts.minLoopOccurrences ?? 3 })
  const toolUse = await Promise.all(runIds.map((runId) => computeToolUseMetrics(store, runId)))
  return { stuckLoops, toolUse }
}
