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
import { listAdapters, resolveAdapter } from './registry.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'

export interface CollectOptions {
  /** Harness ids/aliases. Omit (or `all: true`) → every harness. */
  harnesses?: string[]
  all?: boolean
  /** Collect from these adapters instead of the built-in registry. */
  adapters?: HarnessTraceAdapter[]
  /** Filter by working directory (exact/prefix). */
  cwd?: string
  /** Only sessions modified at/after this epoch ms. */
  sinceMs?: number
  /** Cap to the most-recent N sessions per harness. */
  last?: number
  /** Redact PII/secrets (default true). Set false to get raw spans. */
  redact?: boolean
}

export interface SessionBatch {
  ref: SessionRef
  spans: OtlpSpan[]
  /** Present when redaction ran (the default). */
  redaction?: RedactionReport
}

function adaptersFor(opts: CollectOptions): HarnessTraceAdapter[] {
  if (opts.adapters && opts.adapters.length > 0) return opts.adapters
  if (opts.all || !opts.harnesses || opts.harnesses.length === 0) return [...listAdapters()]
  const out: HarnessTraceAdapter[] = []
  for (const h of opts.harnesses) {
    const a = resolveAdapter(h)
    if (a && !out.includes(a)) out.push(a)
  }
  return out
}

/** Select + parse (+ redact) sessions into per-session span batches. */
export async function collectSessions(opts: CollectOptions = {}): Promise<SessionBatch[]> {
  const out: SessionBatch[] = []
  for (const adapter of adaptersFor(opts)) {
    let refs: SessionRef[]
    try {
      refs = await adapter.locate({ cwd: opts.cwd, sinceMs: opts.sinceMs })
    } catch {
      continue
    }
    if (opts.last && opts.last > 0) refs = refs.slice(0, opts.last)
    for (const ref of refs) {
      let spans: OtlpSpan[]
      try {
        spans = await adapter.parse(ref)
      } catch {
        continue
      }
      if (spans.length === 0) continue
      if (opts.redact === false) {
        out.push({ ref, spans })
      } else {
        const r = redactSpans(spans)
        out.push({ ref, spans: r.spans, redaction: r.report })
      }
    }
  }
  return out
}
