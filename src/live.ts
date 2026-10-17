/**
 * `traces watch`: the one live engine.
 *
 * Each pass reads the sessions a watch follows, runs the rules `analyze`
 * ranks (`pipelines.ts`) over each, and emits the `traces.stream.*` envelope
 * at schemaVersion 1: a `session` event the first time a session is seen, a
 * `finding` event the first time a finding is, and one `tick` per pass, which
 * names every session the pass could not read. `traces watch --format jsonl`
 * prints these events and `traces watch` text renders the same ones, so what
 * a machine reads (trustgate's `projectTrace`) and what a person reads cannot
 * disagree. The envelope is a stable API: `docs/watch-jsonl.v1.example.jsonl`
 * is the CLI's output on a fixture, and `tests/watch-jsonl-contract.test.ts`
 * holds the fields consumers read.
 */
import { sessionIdFromAttributes } from './attributes.js'
import type { OtlpSpan } from './otlp.js'
import {
  orderSpans,
  ruleContext,
  runRules,
  type TraceLiveAnalyst,
  type TraceLiveFinding,
  type TraceStreamSession,
} from './pipelines.js'
import { parseSession, scanSessions, type ScanOptions } from './session-source.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'

/** A session a pass could not read: it is skipped and named, and the watch goes on. */
export interface TraceStreamUnread {
  readonly sessionId: string | null
  readonly source: string
  readonly reason: string
}

export type TraceStreamEvent =
  | {
      readonly schemaVersion: 1
      readonly kind: 'traces.stream.session'
      readonly event: 'session'
      readonly generatedAt: string
      readonly session: TraceStreamSession
      readonly spanCount: number
      readonly startedAt: string | null
      readonly endedAt: string | null
    }
  | {
      readonly schemaVersion: 1
      readonly kind: 'traces.stream.finding'
      readonly event: 'finding'
      readonly generatedAt: string
      readonly finding: TraceLiveFinding
    }
  | {
      readonly schemaVersion: 1
      readonly kind: 'traces.stream.tick'
      readonly event: 'tick'
      readonly generatedAt: string
      /** Sessions this pass read. */
      readonly sessions: number
      /** Spans those sessions gained since the previous pass. */
      readonly newSpans: number
      /** Findings this pass emitted for the first time. */
      readonly findings: number
      readonly unreadSessions: readonly TraceStreamUnread[]
    }

/** One session's spans, as one pass read them. */
export interface WatchedSession {
  readonly session: TraceStreamSession
  readonly spans: readonly OtlpSpan[]
}

/** What a watch reads on each pass. It records each session it could not read in `unread` and goes on. */
export type WatchSource = (unread: TraceStreamUnread[]) => AsyncIterable<WatchedSession>

export interface WatchLoopOptions {
  /** Default 5 s. */
  readonly intervalMs?: number
  /** One pass, then return. */
  readonly once?: boolean
  signal?: AbortSignal
  /** Adds custom rules after the built-ins. */
  readonly extraAnalysts?: readonly TraceLiveAnalyst[]
  readonly onEvent: (event: TraceStreamEvent) => void | Promise<void>
}

export interface TraceStreamOptions extends ScanOptions, WatchLoopOptions {
  /** Watch these sessions instead of every session active in the window. */
  readonly sessions?: ReadonlyArray<{ readonly adapter: HarnessTraceAdapter; readonly ref: SessionRef }>
  /**
   * Watch every session active in the last `windowMs`. The window slides: its
   * start is recomputed on every pass, so a long-running watch never goes
   * blind. `sinceMs` fixes the start instead. Default 30 min.
   */
  readonly windowMs?: number
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(t)
      resolve()
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run `source` pass after pass: emit each session the first time it is seen,
 * each finding the first time it is seen, and a tick per pass. `streamSessions`
 * runs it over harness sessions; `traces watch <span file> --format jsonl` over
 * a span file's runs.
 */
export async function watchSource(source: WatchSource, opts: WatchLoopOptions): Promise<void> {
  const intervalMs = Math.max(250, opts.intervalMs ?? 5_000)
  const seenSessions = new Set<string>()
  const spanCounts = new Map<string, number>()
  const seenFindings = new Set<string>()
  while (!opts.signal?.aborted) {
    let sessions = 0
    let newSpans = 0
    let findings = 0
    const unread: TraceStreamUnread[] = []
    for await (const { session, spans } of source(unread)) {
      const generatedAt = new Date().toISOString()
      const ordered = orderSpans(spans)
      const key = `${session.harness}:${session.sessionId}`
      sessions += 1
      newSpans += Math.max(0, ordered.length - (spanCounts.get(key) ?? 0))
      spanCounts.set(key, ordered.length)
      if (!seenSessions.has(key)) {
        seenSessions.add(key)
        await opts.onEvent({
          schemaVersion: 1,
          kind: 'traces.stream.session',
          event: 'session',
          generatedAt,
          session,
          spanCount: ordered.length,
          startedAt: ordered[0]?.start_time ?? null,
          endedAt: ordered.at(-1)?.end_time ?? null,
        })
      }
      for (const finding of runRules(ruleContext(ordered, { session, generatedAt }), { extraAnalysts: opts.extraAnalysts })) {
        if (seenFindings.has(finding.id)) continue
        seenFindings.add(finding.id)
        findings += 1
        await opts.onEvent({ schemaVersion: 1, kind: 'traces.stream.finding', event: 'finding', generatedAt, finding })
      }
    }
    await opts.onEvent({
      schemaVersion: 1,
      kind: 'traces.stream.tick',
      event: 'tick',
      generatedAt: new Date().toISOString(),
      sessions,
      newSpans,
      findings,
      unreadSessions: unread,
    })
    if (opts.once || opts.signal?.aborted) break
    await sleep(intervalMs, opts.signal)
  }
}

/** The harness sessions `opts` selects, read afresh on each pass. */
function sessionSource(opts: TraceStreamOptions): WatchSource {
  return async function* (unread) {
    const skip = (error: unknown, ref?: SessionRef): void => {
      unread.push({ sessionId: ref?.sessionId ?? null, source: ref?.path ?? 'a session store', reason: errorText(error) })
      opts.onError?.(error, ref)
    }
    const named = opts.sessions
    if (named) {
      for (const { adapter, ref } of named) {
        if (opts.signal?.aborted) return
        let spans: OtlpSpan[]
        try {
          spans = await parseSession(adapter, ref, { corruptionMode: opts.corruptionMode, signal: opts.signal })
        } catch (error) {
          skip(error, ref)
          continue
        }
        // A session named by its file is known by that path until it is read; its records name it.
        const root = spans.find((span) => span.parent_span_id === null) ?? spans[0]
        const sessionId = (root && sessionIdFromAttributes(root.attributes)) ?? ref.sessionId
        yield { session: { harness: adapter.harness, sessionId, cwd: ref.cwd, path: ref.path }, spans }
      }
      return
    }
    const scanned = scanSessions({ ...opts, sinceMs: opts.sinceMs ?? Date.now() - (opts.windowMs ?? 30 * 60_000), onError: skip })
    for await (const { adapter, ref, spans } of scanned) {
      yield { session: { harness: adapter.harness, sessionId: ref.sessionId, cwd: ref.cwd, path: ref.path }, spans }
    }
  }
}

/** Watch harness sessions: every session active in the window, or the ones `opts.sessions` names. */
export async function streamSessions(opts: TraceStreamOptions): Promise<void> {
  await watchSource(sessionSource(opts), opts)
}
