/**
 * Run an analyst registry over normalized spans: the SDK's extension point.
 *
 * Spans → agent-eval's in-memory analysis store (`analysis-store.ts`) → the
 * registry. Nothing is written to disk, and nothing calls a model unless your
 * registry does. With no registry, agent-eval's deterministic behavioral
 * analyst runs alone (token growth, output decay, one-tool runs, no check
 * call). It reads tool names, token counts and timing, never content, so its
 * store is built from the spans' metadata only (`metadata-only.ts`), a
 * fraction of the export's size. A registry you bring reads the whole spans.
 *
 * `traces analyze` runs this, the shared rules (`pipelines.ts`) and the facts
 * sheet; `traces ask` is the one command that calls a model.
 */

import {
  type AnalystFinding,
  type AnalystRegistry,
  type AnalystRunResult,
  buildDefaultAnalystRegistry,
} from '@tangle-network/agent-eval/analyst'
import { exportBytes, openDeterministicTraceStore } from './analysis-store.js'
import { metadataOnly } from './metadata-only.js'
import type { OtlpSpan } from './otlp.js'
import { classifyLiveActions } from './pipelines.js'

export interface AnalyzeOptions {
  /**
   * Bring your own analyst suite. It runs over the trace store INSTEAD of the
   * built-in deterministic suite: register custom `Analyst`s with
   * `@tangle-network/agent-eval`'s `AnalystRegistry`.
   */
  registry?: AnalystRegistry
  runId?: string
  signal?: AbortSignal
  log?: (msg: string, fields?: Record<string, unknown>) => void
}

export interface AnalyzeResult {
  result: AnalystRunResult
}

/** Tool calls a run needs before "used one tool" or "never checked its work" says anything about it. */
export const MIN_TOOL_CALLS_FOR_TOOL_SIGNALS = 10

/** The behavioral signals that describe a run's tool use, and need {@link MIN_TOOL_CALLS_FOR_TOOL_SIGNALS} calls. */
const TOOL_SIGNALS = new Set(['single-tool-dependency', 'no-self-verification'])

/** Shell and code-mode tools: one name runs every command, so "only one tool" says nothing about what ran. */
const SHELL_TOOLS = new Set(['bash', 'exec_command', 'exec', 'shell', 'local_shell', 'run_shell_command', 'terminal'])

