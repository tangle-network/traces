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

import type { RunCostProvenance } from '@tangle-network/agent-eval'
import type { ExecutionReport } from '@tangle-network/agent-eval/contract'
import {
  type AnalystFinding,
  type AnalystRegistry,
  type AnalystRunSummary,
  buildDefaultAnalystRegistry,
  type TraceAnalysisEngine,
  type TraceAnalystDefinition,
} from '@tangle-network/agent-eval/analyst'
import { OtlpFileTraceStore } from '@tangle-network/agent-eval/traces'
import { summarizeSpanExecution } from './execution.js'
import type { OtlpSpan } from './otlp.js'
import { writeOtlpFile } from './otlp.js'

export interface AnalyzeOptions {
  /**
   * Recursive analysis engine enabling the agentic analyst kinds. Omit →
   * deterministic only. The engine's id, version, and model become the
   * exact-run identity of every analyst it executes.
   */
  engine?: TraceAnalysisEngine
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
  /** Agentic registry override. Unlike `registry`, this runs after the local
   * deterministic pass and receives its compact findings as prior context. */
  agenticRegistry?: AnalystRegistry
  /** Select a subset of agent-eval's maintained trace analyst kinds. */
  agenticKinds?: readonly TraceAnalystDefinition[]
  /** Compact deterministic findings that agents receive before reading spans. */
  agenticPriorFindings?: readonly AnalystFinding[]
  /** Where to write the OTLP-JSONL artifact. Defaults to a temp file. */
  otlpOutPath?: string
  runId?: string
  signal?: AbortSignal
  log?: (msg: string, fields?: Record<string, unknown>) => void
}

export interface AnalyzeResult {
  /** Path to the OTLP-JSONL artifact (convert to canonical for HALO). */
  otlpPath: string
  execution: ExecutionReport
  result: Awaited<ReturnType<ReturnType<typeof buildDefaultAnalystRegistry>['run']>>
  /**
   * Per-analyst summaries from the agentic pass alone (also merged into
   * `result.per_analyst`). Present only when an agentic pass ran; callers use
   * it to tell "the engine produced nothing" apart from "deterministic-only
   * run", which the merged list cannot express.
   */
  agenticPerAnalyst?: readonly AnalystRunSummary[]
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

function mergeCostProvenance(
  first: RunCostProvenance | undefined,
  second: RunCostProvenance | undefined,
  totalCostUsd: number,
): RunCostProvenance {
  if (!first || !second || first.kind === 'uncaptured' || second.kind === 'uncaptured') {
    return { kind: 'uncaptured', usd: null }
  }
  return first.kind === 'estimated' || second.kind === 'estimated'
    ? { kind: 'estimated', usd: totalCostUsd }
    : { kind: 'observed', usd: totalCostUsd }
}

export async function analyzeSpans(spans: readonly OtlpSpan[], opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  if (spans.length === 0) throw new Error('analyzeSpans: no spans to analyze')
  opts.signal?.throwIfAborted()
  const otlpPath = await writeOtlpFile(spans, opts.otlpOutPath)
  opts.signal?.throwIfAborted()
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
  opts.signal?.throwIfAborted()
  const detRegistry = opts.registry ?? buildDefaultAnalystRegistry({ registry: { log: opts.log } })
  const result = await detRegistry.run(runId, { traceStore: detStore }, { signal: opts.signal })
  opts.signal?.throwIfAborted()

  // Agentic pass — default ceiling so each tool call stays context-bounded;
  // the RLM kinds drill via viewSpans/searchTrace from a summary.
  let agenticPerAnalyst: readonly AnalystRunSummary[] | undefined
  if (opts.engine || opts.agenticRegistry) {
    const agStore = new OtlpFileTraceStore({ path: otlpPath, maxFileBytes: GENERATED_TRACE_FILE_CEILING })
    await agStore.ensureIndexed()
    const agRegistry = opts.agenticRegistry ?? buildDefaultAnalystRegistry({
      engine: opts.engine!,
      ...(opts.agenticKinds ? { definitions: opts.agenticKinds } : {}),
      includeBehavioral: false,
      registry: { log: opts.log },
    })
    const agResult = await agRegistry.run(runId, { traceStore: agStore }, {
      budget: opts.budgetUsd != null ? { totalUsd: opts.budgetUsd } : undefined,
      chainFindings: true,
      signal: opts.signal,
      ...(opts.agenticPriorFindings?.length
        ? { priorFindings: { '*': opts.agenticPriorFindings } }
        : {}),
    })
    agenticPerAnalyst = [...agResult.per_analyst]
    result.findings.push(...agResult.findings)
    result.per_analyst.push(...agResult.per_analyst)
    const totalCostUsd = result.total_cost_usd + agResult.total_cost_usd
    result.total_cost_provenance = mergeCostProvenance(
      result.total_cost_provenance,
      agResult.total_cost_provenance,
      totalCostUsd,
    )
    result.total_cost_usd = totalCostUsd
  }

  opts.signal?.throwIfAborted()
  return { otlpPath, execution, result, ...(agenticPerAnalyst ? { agenticPerAnalyst } : {}) }
}
