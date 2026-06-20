/**
 * Batch collection seam — `collectSessions` returns redacted spans per session
 * for a time window / harness selection, so a third party can feed batches or
 * clusters of traces into their own system (their own analysts, a vector store,
 * a fine-tune corpus, …) without the upload/dedup machinery.
 *
 * Redaction is ON by default — the safe posture when traces leave the box.
 */

import type { RedactionReport } from '@tangle-network/agent-eval/traces'
import type { OtlpSpan } from './otlp.js'
import { redactSpans } from './redact.js'
import { type ScanOptions, scanSessions } from './session-source.js'
import type { SessionRef } from './types.js'

export interface CollectOptions extends ScanOptions {
  /** Redact PII/secrets (default true). Set false to get raw spans. */
  redact?: boolean
}

export interface SessionBatch {
  ref: SessionRef
  spans: OtlpSpan[]
  /** Present when redaction ran (the default). */
  redaction?: RedactionReport
}

/** Select + parse (+ redact) sessions into per-session span batches. */
export async function collectSessions(opts: CollectOptions = {}): Promise<SessionBatch[]> {
  const out: SessionBatch[] = []
  for await (const { ref, spans } of scanSessions(opts)) {
    if (opts.redact === false) {
      out.push({ ref, spans })
    } else {
      const r = redactSpans(spans)
      out.push({ ref, spans: r.spans, redaction: r.report })
    }
  }
  return out
}
