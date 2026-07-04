import { createHash } from 'node:crypto'
import type { OtlpSpan } from './otlp.js'
import type { PipelineReport } from './pipelines.js'
import { runPipelines } from './pipelines.js'
import { scanSessions, type ScanOptions } from './session-source.js'
import type { SessionRef } from './types.js'

export type TraceLiveSeverity = 'info' | 'low' | 'medium' | 'high'

export interface TraceLiveEvidence {
  readonly kind: 'metric' | 'span' | 'pattern'
  readonly label: string
  readonly value: string
  readonly spanIds?: readonly string[]
}

export interface TraceLiveFinding {
  readonly schemaVersion: 1
  readonly kind: 'traces.live_finding'
  readonly id: string
  readonly ruleId: string
  readonly fingerprint: string
  readonly severity: TraceLiveSeverity
  readonly title: string
  readonly claim: string
  readonly action: string
  readonly check: string
  readonly evidence: readonly TraceLiveEvidence[]
  readonly session: TraceStreamSession
  readonly observedAt: string
}

export interface TraceStreamSession {
  readonly harness: string
  readonly sessionId: string
  readonly cwd: string | null
  readonly path?: string
}

export type TraceLiveActionKind = 'tool' | 'read' | 'edit' | 'verify' | 'claim' | 'other'

export interface TraceLiveAction {
  readonly kind: TraceLiveActionKind
  readonly spanId: string
  readonly span: OtlpSpan
  readonly toolName?: string
  readonly signature: string
  readonly errored: boolean
}

export interface TraceLiveLoop {
  readonly harness: string
  readonly sessionId: string
  readonly cwd: string | null
  readonly toolName: string
  readonly argHash: string
  readonly occurrences: number
  readonly windowMs: number
}

export interface TraceLiveAnalysisContext {
  readonly spans: readonly OtlpSpan[]
  readonly actions: readonly TraceLiveAction[]
  readonly tools: readonly OtlpSpan[]
  readonly erroredTools: readonly OtlpSpan[]
  readonly verificationActions: readonly TraceLiveAction[]
  readonly changeActions: readonly TraceLiveAction[]
  readonly session: TraceStreamSession
  readonly generatedAt: string
  readonly newSpanCount: number
}

