/** Span-source collection shared by CLI handlers; session selection remains in cli.ts. */
import { stat } from 'node:fs/promises'
import type { TraceValidation } from '@tangle-network/agent-trace-contract'
import { indexSessionIdsByTrace } from './attributes.js'
import { type TraceEvidenceFormatOption, exportTraceEvidenceFile } from './file-export.js'
import type { OtlpSpan } from './otlp.js'
import { readOtlpInput, type OtlpFieldWithheld, type OtlpIngestIssue, type OtlpInputFile, type SkippedInputFile, type UnreadableSourceRows } from './otlp-input.js'
import type { ReportSource } from './report.js'
import { selectSpans } from './refs.js'
import type { UnreadSessionFact } from './session-facts.js'
import type { SessionWorkflowSummary } from './session-workflow.js'

export interface CollectedSpans {
  spans: OtlpSpan[]
  harness: string
  sources: ReportSource[]
  workflow?: SessionWorkflowSummary
  /**
   * Conformance of the SOURCE, present when the spans were read from OTLP.
   * Absent for adapter output, which is graded from the spans themselves.
   */
  conformance?: TraceValidation
  conformanceSubject?: string
  conformanceFiles?: readonly OtlpInputFile[]
  conformanceSkipped?: readonly SkippedInputFile[]
  conformanceIssues?: readonly OtlpIngestIssue[]
  conformanceWithheld?: readonly OtlpFieldWithheld[]
  conformanceUnreadable?: UnreadableSourceRows
  /** Sessions the selection skipped because they could not be read. */
  unread?: readonly UnreadSessionFact[]
}

/**
 * Read OTLP spans a foreign system emitted, skipping the adapter stage
 * entirely: the analysis engine is already OTLP-native, so conforming spans
 * need no translation to be analysed.
 */
export async function collectOtlpSpans(path: string, selector?: string, retained?: Awaited<ReturnType<typeof readOtlpInput>>): Promise<CollectedSpans> {
  const { sessionReportSource } = await import('./report.js')
  let input: Awaited<ReturnType<typeof readOtlpInput>>
  try {
    input = retained ?? await readOtlpInput(path)
  } catch (error) {
    if (!(await stat(path).catch(() => undefined))?.isDirectory()) throw error
    // A directory that is no run, store root or bundle is read as OTLP: say what else it could have been.
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. A directory ref is read as OTLP-JSONL unless it is a Runtime run ` +
        '(spawn-journal.jsonl, observer.jsonl or failure.json), a harness store root, or a bundle (manifest.json)',
    )
  }
  if (input.spans.length === 0) {
    throw new Error(
      `no analyzable spans in ${path} (${input.files.length} file(s), ${input.rows.length} row(s), ` +
        `${input.issues.length} unusable). Run \`traces check ${path} --contract conformance\` for the per-finding reason.`,
    )
  }
  const fileByTrace = new Map<string, string>()
  for (const file of input.files) {
    for (const traceId of file.traceIds) if (!fileByTrace.has(traceId)) fileByTrace.set(traceId, file.path)
  }
  const selected = selector ? selectSpans(input.spans, selector, path) : input.spans
  const byTrace = new Map<string, OtlpSpan[]>()
  for (const span of selected) {
    const grouped = byTrace.get(span.trace_id) ?? []
    grouped.push(span)
    byTrace.set(span.trace_id, grouped)
  }
  return {
    spans: [...selected],
    harness: 'otlp',
    sources: [...byTrace].map(([traceId, spans]) => sessionReportSource({
      harness: 'otlp',
      sessionId: traceId,
      path: fileByTrace.get(traceId) ?? path,
      cwd: null,
      mtimeMs: 0,
    }, spans, traceId)),
    conformance: input.validation,
    conformanceSubject: path,
    conformanceFiles: input.files,
    conformanceSkipped: input.skipped,
    conformanceIssues: input.issues,
    conformanceWithheld: input.withheld,
    conformanceUnreadable: input.unreadable,
  }
}

export async function collectRuntimeSpans(path: string): Promise<CollectedSpans> {
  const input = await readOtlpInput(path, { allowEmptyDirectory: true })
  if (input.files.length > 0) return collectOtlpSpans(path, undefined, input)
  return { spans: await (await import('./adapters/runtime-run.js')).readRuntimeRunDirectory(path), harness: 'agent-runtime', sources: [] }
}

export async function collectImportedSpans(
  path: string,
  format: TraceEvidenceFormatOption,
  selector?: string,
): Promise<CollectedSpans> {
  const { sessionReportSource } = await import('./report.js')
  const result = await exportTraceEvidenceFile(path, { format })
  const spans = selector ? selectSpans(result.spans, selector, path) : result.spans
  const { sessionByTrace } = indexSessionIdsByTrace(spans)
  const sessions = new Map<string, OtlpSpan[]>()
  for (const span of spans) {
    const sessionId = sessionByTrace.get(span.trace_id)
    if (!sessionId) continue
    const grouped = sessions.get(sessionId) ?? []
    grouped.push(span)
    sessions.set(sessionId, grouped)
  }
  return {
    spans,
    harness: result.format,
    sources: [...sessions].map(([sessionId, grouped]) => sessionReportSource({
      harness: result.format,
      sessionId,
      path,
      cwd: null,
      mtimeMs: 0,
    }, grouped, sessionId)),
  }
}

