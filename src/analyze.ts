/**
 * Run the agent-eval analyst suite over normalized spans.
 *
 * Spans → OTLP-JSONL file → `OtlpFileTraceStore` → `buildDefaultAnalystRegistry`.
 * With no Ax service the deterministic behavioral analyst runs alone (zero
 * LLM, model-agnostic). Supply `ai` to add the agentic RLM kinds
 * (failure-mode / knowledge-gap / knowledge-poisoning / improvement).
 *
 * The written OTLP file is the canonical artifact — the same file feeds HALO
 * (`halo <file> -p "diagnose"`), so analysis is never locked to one engine.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AxAIService } from '@ax-llm/ax'
import { type AnalystRegistry, buildDefaultAnalystRegistry } from '@tangle-network/agent-eval/analyst'
import { OtlpFileTraceStore } from '@tangle-network/agent-eval/traces'
import type { OtlpSpan } from './otlp.js'
import { serializeSpans } from './otlp.js'

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
  /** Path to the OTLP-JSONL artifact (feeds HALO too). */
  otlpPath: string
  result: Awaited<ReturnType<ReturnType<typeof buildDefaultAnalystRegistry>['run']>>
}

/** Write spans to an OTLP-JSONL file and return its path. */
export async function writeOtlp(spans: readonly OtlpSpan[], outPath?: string): Promise<string> {
  const path = outPath ?? join(await mkdtemp(join(tmpdir(), 'traces-')), 'spans.otlp.jsonl')
  await writeFile(path, serializeSpans(spans), 'utf8')
  return path
}

/**
 * `viewTrace` ceiling for the deterministic pass. The default 150KB cap
 * exists to protect an LLM's context window — the deterministic behavioral
 * analyst has none, and a single coding session is one trace whose full
 * span list routinely exceeds 150KB (→ oversized summary → zero spans →
 * zero findings). A high ceiling lets the analyst see every span.
 */
const DETERMINISTIC_VIEW_CEILING = 256 * 1024 * 1024

export async function analyzeSpans(spans: readonly OtlpSpan[], opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  if (spans.length === 0) throw new Error('analyzeSpans: no spans to analyze')
  const otlpPath = await writeOtlp(spans, opts.otlpOutPath)
  const runId = opts.runId ?? `traces-${Date.now()}`

  // Deterministic pass — high ceiling so the behavioral analyst sees the whole
  // trace. No LLM context to protect here. A caller-supplied registry (custom
  // analysts / their own agents) runs here instead of the built-in suite.
  const detStore = new OtlpFileTraceStore({ path: otlpPath, perCallByteCeiling: DETERMINISTIC_VIEW_CEILING })
  await detStore.ensureIndexed()
  const detRegistry = opts.registry ?? buildDefaultAnalystRegistry({ registry: { log: opts.log } })
  const result = await detRegistry.run(runId, { traceStore: detStore })

  // Agentic pass — default ceiling so each tool call stays context-bounded;
  // the RLM kinds drill via viewSpans/searchTrace from a summary.
  if (opts.ai) {
    const agStore = new OtlpFileTraceStore({ path: otlpPath })
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
