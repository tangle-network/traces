/**
 * Live trace observer — compatibility wrapper behind `traces watch`.
 *
 * `streamSessions` is the single live scanner. `watchSessions` keeps the
 * callback-oriented SDK surface for existing users while consuming stream
 * events instead of running a second polling loop.
 */

import type { PipelineReport } from './pipelines.js'
import { streamSessions, type TraceLiveBatch, type TraceLiveFinding, type TraceLiveLoop } from './live.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'

export type ObservedLoop = TraceLiveLoop

export interface ObserverOptions {
  /** Harness ids/aliases to observe. Omit (or pass `all: true`) → every harness. */
  harnesses?: string[]
  all?: boolean
  /** Observe these adapters instead of the built-in registry — plug in your
   *  own `HarnessTraceAdapter`s. Takes precedence over `harnesses`/`all`. */
  adapters?: HarnessTraceAdapter[]
  /** Only observe sessions whose cwd matches (exact/prefix). */
  cwd?: string
  /** Consider sessions active within this window (ms). Default 30 min. */
  windowMs?: number
  /** Poll interval (ms). Default 5 s. */
  intervalMs?: number
  /** Min identical repeated calls before a loop is reported. Default 3. */
  minLoopOccurrences?: number
  /** Cancel the observer; `watchSessions` resolves when this aborts. */
  signal?: AbortSignal
  /** Fired once per stuck loop the first time it reaches threshold, and again
   *  each time its occurrence count grows — deduped so you only see new signal. */
  onLoop?: (loop: ObservedLoop) => void | Promise<void>
  /** Fired for every observed session each tick, with its full pipeline report
   *  (stuck loops + tool-use metrics) — react to anything, not just loops. */
  onReport?: (ref: SessionRef, report: PipelineReport) => void | Promise<void>
  /** Fired for every observed session each tick, after semantic live analysis. */
  onBatch?: (ref: SessionRef, batch: TraceLiveBatch) => void | Promise<void>
  /** Fired once for each newly-observed live semantic finding. */
  onFinding?: (finding: TraceLiveFinding) => void | Promise<void>
  /** Per-session parse/pipeline error (the observer keeps going). */
  onError?: (error: unknown, ref?: SessionRef) => void
  /** Fired after each poll cycle. */
  onTick?: (stats: { sessions: number }) => void
}

function loopKey(loop: ObservedLoop): string {
  return `${loop.sessionId}:${loop.toolName}:${loop.argHash}`
}

async function callSafely(ref: SessionRef | undefined, onError: ObserverOptions['onError'], fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    onError?.(err, ref)
  }
}

export async function watchSessions(opts: ObserverOptions): Promise<void> {
  const seenLoops = new Map<string, number>()

  await streamSessions({
    adapters: opts.adapters,
    all: opts.all,
    harnesses: opts.harnesses,
    cwd: opts.cwd,
    windowMs: opts.windowMs,
    intervalMs: opts.intervalMs,
    minLoopOccurrences: opts.minLoopOccurrences,
    signal: opts.signal,
    includeSpans: false,
    includeBatches: Boolean(opts.onBatch),
    includeFindings: Boolean(opts.onFinding),
    includeReports: Boolean(opts.onReport || opts.onLoop),
    onError: opts.onError,
    onEvent: async (event) => {
      if (event.event === 'analysis_batch') {
        if (event.ref) {
          await callSafely(event.ref, opts.onError, () => opts.onBatch?.(event.ref!, event.batch))
        }
      } else if (event.event === 'finding') {
        await callSafely(undefined, opts.onError, () => opts.onFinding?.(event.finding))
      } else if (event.event === 'report') {
        await callSafely(event.ref, opts.onError, () => opts.onReport?.(event.ref, event.report))
        for (const loop of event.loops) {
          const key = loopKey(loop)
          if (loop.occurrences <= (seenLoops.get(key) ?? 0)) continue
          seenLoops.set(key, loop.occurrences)
          await callSafely(event.ref, opts.onError, () => opts.onLoop?.(loop))
        }
      } else if (event.event === 'tick') {
        await callSafely(undefined, opts.onError, () => opts.onTick?.({ sessions: event.sessions }))
      }
    },
  })
}
