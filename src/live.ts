import type { OtlpSpan } from './otlp.js'
import {
  orderSpans,
  ruleContext,
  runPipelines,
  runRules,
  type PipelineReport,
  type TraceLiveAction,
  type TraceLiveActionKind,
  type TraceLiveAnalyst,
  type TraceLiveFinding,
  type TraceStreamSession,
} from './pipelines.js'
import { scanSessions, type ScanOptions } from './session-source.js'
import type { SessionRef } from './types.js'

export interface TraceLiveLoop {
  readonly harness: string
  readonly sessionId: string
  readonly cwd: string | null
  readonly toolName: string
  readonly argHash: string
  readonly occurrences: number
  readonly windowMs: number
}

export interface TraceLiveBatch {
  readonly schemaVersion: 1
  readonly kind: 'traces.live_batch'
  readonly generatedAt: string
  readonly session: TraceStreamSession
  readonly spanCount: number
  readonly newSpanCount: number
  readonly toolCallCount: number
  readonly erroredToolCallCount: number
  readonly verificationCallCount: number
  readonly changeCallCount: number
  readonly actionCounts: Readonly<Record<TraceLiveActionKind, number>>
  readonly findingCount: number
  readonly findings: readonly TraceLiveFinding[]
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
      readonly kind: 'traces.stream.span'
      readonly event: 'span'
      readonly generatedAt: string
      readonly session: TraceStreamSession
      readonly span: OtlpSpan
    }
  | {
      readonly schemaVersion: 1
      readonly kind: 'traces.stream.batch'
      readonly event: 'analysis_batch'
      readonly generatedAt: string
      readonly ref?: SessionRef
      readonly batch: TraceLiveBatch
    }
  | {
      readonly schemaVersion: 1
      readonly kind: 'traces.stream.report'
      readonly event: 'report'
      readonly generatedAt: string
      readonly session: TraceStreamSession
      readonly ref: SessionRef
      readonly report: PipelineReport
      readonly loops: readonly TraceLiveLoop[]
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
      readonly sessions: number
      readonly newSpans: number
      readonly findings: number
    }

export interface LiveBatchOptions {
  readonly generatedAt?: string
  readonly session?: Partial<TraceStreamSession>
  readonly newSpanCount?: number
  /** Replaces the built-in deterministic live analysts. */
  readonly analysts?: readonly TraceLiveAnalyst[]
  /** Adds custom live analysts after the built-ins. */
  readonly extraAnalysts?: readonly TraceLiveAnalyst[]
}

export interface TraceStreamReplayOptions extends LiveBatchOptions {
  readonly ref?: SessionRef
  readonly includeSpans?: boolean
  readonly includeFindings?: boolean
}

