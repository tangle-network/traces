/**
 * One place for "walk the selected harnesses, locate sessions, parse each to
 * spans." The observer, batch collector, and uploader all need the same
 * locate → parse → skip-empty loop with non-fatal per-adapter error handling;
 * `scanSessions` is that loop, so each caller only writes what it does with the
 * spans.
 */

import type { OtlpSpan } from './otlp.js'
import { type AdapterSelection, selectAdapters } from './registry.js'
import type { SessionRef } from './types.js'

export interface ScanOptions extends AdapterSelection {
  /** Filter by working directory (exact/prefix). */
  cwd?: string
  /** Only sessions modified at/after this epoch ms. */
  sinceMs?: number
  /** Cap to the most-recent N sessions per harness. */
  last?: number
  /** Cancel the scan; iteration stops between sessions. */
  signal?: AbortSignal
  /** Per-adapter locate/parse failure (the scan continues). */
  onError?: (error: unknown, ref?: SessionRef) => void
}

export interface ScannedSession {
  adapter: import('./types.js').HarnessTraceAdapter
  ref: SessionRef
  /** Non-empty parsed spans for the session. */
  spans: OtlpSpan[]
}

/** Yield every non-empty session across the selected adapters. Locate/parse
 *  errors route to `onError` and skip that adapter/session, never aborting. */
export async function* scanSessions(opts: ScanOptions): AsyncGenerator<ScannedSession> {
  for (const adapter of selectAdapters(opts)) {
    if (opts.signal?.aborted) return
    let refs: SessionRef[]
    try {
      refs = await adapter.locate({ cwd: opts.cwd, sinceMs: opts.sinceMs })
    } catch (err) {
      opts.onError?.(err)
      continue
    }
    if (opts.last && opts.last > 0) refs = refs.slice(0, opts.last)
    for (const ref of refs) {
      if (opts.signal?.aborted) return
      let spans: OtlpSpan[]
      try {
        spans = await adapter.parse(ref)
      } catch (err) {
        opts.onError?.(err, ref)
        continue
      }
      if (spans.length === 0) continue
      yield { adapter, ref, spans }
    }
  }
}