export interface TraceLiveAnalyst {
  readonly id: string
  analyze(context: TraceLiveAnalysisContext): readonly TraceLiveFinding[]
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

const VERIFY_RE = /\b(test|tests|vitest|jest|pytest|go test|cargo test|tsc|typecheck|lint|biome|eslint|build|check:invariants|preflight)\b/i
const CHANGE_RE = /\b(apply_patch|edit|write|create|delete|rename|replace|update|git apply|sed -i|perl -pi|tee\s|cat\s+>)/i
const CLAIM_DONE_RE = /\b(done|fixed|complete|completed|implemented|merged|verified|all green|tests pass|ready|works now)\b/i

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

function hash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function spanKind(span: OtlpSpan): string {
  return asString(span.attributes['openinference.span.kind'])?.toUpperCase() ?? 'SPAN'
}

function spanContent(span: OtlpSpan): string {
  return (
    asString(span.attributes.content) ??
    asString(span.attributes['input.value']) ??
    asString(span.attributes['llm.input']) ??
    asString(span.attributes['gen_ai.prompt']) ??
    ''
  )
}

function toolName(span: OtlpSpan): string {
  return asString(span.attributes['tool.name']) ?? span.name.replace(/^tool\./, '')
}

function toolSignature(span: OtlpSpan): string {
  const content = spanContent(span).replace(/\s+/g, ' ').trim()
  return `${toolName(span)}:${content || span.name}`
}

function isTool(span: OtlpSpan): boolean {
  return spanKind(span) === 'TOOL' || span.attributes['tool.name'] != null || span.name.startsWith('tool.')
}

function isTextSpan(span: OtlpSpan): boolean {
  return !isTool(span) && spanContent(span).length > 0
}

function isVerification(span: OtlpSpan): boolean {
  if (!isTool(span)) return false
  return VERIFY_RE.test(`${toolName(span)} ${span.name} ${spanContent(span)}`)
}

function isChange(span: OtlpSpan): boolean {
  if (!isTool(span)) return false
  return CHANGE_RE.test(`${toolName(span)} ${span.name} ${spanContent(span)}`)
}

function isRead(span: OtlpSpan): boolean {
  if (!isTool(span)) return false
  return /\b(read|cat|less|grep|rg|sed -n|nl|ls|find|git show|git diff)\b/i.test(`${toolName(span)} ${span.name} ${spanContent(span)}`)
}

function actionKind(span: OtlpSpan): TraceLiveActionKind {
  if (isVerification(span)) return 'verify'
  if (isChange(span)) return 'edit'
  if (isRead(span)) return 'read'
  if (isTool(span)) return 'tool'
  if (isTextSpan(span) && CLAIM_DONE_RE.test(spanContent(span))) return 'claim'
  return 'other'
}

export function classifyLiveActions(spans: readonly OtlpSpan[]): TraceLiveAction[] {
  return orderSpans(spans).map((span) => {
    const tool = isTool(span) ? toolName(span) : undefined
    return {
      kind: actionKind(span),
      spanId: span.span_id,
      span,
      ...(tool ? { toolName: tool } : {}),
      signature: toolSignature(span),
      errored: span.status.code === 'ERROR',
    }
  })
}

function actionCounts(actions: readonly TraceLiveAction[]): Record<TraceLiveActionKind, number> {
  const counts: Record<TraceLiveActionKind, number> = { tool: 0, read: 0, edit: 0, verify: 0, claim: 0, other: 0 }
  for (const action of actions) counts[action.kind] += 1
  return counts
}

function timeOf(span: OtlpSpan): number {
  const parsed = Date.parse(span.start_time)
  return Number.isFinite(parsed) ? parsed : 0
}

function orderSpans(spans: readonly OtlpSpan[]): OtlpSpan[] {
  return [...spans].sort((a, b) => {
    const stepA = typeof a.attributes.step === 'number' ? a.attributes.step : undefined
    const stepB = typeof b.attributes.step === 'number' ? b.attributes.step : undefined
    if (stepA != null && stepB != null && stepA !== stepB) return stepA - stepB
    return timeOf(a) - timeOf(b)
  })
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

function evidence(kind: TraceLiveEvidence['kind'], label: string, value: string, spanIds?: readonly string[]): TraceLiveEvidence {
  return { kind, label, value, ...(spanIds && spanIds.length > 0 ? { spanIds } : {}) }
}

function finding(input: {
  ruleId: string
  severity: TraceLiveSeverity
  title: string
  claim: string
  action: string
  check: string
  evidence: readonly TraceLiveEvidence[]
  session: TraceStreamSession
  observedAt: string
  signature: readonly string[]
}): TraceLiveFinding {
  const fingerprint = hash([input.ruleId, ...input.signature])
  return {
    schemaVersion: 1,
    kind: 'traces.live_finding',
    id: `live.${input.ruleId}.${fingerprint}`,
    fingerprint,
    ruleId: input.ruleId,
    severity: input.severity,
    title: input.title,
    claim: input.claim,
    action: input.action,
    check: input.check,
    evidence: input.evidence,
    session: input.session,
    observedAt: input.observedAt,
  }
}

const sameFailingCommandAnalyst: TraceLiveAnalyst = {
  id: 'same-failing-command',
  analyze(context) {
    const findings: TraceLiveFinding[] = []
    const failedBySignature = new Map<string, OtlpSpan[]>()
    for (const action of context.actions) {
      if (!action.toolName || !action.errored) continue
      failedBySignature.set(action.signature, [...(failedBySignature.get(action.signature) ?? []), action.span])
    }
    for (const [signature, rows] of failedBySignature) {
      if (rows.length < 2) continue
      findings.push(finding({
        ruleId: 'same-failing-command',
        severity: rows.length >= 3 ? 'high' : 'medium',
        title: 'Same failing command is repeating',
        claim: `${rows.length} failed tool call(s) repeated the same command or arguments.`,
        action: 'Stop rerunning it; inspect the first failure, change state, or choose a different diagnostic path before another retry.',
        check: 'The next action should read the failing file, inspect the stack/output, or edit code before this command runs again.',
        evidence: [
          evidence('pattern', 'command', signature, rows.map((span) => span.span_id)),
          evidence('metric', 'failed_repeats', String(rows.length)),
        ],
        session: context.session,
        observedAt: context.generatedAt,
        signature: [signature, String(rows.length)],
      }))
    }
    return findings
  },
}

const verificationWithoutChangeAnalyst: TraceLiveAnalyst = {
  id: 'verification-without-change',
  analyze(context) {
    let verificationSinceChange = 0
    const verificationSpanIds: string[] = []
    for (const action of context.actions) {
      if (action.kind === 'edit') {
        verificationSinceChange = 0
        verificationSpanIds.length = 0
      } else if (action.kind === 'verify') {
        verificationSinceChange += 1
        verificationSpanIds.push(action.spanId)
      }
    }
    if (verificationSinceChange < 2) return []
    return [finding({
      ruleId: 'verification-without-change',
      severity: verificationSinceChange >= 3 ? 'high' : 'medium',
      title: 'Verification is repeating without a state change',
      claim: `${verificationSinceChange} verification command(s) ran after the last detected code/config change.`,
      action: 'Do not spend another verification run until the agent either edits state or explains what new signal the rerun will reveal.',
      check: 'The next action should be a code/config edit, targeted file read, or a different narrow diagnostic command.',
      evidence: [
        evidence('metric', 'verification_calls_since_change', String(verificationSinceChange), verificationSpanIds),
        evidence('metric', 'change_calls', String(context.changeActions.length)),
      ],
      session: context.session,
      observedAt: context.generatedAt,
      signature: [String(verificationSinceChange), verificationSpanIds.join(',')],
    })]
  },
}

const completionClaimWithoutVerificationAnalyst: TraceLiveAnalyst = {
  id: 'completion-claim-without-verification',
  analyze(context) {
    const lastClaim = [...context.actions].reverse().find((action) => action.kind === 'claim')
    if (!lastClaim) return []
    const claimTime = timeOf(lastClaim.span)
    const verificationAfterClaim = context.verificationActions.some((action) => timeOf(action.span) > claimTime)
    if (verificationAfterClaim) return []
    return [finding({
      ruleId: 'completion-claim-without-verification',
      severity: 'medium',
      title: 'Completion claim has no later verification',
      claim: 'The agent claimed completion, correctness, or verification without a later verification tool call in the observed trace.',
      action: 'Require a concrete check after the claim, or downgrade the claim to an unverified hypothesis.',
      check: 'A later test/build/typecheck/lint/smoke command should appear after the claim.',
      evidence: [
        evidence('span', 'claim_span', spanContent(lastClaim.span).slice(0, 240), [lastClaim.spanId]),
        evidence('metric', 'verification_after_claim', '0'),
      ],
      session: context.session,
      observedAt: context.generatedAt,
      signature: [lastClaim.spanId, spanContent(lastClaim.span).slice(0, 120)],
    })]
  },
}

const highToolErrorRateAnalyst: TraceLiveAnalyst = {
  id: 'high-tool-error-rate',
  analyze(context) {
    if (context.tools.length < 4 || context.erroredTools.length / context.tools.length < 0.5) return []
    return [finding({
      ruleId: 'high-tool-error-rate',
      severity: context.erroredTools.length / context.tools.length >= 0.75 ? 'high' : 'medium',
      title: 'Tool calls are mostly failing',
      claim: `${context.erroredTools.length}/${context.tools.length} tool call(s) in this live batch ended with ERROR.`,
      action: 'Switch from broad execution to diagnosis: classify the dominant error, then run one targeted command to validate the fix path.',
      check: 'The next batch should reduce the error ratio or show a new targeted diagnostic result.',
      evidence: [
        evidence('metric', 'errored_tool_calls', `${context.erroredTools.length}/${context.tools.length}`, context.erroredTools.map((span) => span.span_id)),
      ],
      session: context.session,
      observedAt: context.generatedAt,
      signature: [String(context.erroredTools.length), String(context.tools.length)],
    })]
  },
}

export const defaultTraceLiveAnalysts: readonly TraceLiveAnalyst[] = [
  sameFailingCommandAnalyst,
  verificationWithoutChangeAnalyst,
  completionClaimWithoutVerificationAnalyst,
  highToolErrorRateAnalyst,
]

function liveAnalysts(opts: LiveBatchOptions): readonly TraceLiveAnalyst[] {
  return [...(opts.analysts ?? defaultTraceLiveAnalysts), ...(opts.extraAnalysts ?? [])]
}

export function analyzeLiveBatch(spans: readonly OtlpSpan[], opts: LiveBatchOptions = {}): TraceLiveBatch {
  const ordered = orderSpans(spans)
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const session = sessionFrom(ordered, opts)
  const actions = classifyLiveActions(ordered)
  const tools = ordered.filter(isTool)
  const erroredTools = tools.filter((span) => span.status.code === 'ERROR')
  const verificationActions = actions.filter((action) => action.kind === 'verify')
  const changeActions = actions.filter((action) => action.kind === 'edit')
  const context: TraceLiveAnalysisContext = {
    spans: ordered,
    actions,
    tools,
    erroredTools,
    verificationActions,
    changeActions,
    session,
    generatedAt,
    newSpanCount: opts.newSpanCount ?? ordered.length,
  }
  const findings = liveAnalysts(opts).flatMap((analyst) => [...analyst.analyze(context)])

  return {
    schemaVersion: 1,
    kind: 'traces.live_batch',
    generatedAt,
    session,
    spanCount: ordered.length,
    newSpanCount: opts.newSpanCount ?? ordered.length,
    toolCallCount: tools.length,
    erroredToolCallCount: erroredTools.length,
    verificationCallCount: verificationActions.length,
    changeCallCount: changeActions.length,
    actionCounts: actionCounts(actions),
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
