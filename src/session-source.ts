/**
 * One place for "walk the selected harnesses, locate sessions, parse each to
 * spans." The observer, batch collector, and uploader all need the same
 * locate → parse loop with explicit per-adapter error handling;
 * `scanSessions` is that loop, so each caller only writes what it does with the
 * spans.
 */

import type { OtlpSpan } from './otlp.js'
import { stampSessionIntegrity } from './integrity.js'
import { type AdapterSelection, selectAdapters } from './registry.js'
import { cwdMatchesSelection, equivalentGitCwds, resolveSessionRepoAttrs, stampRepoAttrs, stampSpanWorkdirRepoAttrs } from './repo.js'
import type { HarnessTraceAdapter, ParseOptions, SessionRef } from './types.js'

/**
 * Parse one session to spans and stamp per-session repo/git resource attrs
 * (`tangle.subject.key` etc.) derived from the ref's cwd. Every OTLP-producing
 * path funnels through here so the spine can group by repo. Repo resolution is
 * computed ONCE per session; it is fail-safe and never throws.
 */
export async function parseSession(
  adapter: HarnessTraceAdapter,
  ref: SessionRef,
  options: ParseOptions = {},
): Promise<OtlpSpan[]> {
  const spans = await adapter.parse(ref, options)
  if (spans.length === 0) throw new EmptySessionError(ref.path)
  stampSessionIntegrity(ref, spans)
  const repo = await resolveSessionRepoAttrs(ref.cwd, spans)
  if (repo.cwd) ref.cwd = repo.cwd
  stampRepoAttrs(spans, repo.attrs)
  await stampSpanWorkdirRepoAttrs(spans)
  return spans
}

export class EmptySessionError extends Error {
  readonly sourcePath: string

  constructor(sourcePath: string) {
    super(`Session parser produced no spans at ${sourcePath}`)
    this.name = 'EmptySessionError'
    this.sourcePath = sourcePath
  }
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
    if (!cwdMatchesSelection(ref.cwd, cwdSelections) && !(ref.cwd === null && ref.integrity)) continue
    byKey.set(refKey(ref), ref)
  }
  return [...byKey.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export interface ScanOptions extends AdapterSelection, ParseOptions {
  /** Filter by working directory (exact/prefix). */
  cwd?: string
  /** Only sessions modified at/after this epoch ms. */
  sinceMs?: number
  /** Cap to the most-recent N sessions per harness. */
  last?: number
  /** Cancel the scan; iteration stops between sessions. */
  signal?: AbortSignal
  /** Handle a locate/parse failure and continue. Without this callback, failures propagate. */
  onError?: (error: unknown, ref?: SessionRef) => void
}

export interface ScannedSession {
  adapter: import('./types.js').HarnessTraceAdapter
  ref: SessionRef
  /** Parsed spans for the session. */
  spans: OtlpSpan[]
}

/** Yield every session across the selected adapters. Locate/parse errors
 *  propagate unless an explicit `onError` callback handles them. */
export async function* scanSessions(opts: ScanOptions): AsyncGenerator<ScannedSession> {
  for (const adapter of selectAdapters(opts)) {
    if (opts.signal?.aborted) return
    let refs: SessionRef[]
    try {
      refs = await locateSessions(adapter, { cwd: opts.cwd, sinceMs: opts.sinceMs })
    } catch (err) {
      if (!opts.onError) throw err
      opts.onError(err)
      continue
    }
    if (opts.last && opts.last > 0) refs = refs.slice(0, opts.last)
    for (const ref of refs) {
      if (opts.signal?.aborted) return
      let spans: OtlpSpan[]
      try {
        spans = await parseSession(adapter, ref, { corruptionMode: opts.corruptionMode })
      } catch (err) {
        if (!opts.onError) throw err
        opts.onError(err, ref)
        continue
      }
      yield { adapter, ref, spans }
    }
  }
}
