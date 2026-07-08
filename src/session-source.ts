/**
 * One place for "walk the selected harnesses, locate sessions, parse each to
 * spans." The observer, batch collector, and uploader all need the same
 * locate → parse → skip-empty loop with non-fatal per-adapter error handling;
 * `scanSessions` is that loop, so each caller only writes what it does with the
 * spans.
 */

import type { OtlpSpan } from './otlp.js'
import { type AdapterSelection, selectAdapters } from './registry.js'
import { cwdMatchesSelection, equivalentGitCwds, resolveSessionRepoAttrs, stampRepoAttrs, stampSpanWorkdirRepoAttrs } from './repo.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'

/**
 * Parse one session to spans and stamp per-session repo/git resource attrs
 * (`tangle.subject.key` etc.) derived from the ref's cwd. Every OTLP-producing
 * path funnels through here so the spine can group by repo. Repo resolution is
 * computed ONCE per session; it is fail-safe and never throws.
 */
export async function parseSession(adapter: HarnessTraceAdapter, ref: SessionRef): Promise<OtlpSpan[]> {
  const spans = await adapter.parse(ref)
  const repo = await resolveSessionRepoAttrs(ref.cwd, spans)
  if (repo.cwd) ref.cwd = repo.cwd
  stampRepoAttrs(spans, repo.attrs)
  await stampSpanWorkdirRepoAttrs(spans)
  return spans
}

function refKey(ref: SessionRef): string {
  return `${ref.harness}\0${ref.path}\0${ref.sessionId}`
}

/** Locate through every equivalent git worktree for the selected cwd, then
 *  dedupe and apply a boundary-aware final filter. */
export async function locateSessions(
  adapter: HarnessTraceAdapter,
  opts: { cwd?: string; sinceMs?: number } = {},
): Promise<SessionRef[]> {
  if (!opts.cwd) return adapter.locate({ sinceMs: opts.sinceMs })

  const cwdSelections = await equivalentGitCwds(opts.cwd)
  const refs = await adapter.locate({ sinceMs: opts.sinceMs })
  const byKey = new Map<string, SessionRef>()
  for (const ref of refs) {
    if (!cwdMatchesSelection(ref.cwd, cwdSelections)) continue
    byKey.set(refKey(ref), ref)
  }
  return [...byKey.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
}

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
      refs = await locateSessions(adapter, { cwd: opts.cwd, sinceMs: opts.sinceMs })
    } catch (err) {
      opts.onError?.(err)
      continue
    }
    if (opts.last && opts.last > 0) refs = refs.slice(0, opts.last)
    for (const ref of refs) {
      if (opts.signal?.aborted) return
      let spans: OtlpSpan[]
      try {
        spans = await parseSession(adapter, ref)
      } catch (err) {
        opts.onError?.(err, ref)
        continue
      }
      if (spans.length === 0) continue
      yield { adapter, ref, spans }
    }
  }
}