/** The signal's own evidence for one trace: `{tool, calls}` or `{tool_calls, verification_calls}`. */
function evidenceOf(finding: AnalystFinding, traceId: string): Record<string, unknown> | null {
  const ref = finding.evidence_refs.find((evidence) => evidence.uri.includes(`/trace/${encodeURIComponent(traceId)}/`))
  if (!ref?.excerpt) return null
  try {
    return JSON.parse(ref.excerpt) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * True when agent-eval's tool signal holds for this trace, read with what
 * traces knows and the analyst cannot. The analyst names a run's tools; it
 * fires from 3 calls, and a shell tool's name hides every command it ran.
 *   - Under {@link MIN_TOOL_CALLS_FOR_TOOL_SIGNALS} calls, neither signal says anything.
 *   - "One tool" of a shell tool is every command the run had: not a monoculture.
 *   - "No check call" is false when the run's own shell commands ran a test,
 *     build, typecheck or lint (`pipelines.ts`).
 */
function toolSignalHolds(finding: AnalystFinding, traceId: string, checked: ReadonlySet<string>): boolean {
  const evidence = evidenceOf(finding, traceId)
  const calls = evidence?.calls ?? evidence?.tool_calls
  if (typeof calls !== 'number' || calls < MIN_TOOL_CALLS_FOR_TOOL_SIGNALS) return false
  if (finding.subject === 'single-tool-dependency') return !(typeof evidence?.tool === 'string' && SHELL_TOOLS.has(evidence.tool.toLowerCase()))
  return !checked.has(traceId)
}

/** Keep agent-eval's tool signals only for the traces where {@link toolSignalHolds}; `checked` holds every trace that ran a check. */
function withHeldToolSignals(result: AnalystRunResult, checked: ReadonlySet<string>): AnalystRunResult {
  const findings = result.findings.flatMap((finding) => {
    if (!finding.subject || !TOOL_SIGNALS.has(finding.subject)) return [finding]
    const traces = Array.isArray(finding.metadata?.evidence_trace_ids) ? finding.metadata.evidence_trace_ids as string[] : []
    const kept = traces.filter((traceId) => toolSignalHolds(finding, traceId, checked))
    if (kept.length === 0) return []
    if (kept.length === traces.length) return [finding]
    return [{
      ...finding,
      claim: finding.claim.replace(/^\d+\//u, `${kept.length}/`),
      evidence_refs: finding.evidence_refs.filter((evidence) => kept.some((traceId) => evidence.uri.includes(`/trace/${encodeURIComponent(traceId)}/`))),
      metadata: { ...finding.metadata, evidence_trace_ids: kept, observed_trace_count: kept.length },
    }]
  })
  const dropped = result.findings.length - findings.length
  return dropped === 0 ? result : {
    ...result,
    findings,
    per_analyst: result.per_analyst.map((summary) => ({
      ...summary,
      findings_count: findings.filter((finding) => finding.analyst_id === summary.analyst_id).length,
    })),
  }
}

/**
 * agent-eval's behavioral analyst refuses more traces than its explicit limit
 * (1,000 by default) so an unfiltered store is never read by accident. A
 * traces selection is explicit, and the analyst reads one trace at a time, so
 * the limit is the selection's own trace count: a week of one host runs it too.
 */
const BEHAVIORAL_DEFAULT_MAX_TRACES = 1_000

export interface SpanAnalysis {
  /** One batch of whole traces, in selection order. */
  add(spans: readonly OtlpSpan[]): void
  run(): Promise<AnalyzeResult>
}

/**
 * {@link analyzeSpans} batch by batch: each batch is kept only as its export's
 * bytes (metadata only for the built-in analyst) and whether each of its
 * traces ran a check, so a week of sessions is never held as spans at once.
 */
export function createSpanAnalysis(opts: AnalyzeOptions = {}): SpanAnalysis {
  const chunks: Buffer[] = []
  const traces = new Set<string>()
  const checked = new Set<string>()
  return {
    add(spans) {
      if (spans.length === 0) return
      chunks.push(exportBytes(opts.registry ? spans : metadataOnly(spans).spans))
      if (opts.registry) return
      const byTrace = new Map<string, OtlpSpan[]>()
      for (const span of spans) {
        traces.add(span.trace_id)
        const group = byTrace.get(span.trace_id)
        if (group) group.push(span)
        else byTrace.set(span.trace_id, [span])
      }
      for (const [traceId, group] of byTrace) if (classifyLiveActions(group).some((action) => action.kind === 'verify')) checked.add(traceId)
    },
    async run() {
      if (chunks.length === 0) throw new Error('analyzeSpans: no spans to analyze')
      opts.signal?.throwIfAborted()
      const runId = opts.runId ?? `traces-${Date.now()}`
      const store = openDeterministicTraceStore(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks))
      chunks.length = 0
      if (opts.registry) {
        const result = await opts.registry.run(runId, { traceStore: store }, { signal: opts.signal })
        opts.signal?.throwIfAborted()
        return { result }
      }
      opts.signal?.throwIfAborted()
      const registry = buildDefaultAnalystRegistry({
        registry: { log: opts.log },
        behavioral: { maxTraces: Math.max(BEHAVIORAL_DEFAULT_MAX_TRACES, traces.size) },
      })
      const result = await registry.run(runId, { traceStore: store }, { signal: opts.signal })
      opts.signal?.throwIfAborted()
      return { result: withHeldToolSignals(result, checked) }
    },
  }
}

export async function analyzeSpans(spans: readonly OtlpSpan[], opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  if (spans.length === 0) throw new Error('analyzeSpans: no spans to analyze')
  opts.signal?.throwIfAborted()
  const analysis = createSpanAnalysis(opts)
  analysis.add(spans)
  return analysis.run()
}
