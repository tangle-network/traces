/**
 * The store every analysis path reads: `analyze`, `ask` and `mcp`.
 *
 * The selected spans become agent-eval's indexed, bounded store in memory
 * (`spanRecordsToTraceAnalysisStore`), so an analysis writes no file. Each
 * span is projected exactly as agent-eval's OTLP file store projects a line
 * of this package's OpenInference export, so the analysts read the records a
 * file round trip used to give them.
 */

import {
  projectOtlpFlatLine,
  spanRecordsToTraceAnalysisStore,
  type TraceAnalysisStore,
  type TraceAnalystSpan,
} from '@tangle-network/agent-eval/traces'
import { iterSerializedSpans, type OtlpSpan } from './otlp.js'
import { parseIsoToEpochMs } from './time.js'

/**
 * Per-call ceiling for deterministic analysts. agent-eval's default exists to
 * bound a model's context window, and a single coding session is one trace
 * whose full span list routinely exceeds it.
 */
const DETERMINISTIC_PER_CALL_CEILING = 512 * 1024 * 1024

/** An ISO-8601 time with seconds and an explicit offset: what the store's record schema accepts. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/** A span time the store accepts. A span may carry epoch milliseconds or an offset-less date; those become UTC ISO. */
function storeTime(value: string): string {
  return ISO_WITH_OFFSET.test(value) ? value : new Date(parseIsoToEpochMs(value)).toISOString()
}

/** The analyst records for `spans`, built once and shared by every store over them. */
export function analysisRecords(spans: readonly OtlpSpan[]): readonly TraceAnalystSpan[] {
  const records: TraceAnalystSpan[] = []
  for (const line of iterSerializedSpans(spans)) {
    const record = projectOtlpFlatLine(JSON.parse(line) as Record<string, unknown>)
    if (!record) throw new Error(`span ${records.length} has no trace and span id to analyze`)
    records.push({ ...record, start_time: storeTime(record.start_time), end_time: storeTime(record.end_time) })
  }
  return records
}

/**
 * Store for model-driven analysis. It keeps agent-eval's default per-call byte
 * ceiling, so each tool result stays bounded for a model's context; the
 * engine drills in with `viewSpans` and `searchTrace` from a summary.
 */
export function openAgenticTraceStore(records: readonly TraceAnalystSpan[]): TraceAnalysisStore {
  return spanRecordsToTraceAnalysisStore(records)
}

/** Store for deterministic analysts, which have no context window to protect. */
export function openDeterministicTraceStore(records: readonly TraceAnalystSpan[]): TraceAnalysisStore {
  return spanRecordsToTraceAnalysisStore(records, { perCallByteCeiling: DETERMINISTIC_PER_CALL_CEILING })
}
