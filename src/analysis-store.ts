/**
 * The store every analysis path reads: `analyze`, `ask` and `mcp`.
 *
 * The selected spans become agent-eval's indexed, bounded store in memory
 * (`otlpTextToTraceAnalysisStore`), so an analysis writes no file. The store
 * reads this package's OpenInference export exactly as agent-eval's
 * `OtlpFileTraceStore` reads it from a file: the same bytes, projected line by
 * line with `projectOtlpFlatLine`. The text is dropped once the store holds
 * its bytes, so a store costs the export's size once, as the file did.
 */

import { otlpTextToTraceAnalysisStore, type TraceAnalysisStore } from '@tangle-network/agent-eval/traces'
import { type OtlpSpan, serializeSpans } from './otlp.js'

/**
 * Per-call ceiling for deterministic analysts. agent-eval's default exists to
 * bound a model's context window, and a single coding session is one trace
 * whose full span list routinely exceeds it.
 */
const DETERMINISTIC_PER_CALL_CEILING = 512 * 1024 * 1024

/**
 * Store for model-driven analysis. It keeps agent-eval's default per-call byte
 * ceiling, so each tool result stays bounded for a model's context; the
 * engine drills in with `viewSpans` and `searchTrace` from a summary.
 */
export function openAgenticTraceStore(spans: readonly OtlpSpan[]): TraceAnalysisStore {
  return otlpTextToTraceAnalysisStore(serializeSpans(spans))
}

/** Store for deterministic analysts, which have no context window to protect. */
export function openDeterministicTraceStore(spans: readonly OtlpSpan[]): TraceAnalysisStore {
  return otlpTextToTraceAnalysisStore(serializeSpans(spans), { perCallByteCeiling: DETERMINISTIC_PER_CALL_CEILING })
}
