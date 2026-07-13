/**
 * Run agent-eval's shipped trace pipelines over normalized harness spans.
 *
 * These are the deterministic repeated-call/thrash detectors that already exist in
 * `@tangle-network/agent-eval`:
 *   - stuckLoopView         — same tool + same args ≥ N times across a run
 *   - computeToolUseMetrics — duplicate-call / retry / error rates per run
 *
 * `toolWasteView` is intentionally NOT used: its default heuristic needs
 * verbatim tool *results* + per-turn LLM `messages`, which traces
 * doesn't capture from harness logs (we store tool args + error status). Its
 * signal — repeated/failed calls — is already covered by the duplicate/retry/
 * error rates above, so adding it would only emit a misleading waste %.
 *
 * Both are cheap ($0, deterministic), so they're safe to run continuously in
 * `watch` mode, over the OTLP spans traces already produces. Calls explicitly
 * marked as expected blocking stay in usage totals but are excluded from
 * repeated-call findings. agent-eval 0.116 groups over the complete run; do
 * not describe those groups as continuous loops until its bounded clustering
 * option is released and adopted here.
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
  /** Minimum identical calls in a full-session group (default 3). */
  minLoopOccurrences?: number
}

export async function runPipelines(spans: readonly OtlpSpan[], opts: PipelineOptions = {}): Promise<PipelineReport> {
  const { store, runIds } = await toRuntimeStore(spans)
  const loopEligible = spans.filter((item) => item.attributes['traces.expected_blocking'] !== true)
  const { store: loopStore } = await toRuntimeStore(loopEligible)
  const stuckLoops = await stuckLoopView(loopStore, { minOccurrences: opts.minLoopOccurrences ?? 3 })
  const toolUse = await Promise.all(runIds.map((runId) => computeToolUseMetrics(store, runId)))
  return { stuckLoops, toolUse }
}
