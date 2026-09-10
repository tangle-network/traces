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
  DEFAULT_TRACE_ANALYST_KINDS,
  type TraceAnalysisEngine,
  type TraceAnalystDefinition,
} from '@tangle-network/agent-eval/analyst'
import { openAgenticTraceStore, openDeterministicTraceStore, writeAnalysisTraceFile } from './analysis-store.js'
import { summarizeSpanExecution } from './execution.js'
import type { OtlpSpan } from './otlp.js'
import { withSessionFactsContext } from './session-facts.js'

export interface AnalyzeOptions {
  /** Explicitly authorize original source reads from this full session bundle. */
  sourceBundle?: { path: string; maxRecordBytes?: number }
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
  /**
   * Supply the deterministic session-facts sheet to the agentic kinds as
   * prepared context (default true). It costs nothing and removes the guessing
   * the bounded trace tools force on a model that needs an exact count. Set
   * false to measure an analyst without it.
   *
   * It applies only to definitions this call builds a registry from; a caller
   * who brings `agenticRegistry` owns its own prepared context.
   */
  sessionFactsContext?: boolean
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
  const traceFile = await writeAnalysisTraceFile(spans, {
    sourceBundle: opts.sourceBundle,
    otlpOutPath: opts.otlpOutPath,
    signal: opts.signal,
  })
  const { otlpPath } = traceFile
  opts.signal?.throwIfAborted()
  const runId = opts.runId ?? `traces-${Date.now()}`
  const execution = summarizeSpanExecution(spans, {
    experimentId: runId,
  })

  // Deterministic pass — high ceiling so the behavioral analyst sees the whole
  // trace. No LLM context to protect here. A caller-supplied registry (custom
  // analysts / their own agents) runs here instead of the built-in suite.
  const detStore = await openDeterministicTraceStore(traceFile)
  opts.signal?.throwIfAborted()
  const detRegistry = opts.registry ?? buildDefaultAnalystRegistry({ registry: { log: opts.log } })
  const result = await detRegistry.run(runId, { traceStore: detStore }, { signal: opts.signal })
  opts.signal?.throwIfAborted()

  // Agentic pass — default ceiling so each tool call stays context-bounded;
  // the RLM kinds drill via viewSpans/searchTrace from a summary.
  let agenticPerAnalyst: readonly AnalystRunSummary[] | undefined
  if (opts.engine || opts.agenticRegistry) {
    const agStore = await openAgenticTraceStore(traceFile)
    // The sheet reaches the model through each definition's `prepareContext`,
    // which runs before the first model call. Its facts are exact where the
    // bounded trace tools force a guess, and it costs nothing to compute. A
    // caller-supplied agentic registry owns its own prepared context, so the
    // sheet is built only when this call builds the registry.
    const buildRegistry = (): AnalystRegistry => {
      const kinds = opts.agenticKinds ?? DEFAULT_TRACE_ANALYST_KINDS
      return buildDefaultAnalystRegistry({
        engine: opts.engine!,
        definitions: opts.sessionFactsContext === false ? kinds : withSessionFactsContext(kinds, spans),
        includeBehavioral: false,
        registry: { log: opts.log },
      })
    }
    const agRegistry = opts.agenticRegistry ?? buildRegistry()
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
