import {
  type ExecutionReport,
  summarizeExecution,
} from '@tangle-network/agent-eval/contract'
import {
  otlpRowsToRunRecords,
  otlpToRunRecords,
  type OtlpToRunRecordsOptions,
} from '@tangle-network/agent-eval/traces'
import type { OtlpSpan } from './otlp.js'
import { toOpenInferenceSpan } from './otlp.js'

export interface TraceExecutionOptions {
  readonly experimentId?: string
  readonly candidateId?: string
}

function runOptions(opts: TraceExecutionOptions): OtlpToRunRecordsOptions {
  return {
    experimentId: opts.experimentId ?? 'traces-observed',
    candidateId: opts.candidateId ?? 'observed',
    fallbackModel: 'unknown@otlp',
  }
}

function* openInferenceRows(
  spans: readonly OtlpSpan[],
): Iterable<Record<string, unknown>> {
  for (const item of spans) yield toOpenInferenceSpan(item)
}

/** Map normalized spans into agent-eval's shared execution accounting. */
export function summarizeOtlpExecution(
  otlpJsonl: string,
  opts: TraceExecutionOptions = {},
): ExecutionReport {
  const runs = otlpToRunRecords(otlpJsonl, runOptions(opts))
  return summarizeExecution({ runs })
}

export function summarizeSpanExecution(
  spans: readonly OtlpSpan[],
  opts: TraceExecutionOptions = {},
): ExecutionReport {
  if (spans.length === 0) throw new Error('summarizeSpanExecution: no spans to summarize')
  return summarizeExecution({
    runs: otlpRowsToRunRecords(openInferenceRows(spans), runOptions(opts)),
  })
}
