/**
 * One place for "walk the selected harnesses, locate sessions, parse each to
 * spans." watch, the batch collector, and the uploader all need the same
 * locate → parse loop with explicit per-adapter error handling;
 * `scanSessions` is that loop, so each caller only writes what it does with the
 * spans.
 */

import { readsStoreRoots } from './adapters/harness-sessions.js'
import type { OtlpSpan } from './otlp.js'
import { stampEnvironmentAttrs, stampSessionIdentity } from './attributes.js'
import { stampSessionIntegrity } from './integrity.js'
import { type AdapterSelection, selectAdapters } from './registry.js'
import {
  cwdMatchesSelection,
  cwdMatchesSelectionResolved,
  equivalentGitCwds,
  normalizeRemote,
  pathIsGone,
  repositoryIdentity,
  resolveSessionRepoAttrs,
  stampRepoAttrs,
  stampSpanWorkdirRepoAttrs,
} from './repo.js'
import { validateOtlpSpans } from './span-validation.js'
import type { HarnessTraceAdapter, ParseOptions, SessionRef } from './types.js'

export { validateOtlpSpans }

async function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => {
      signal.removeEventListener('abort', stop)
      reject(signal.reason)
    }
    signal.addEventListener('abort', stop, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop)
        reject(error)
      },
    )
  })
}

/**
 * Parse one session to validated spans, stamped with its identity, integrity
 * and recorded environment, without resolving its repository. A reader that
 * needs only the session's own records (`list`) stops here.
 */
export async function readSessionSpans(
  adapter: HarnessTraceAdapter,
  ref: SessionRef,
  options: ParseOptions = {},
): Promise<OtlpSpan[]> {
  options.signal?.throwIfAborted()
  const spans = validateOtlpSpans(
    await awaitWithAbort(adapter.parse(ref, options), options.signal),
    `${adapter.harness} adapter output`,
  )
  options.signal?.throwIfAborted()
  if (spans.length === 0) throw new EmptySessionError(ref.path)
  stampSessionIntegrity(ref, spans)
  stampSessionIdentity(spans, ref.sessionId)
  // Environment identity stamps before repo resolution: recorded ground truth
  // (the image/cwd the session actually ran in) outranks host-side inference.
  stampEnvironmentAttrs(spans, ref.environment)
  if (ref.cwd === null && ref.environment?.cwd) ref.cwd = ref.environment.cwd
  return spans
}

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
  const spans = await readSessionSpans(adapter, ref, options)
  // A session recorded inside a sandbox names the sandbox's paths. Resolving
  // them on this host would attach whatever repo happens to live at the same
  // path here (a host `/work` checkout, say), so repo labels stay unresolved.
  if (ref.environment?.sandboxId) return spans
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

/**
 * Sessions whose recorded cwd is the selected directory or under it on a path
 * boundary (`/w/agent` never selects `/w/agent-dev-container`), or under a live
 * worktree of the same repository, or, when the recorded cwd no longer exists
 * (a removed `_wt/` worktree), whose recorded repository is the selected
 * directory's. Newest first, deduplicated.
 */
export async function locateSessions(
  adapter: HarnessTraceAdapter,
  opts: { cwd?: string; sinceMs?: number; home?: string } = {},
): Promise<SessionRef[]> {
  // An adapter that reads HOME alone would answer a store root with this
  // machine's sessions, so it has none there.
  if (opts.home !== undefined && !readsStoreRoots(adapter)) return []
  const refs = await adapter.locate({ sinceMs: opts.sinceMs, ...(opts.home !== undefined ? { home: opts.home } : {}) })
  return opts.cwd ? sessionsInCwd(adapter, refs, opts.cwd) : refs
}

/** The `refs` that `cwd` selects, by the rule `locateSessions` states. */
export async function sessionsInCwd(adapter: HarnessTraceAdapter, refs: readonly SessionRef[], cwd: string): Promise<SessionRef[]> {
  const cwdSelections = await equivalentGitCwds(cwd)
  const byKey = new Map<string, SessionRef>()
  // Per distinct recorded cwd, cached: locate can return thousands of refs,
  // and most share a handful of working directories.
  const resolvedMatch = new Map<string, Promise<boolean>>()
  const gone = new Map<string, Promise<boolean>>()
  let repository: Promise<string | null> | undefined
  const sameRepository = async (ref: SessionRef): Promise<boolean> => {
    if (!adapter.recordedRepository || ref.cwd === null) return false
    let missing = gone.get(ref.cwd)
    if (!missing) gone.set(ref.cwd, missing = pathIsGone(ref.cwd))
    if (!(await missing)) return false
    repository ??= repositoryIdentity(cwd)
    const wanted = await repository
    if (wanted === null) return false
    const recorded = await adapter.recordedRepository(ref)
    return recorded !== null && normalizeRemote(recorded) === wanted
  }
  for (const ref of refs) {
    let matched = cwdMatchesSelection(ref.cwd, cwdSelections)
    if (!matched && ref.cwd !== null) {
      let resolved = resolvedMatch.get(ref.cwd)
      if (!resolved) resolvedMatch.set(ref.cwd, resolved = cwdMatchesSelectionResolved(ref.cwd, cwdSelections))
      matched = await resolved
    }
    if (!matched) matched = await sameRepository(ref)
    if (!matched && !(ref.cwd === null && ref.integrity)) continue
    byKey.set(refKey(ref), ref)
  }
  return [...byKey.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export interface ScanOptions extends AdapterSelection, ParseOptions {
  /** Sessions recorded in this directory, a live worktree of its repository, or a removed worktree of it (see `locateSessions`). */
  cwd?: string
  /** Only sessions modified at/after this epoch ms. */
  sinceMs?: number
  /** A store root to read instead of HOME (see `LocateOptions.home`). */
  home?: string
  /** Cap to the most-recent N sessions per harness. */
  last?: number
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
      refs = await locateSessions(adapter, { cwd: opts.cwd, sinceMs: opts.sinceMs, home: opts.home })
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
        spans = await parseSession(adapter, ref, {
          corruptionMode: opts.corruptionMode,
          taskScope: opts.taskScope,
          taskTurnId: opts.taskTurnId,
          signal: opts.signal,
        })
      } catch (err) {
        if (!opts.onError) throw err
        opts.onError(err, ref)
        continue
      }
      yield { adapter, ref, spans }
    }
  }
}
