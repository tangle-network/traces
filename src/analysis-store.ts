/**
 * The store every analysis path reads: `analyze`, `ask` and `mcp`.
 *
 * The selected spans become agent-eval's indexed, bounded store in memory
 * (`otlpTextToTraceAnalysisStore`), so an analysis writes no file. The store
 * reads this package's OpenInference export exactly as agent-eval's
 * `OtlpFileTraceStore` reads it from a file: the same bytes, projected line by
 * line with `projectOtlpFlatLine`. The export is built as bytes, one span line
 * at a time, never as one string: a week of sessions passes V8's maximum
 * string length (~512 MiB), and the store holds a Buffer either way.
 */

import { otlpTextToTraceAnalysisStore, type TraceAnalysisStore } from '@tangle-network/agent-eval/traces'
import { iterSerializedSpans, type OtlpSpan } from './otlp.js'

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
  return otlpTextToTraceAnalysisStore(exportBytes(spans))
}

/** Store for deterministic analysts, which have no context window to protect. */
export function openDeterministicTraceStore(spans: readonly OtlpSpan[]): TraceAnalysisStore {
  return otlpTextToTraceAnalysisStore(exportBytes(spans), { perCallByteCeiling: DETERMINISTIC_PER_CALL_CEILING })
}

function exportBytes(spans: readonly OtlpSpan[]): Buffer {
  const lines: Buffer[] = []
  for (const line of iterSerializedSpans(spans)) lines.push(Buffer.from(line, 'utf8'))
  return Buffer.concat(lines)
}
