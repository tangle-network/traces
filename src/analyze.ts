/**
 * Run the agent-eval analyst suite over normalized spans.
 *
 * Spans → OTLP-JSONL file → `OtlpFileTraceStore` → `buildDefaultAnalystRegistry`.
 * With no Ax service the deterministic behavioral analyst runs alone (zero
 * LLM, model-agnostic). Supply `ai` to add the agentic RLM kinds
 * (failure-mode / knowledge-gap / knowledge-poisoning / improvement).
 *
 * The written file is canonical OpenInference (see otlp.ts), so it feeds our
 * analysts AND external engines directly — `--analyzer halo` runs HALO over the
 * same artifact, no conversion. Analysis is never locked to one engine.
 */

import type { AxAIService } from '@ax-llm/ax'
import { computeTraceMetrics } from '@tangle-network/agent-eval'
import { type AnalystRegistry, buildDefaultAnalystRegistry } from '@tangle-network/agent-eval/analyst'
import {
  LLM_INPUT_TOKEN_ATTR_KEYS,
  LLM_OUTPUT_TOKEN_ATTR_KEYS,
  OtlpFileTraceStore,
  projectOtlpFlatLine,
} from '@tangle-network/agent-eval/traces'
import type { OtlpSpan } from './otlp.js'
import { toOpenInferenceSpan, writeOtlpFile } from './otlp.js'

export interface AnalyzeOptions {
  /** Ax service enabling the agentic RLM kinds. Omit → deterministic only. */
  ai?: AxAIService
  model?: string
  /** USD cap across agentic analysts. */
  budgetUsd?: number
  /**
   * Bring your own analyst suite. When set, this registry runs over the trace
   * store INSTEAD of the built-in deterministic suite — the seam for running
   * your own agents/detectors over sessions. Register custom `Analyst`s with
   * `@tangle-network/agent-eval`'s `AnalystRegistry`.
   */
  registry?: AnalystRegistry
  /** Where to write the OTLP-JSONL artifact. Defaults to a temp file. */
  otlpOutPath?: string
  runId?: string
  log?: (msg: string, fields?: Record<string, unknown>) => void
}

export interface AnalyzeResult {
  /** Path to the OTLP-JSONL artifact (convert to canonical for HALO). */
  otlpPath: string
  result: Awaited<ReturnType<ReturnType<typeof buildDefaultAnalystRegistry>['run']>>
}

/**
 * `viewTrace` and generated-file ceiling for the deterministic pass. The
 * default 150KB cap exists to protect an LLM's context window — the
 * deterministic behavioral analyst has none, and a single coding session is one trace whose full
 * span list routinely exceeds 150KB (→ oversized summary → zero spans →
 * zero findings). The fixed ceiling covers large sessions without disabling
 * agent-eval's file-size guard.
 */
const GENERATED_TRACE_FILE_CEILING = 512 * 1024 * 1024
const BEHAVIORAL_ANALYST_ID = 'efficiency-behavioral'
const TOKEN_ATTR_KEYS = [
  ...LLM_INPUT_TOKEN_ATTR_KEYS,
  ...LLM_OUTPUT_TOKEN_ATTR_KEYS,
  'llm.usage.input_tokens',
  'llm.usage.output_tokens',
]

function isMonotonic(values: readonly number[], direction: 'up' | 'down'): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]!
    const current = values[index]!
    if (direction === 'up' ? current < previous : current > previous) return false
  }
  return true
}

/**
 * agent-eval 0.116 identifies both token trends from the first and last
 * samples. Keep its canonical extraction and findings, but reject a finding
 * when the complete trajectory contradicts the claim. A downward input step
 * is direct evidence of a context reset/compaction; output decay additionally
 * needs paired, continuously growing input rather than an endpoint coincidence.
 */
function supportedTrendFindings(spans: readonly OtlpSpan[]): ReadonlySet<string> {
  const projected = spans
    .filter((item) => TOKEN_ATTR_KEYS.some((key) => typeof item.attributes[key] === 'number'))
    .map((item) => {
      const value = projectOtlpFlatLine(toOpenInferenceSpan(item))
      if (!value) throw new Error(`Failed to project generated span ${item.span_id}`)
      return value
    })
  const metrics = computeTraceMetrics(projected)
  const inputIsMonotonic = isMonotonic(metrics.inputTokenTrajectory, 'up')
  const outputIsMonotonic = isMonotonic(metrics.outputTokenTrajectory, 'down')
  const outputHasPairedInput =
    projected.length >= 3 &&
    metrics.inputTokenTrajectory.length === projected.length &&
    metrics.outputTokenTrajectory.length === projected.length

  const supported = new Set<string>()
  if (inputIsMonotonic) supported.add('monotonic-input-growth')
  if (outputHasPairedInput && inputIsMonotonic && outputIsMonotonic) {
    supported.add('output-length-decay')
  }
  return supported
}

function removeUnsupportedTrendFindings(
  result: AnalyzeResult['result'],
  supported: ReadonlySet<string>,
): void {
  const before = result.findings.length
  result.findings = result.findings.filter((finding) => {
    if (finding.analyst_id !== BEHAVIORAL_ANALYST_ID) return true
    if (finding.subject === 'monotonic-input-growth' || finding.subject === 'output-length-decay') {
      return supported.has(finding.subject)
    }
    return true
  })

  const removed = before - result.findings.length
  if (removed === 0) return
  const summary = result.per_analyst.find((item) => item.analyst_id === BEHAVIORAL_ANALYST_ID)
  if (summary) summary.findings_count = Math.max(0, summary.findings_count - removed)
}

export async function analyzeSpans(spans: readonly OtlpSpan[], opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  if (spans.length === 0) throw new Error('analyzeSpans: no spans to analyze')
  const trendSupport = opts.registry ? null : supportedTrendFindings(spans)
  const otlpPath = await writeOtlpFile(spans, opts.otlpOutPath)
  const runId = opts.runId ?? `traces-${Date.now()}`

  // Deterministic pass — high ceiling so the behavioral analyst sees the whole
  // trace. No LLM context to protect here. A caller-supplied registry (custom
  // analysts / their own agents) runs here instead of the built-in suite.
  const detStore = new OtlpFileTraceStore({
    path: otlpPath,
    maxFileBytes: GENERATED_TRACE_FILE_CEILING,
    perCallByteCeiling: GENERATED_TRACE_FILE_CEILING,
  })
  await detStore.ensureIndexed()
  const detRegistry = opts.registry ?? buildDefaultAnalystRegistry({ registry: { log: opts.log } })
  const result = await detRegistry.run(runId, { traceStore: detStore })
  if (trendSupport) removeUnsupportedTrendFindings(result, trendSupport)

  // Agentic pass — default ceiling so each tool call stays context-bounded;
  // the RLM kinds drill via viewSpans/searchTrace from a summary.
  if (opts.ai) {
    const agStore = new OtlpFileTraceStore({ path: otlpPath, maxFileBytes: GENERATED_TRACE_FILE_CEILING })
    await agStore.ensureIndexed()
    const agRegistry = buildDefaultAnalystRegistry({
      ai: opts.ai,
      model: opts.model,
      includeBehavioral: false,
      registry: { log: opts.log },
    })
    const agResult = await agRegistry.run(runId, { traceStore: agStore }, {
      budget: opts.budgetUsd != null ? { totalUsd: opts.budgetUsd } : undefined,
    })
    result.findings.push(...agResult.findings)
    result.per_analyst.push(...agResult.per_analyst)
    result.total_cost_usd += agResult.total_cost_usd
  }

  return { otlpPath, result }
}
