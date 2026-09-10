/**
 * The trace file and stores every analysis path reads.
 *
 * `analyze`, `investigate`, `improve`, and `ask` all write the selected spans
 * to one OpenInference file and read it back through agent-eval's
 * `OtlpFileTraceStore`. Keeping that sequence here means a source-bundle grant,
 * the file ceiling, and the containment check cannot differ between them.
 */

import { OtlpFileTraceStore, type SpanSourceReader } from '@tangle-network/agent-eval/traces'
import { assertOutsideSourceBundle, createBundleSourceReader } from './bundle-source.js'
import type { OtlpSpan } from './otlp.js'
import { writeOtlpFile } from './otlp.js'

/**
 * `viewTrace` and generated-file ceiling. The default 150KB cap exists to
 * protect an LLM's context window, and a single coding session is one trace
 * whose full span list routinely exceeds 150KB. The fixed ceiling covers large
 * sessions without disabling agent-eval's file-size guard.
 */
export const GENERATED_TRACE_FILE_CEILING = 512 * 1024 * 1024

export interface AnalysisTraceFile {
  readonly otlpPath: string
  /** Present only when the caller explicitly granted source reads through a bundle. */
  readonly sourceReader?: SpanSourceReader
}

/** Write the spans once and bind any explicitly granted source reader. */
export async function writeAnalysisTraceFile(
  spans: readonly OtlpSpan[],
  opts: {
    sourceBundle?: { path: string; maxRecordBytes?: number }
    otlpOutPath?: string
    signal?: AbortSignal
  } = {},
): Promise<AnalysisTraceFile> {
  if (opts.sourceBundle && opts.otlpOutPath) await assertOutsideSourceBundle(opts.sourceBundle.path, opts.otlpOutPath)
  const sourceReader = opts.sourceBundle
    ? await createBundleSourceReader(opts.sourceBundle.path, spans, {
        signal: opts.signal,
        maxRecordBytes: opts.sourceBundle.maxRecordBytes,
      })
    : undefined
  const otlpPath = await writeOtlpFile(spans, opts.otlpOutPath)
  return sourceReader ? { otlpPath, sourceReader } : { otlpPath }
}

/**
 * Store for model-driven analysis. It keeps agent-eval's default per-call byte
 * ceiling, so each tool result stays bounded for a model's context; the
 * engine drills in with `viewSpans` and `searchTrace` from a summary.
 */
export async function openAgenticTraceStore(file: AnalysisTraceFile): Promise<OtlpFileTraceStore> {
  const store = new OtlpFileTraceStore({
    path: file.otlpPath,
    maxFileBytes: GENERATED_TRACE_FILE_CEILING,
    ...(file.sourceReader ? { sourceReader: file.sourceReader } : {}),
  })
  await store.ensureIndexed()
  return store
}

/** Store for deterministic analysts, which have no context window to protect. */
export async function openDeterministicTraceStore(file: AnalysisTraceFile): Promise<OtlpFileTraceStore> {
  const store = new OtlpFileTraceStore({
    path: file.otlpPath,
    maxFileBytes: GENERATED_TRACE_FILE_CEILING,
    perCallByteCeiling: GENERATED_TRACE_FILE_CEILING,
    ...(file.sourceReader ? { sourceReader: file.sourceReader } : {}),
  })
  await store.ensureIndexed()
  return store
}