export interface TraceStreamOptions extends ScanOptions {
  /** Observe sessions active within this window. Default 30 min. */
  readonly windowMs?: number
  /** Poll interval. Default 5s. */
  readonly intervalMs?: number
  /** Stop after one scan, useful for replay or tests. */
  readonly once?: boolean
  /** Emit one JSON event per new span. Default true. */
  readonly includeSpans?: boolean
  /** Emit live semantic findings. Default true. */
  readonly includeFindings?: boolean
  /** Emit session and analysis-batch events. Default true. */
  readonly includeBatches?: boolean
  /** Emit deterministic pipeline report events. Default false. */
  readonly includeReports?: boolean
  /** Minimum repeated identical calls for report loop detection. Default 3. */
  readonly minLoopOccurrences?: number
  /** Adds custom live analysts after the built-ins. */
  readonly extraAnalysts?: readonly TraceLiveAnalyst[]
  readonly onEvent: (event: TraceStreamEvent) => void | Promise<void>
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

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function actionCounts(actions: readonly TraceLiveAction[]): Record<TraceLiveActionKind, number> {
  const counts: Record<TraceLiveActionKind, number> = { tool: 0, read: 0, edit: 0, verify: 0, claim: 0, other: 0 }
  for (const action of actions) counts[action.kind] += 1
  return counts
}

function sessionFrom(spans: readonly OtlpSpan[], opts: LiveBatchOptions): TraceStreamSession {
  const first = spans[0]
  return {
    harness: opts.session?.harness ?? asString(first?.attributes['service.name']) ?? 'unknown',
    sessionId: opts.session?.sessionId ?? first?.trace_id ?? 'unknown',
    cwd: opts.session?.cwd ?? asString(first?.attributes['tangle.cwd']) ?? null,
    ...(opts.session?.path ? { path: opts.session.path } : {}),
  }
}

/** The shared rules (`pipelines.ts`) over one session's spans: the findings `analyze` reports for the same spans. */
export function analyzeLiveBatch(spans: readonly OtlpSpan[], opts: LiveBatchOptions = {}): TraceLiveBatch {
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const context = ruleContext(spans, {
    session: sessionFrom(orderSpans(spans), opts),
    generatedAt,
    ...(opts.newSpanCount !== undefined ? { newSpanCount: opts.newSpanCount } : {}),
  })
  const findings = runRules(context, opts)
  return {
    schemaVersion: 1,
    kind: 'traces.live_batch',
    generatedAt,
    session: context.session,
    spanCount: context.spans.length,
    newSpanCount: context.newSpanCount,
    toolCallCount: context.tools.length,
    erroredToolCallCount: context.erroredTools.length,
    verificationCallCount: context.verificationActions.length,
    changeCallCount: context.changeActions.length,
    actionCounts: actionCounts(context.actions),
    findingCount: findings.length,
    findings,
  }
}

function sessionEvent(session: TraceStreamSession, spans: readonly OtlpSpan[], generatedAt: string): TraceStreamEvent {
  const ordered = orderSpans(spans)
  return {
    schemaVersion: 1,
    kind: 'traces.stream.session',
    event: 'session',
    generatedAt,
    session,
    spanCount: ordered.length,
    startedAt: ordered[0]?.start_time ?? null,
    endedAt: ordered.at(-1)?.end_time ?? null,
  }
}

export function traceStreamEventsFromSpans(spans: readonly OtlpSpan[], opts: TraceStreamReplayOptions = {}): TraceStreamEvent[] {
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const session = sessionFrom(spans, {
    ...opts,
    session: opts.ref
      ? { harness: opts.ref.harness, sessionId: opts.ref.sessionId, cwd: opts.ref.cwd, path: opts.ref.path }
      : opts.session,
  })
  const ordered = orderSpans(spans)
  const batch = analyzeLiveBatch(ordered, {
    generatedAt,
    session,
    newSpanCount: ordered.length,
    analysts: opts.analysts,
    extraAnalysts: opts.extraAnalysts,
  })
  const events: TraceStreamEvent[] = [sessionEvent(session, ordered, generatedAt)]
  if (opts.includeSpans !== false) {
    for (const span of ordered) {
      events.push({ schemaVersion: 1, kind: 'traces.stream.span', event: 'span', generatedAt, session, span })
    }
  }
  events.push({ schemaVersion: 1, kind: 'traces.stream.batch', event: 'analysis_batch', generatedAt, ref: opts.ref, batch })
  if (opts.includeFindings !== false) {
    for (const liveFinding of batch.findings) {
      events.push({ schemaVersion: 1, kind: 'traces.stream.finding', event: 'finding', generatedAt, finding: liveFinding })
    }
  }
  return events
}

export function serializeTraceStreamEvent(event: TraceStreamEvent): string {
  return `${JSON.stringify(event)}\n`
}

function loopsFromReport(session: TraceStreamSession, report: PipelineReport): TraceLiveLoop[] {
  return report.stuckLoops.findings.map((loop) => ({
    harness: session.harness,
    sessionId: session.sessionId,
    cwd: session.cwd,
    toolName: loop.toolName,
    argHash: loop.argHash,
    occurrences: loop.occurrences,
    windowMs: loop.windowMs,
  }))
}

export async function streamSessions(opts: TraceStreamOptions): Promise<void> {
  const intervalMs = Math.max(250, opts.intervalMs ?? 5_000)
  const windowMs = opts.windowMs ?? 30 * 60_000
  const includeSpans = opts.includeSpans !== false
  const includeFindings = opts.includeFindings !== false
  const includeBatches = opts.includeBatches !== false
  const includeReports = opts.includeReports === true
  const seenSessions = new Set<string>()
  const seenSpans = new Set<string>()
  const seenFindings = new Set<string>()

  while (!opts.signal?.aborted) {
    let sessions = 0
    let newSpans = 0
    let findings = 0
    for await (const { adapter, ref, spans } of scanSessions({
      ...opts,
      sinceMs: opts.sinceMs ?? Date.now() - windowMs,
      signal: opts.signal,
    })) {
      const generatedAt = new Date().toISOString()
      const session: TraceStreamSession = { harness: adapter.harness, sessionId: ref.sessionId, cwd: ref.cwd, path: ref.path }
      const ordered = orderSpans(spans)
      const sessionKey = `${session.harness}:${session.sessionId}`
      const unseen = ordered.filter((span) => {
        const key = `${sessionKey}:${span.span_id}`
        if (seenSpans.has(key)) return false
        seenSpans.add(key)
        return true
      })
      sessions += 1
      newSpans += unseen.length
      if (!seenSessions.has(sessionKey)) {
        seenSessions.add(sessionKey)
        await opts.onEvent(sessionEvent(session, ordered, generatedAt))
      }
      if (includeSpans) {
        for (const span of unseen) {
          await opts.onEvent({ schemaVersion: 1, kind: 'traces.stream.span', event: 'span', generatedAt, session, span })
        }
      }
      const batch = analyzeLiveBatch(ordered, {
        generatedAt,
        session,
        newSpanCount: unseen.length,
        extraAnalysts: opts.extraAnalysts,
      })
      if (includeBatches) {
        await opts.onEvent({ schemaVersion: 1, kind: 'traces.stream.batch', event: 'analysis_batch', generatedAt, ref, batch })
      }
      if (includeReports) {
        try {
          const report = await runPipelines(ordered, { minLoopOccurrences: opts.minLoopOccurrences })
          await opts.onEvent({
            schemaVersion: 1,
            kind: 'traces.stream.report',
            event: 'report',
            generatedAt,
            session,
            ref,
            report,
            loops: loopsFromReport(session, report),
          })
        } catch (err) {
          opts.onError?.(err, ref)
        }
      }
      if (includeFindings) {
        for (const liveFinding of batch.findings) {
          if (seenFindings.has(liveFinding.id)) continue
          seenFindings.add(liveFinding.id)
          findings += 1
          await opts.onEvent({ schemaVersion: 1, kind: 'traces.stream.finding', event: 'finding', generatedAt, finding: liveFinding })
        }
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
    })
    if (opts.once || opts.signal?.aborted) break
    await sleep(intervalMs, opts.signal)
  }
}
