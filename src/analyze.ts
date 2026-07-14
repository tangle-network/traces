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
import type { ExecutionReport } from '@tangle-network/agent-eval/contract'
import { type AnalystRegistry, buildDefaultAnalystRegistry } from '@tangle-network/agent-eval/analyst'
import { OtlpFileTraceStore } from '@tangle-network/agent-eval/traces'
import { summarizeSpanExecution } from './execution.js'
import type { OtlpSpan } from './otlp.js'
import { writeOtlpFile } from './otlp.js'

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
  execution: ExecutionReport
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

export async function analyzeSpans(spans: readonly OtlpSpan[], opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  if (spans.length === 0) throw new Error('analyzeSpans: no spans to analyze')
  const otlpPath = await writeOtlpFile(spans, opts.otlpOutPath)
  const runId = opts.runId ?? `traces-${Date.now()}`
  const execution = summarizeSpanExecution(spans, {
    experimentId: runId,
  })

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

  return { otlpPath, execution, result }
}
