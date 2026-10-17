/**
 * `traces analyze`, for $0: what went wrong in the selected sessions, ranked,
 * and what their traces cannot answer.
 *
 * Every number comes from its one owner. The facts sheet (`session-facts.ts`)
 * owns the session's turns, tokens, cost, first failure, failing streaks and
 * stalls; `analyze` renders them and never counts them again. Findings come
 * from the rule set `watch` shares (`pipelines.ts`), agent-eval's
 * deterministic behavioral analyst (`analyze.ts`), and a run whose root span
 * failed. No model is called: `traces ask` is the one command that spends.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { TraceValidation } from '@tangle-network/agent-trace-contract'
import { type AnalystFinding, type AnalystRegistry, makeFinding } from '@tangle-network/agent-eval/analyst'
import { analyzeSpans } from './analyze.js'
import { conformanceOfSpans, skippedAnalyses } from './conformance.js'
import type { OtlpSpan } from './otlp.js'
import {
  ruleContext,
  runPipelines,
  runRules,
  type PipelineReport,
  type TraceLiveFinding,
} from './pipelines.js'
import {
  createSessionFactsReportBuilder,
  priceReport,
  type SessionFacts,
  type SessionFactsReport,
  type SessionFactsReportOptions,
  type UnreadSessionFact,
} from './session-facts.js'

export interface TraceInvestigationOptions {
  readonly spans: readonly OtlpSpan[]
  /** The harness or input kind the spans were read from, named in the header. */
  readonly harness: string
  /** Sessions the selection skipped because they could not be read: each is a question the trace cannot answer. */
  readonly unread?: readonly UnreadSessionFact[]
  /** Options of the facts sheet: the window, the agent identity lookup. */
  readonly facts?: Pick<SessionFactsReportOptions, 'window' | 'agentIdentity' | 'includeContent'>
  /** Your own analysts instead of agent-eval's built-in behavioral analyst (`analyzeSpans`). */
  readonly registry?: AnalystRegistry
  readonly minLoopOccurrences?: number
  readonly generatedAt?: string
  /**
   * Conformance of the SOURCE the spans were read from. Supply it when the
   * source was a foreign OTLP file, so the report grades what the producer
   * wrote; omitted, it is computed from the spans themselves.
   */
  readonly conformance?: TraceValidation
  readonly signal?: AbortSignal
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void
}

/** One question the selected traces cannot answer, and the trace's own reason. */
export interface CannotAnswer {
  readonly analysis: string
  readonly reason: string
  /** The session it applies to; absent when it applies to the whole selection. */
  readonly sessionId?: string
}

/** Failed tool calls of one tool that ended with the same first line of error. */
export interface ToolErrorCluster {
  readonly tool: string
  readonly error: string
  readonly count: number
  /** The first three. */
  readonly spanIds: readonly string[]
}

/** One session's own tool calls, the failed ones, and their clusters, largest first. */
export interface SessionToolErrors {
  readonly sessionId: string
  readonly calls: number
  readonly errors: number
  readonly clusters: readonly ToolErrorCluster[]
}

/** The deterministic measures beside the facts sheet: loops, failure clusters, tool use and errors, failure follow-ups. */
export interface AnalysisMeasures extends PipelineReport {
  readonly toolErrors: readonly SessionToolErrors[]
}

export interface TraceInvestigationResult {
  readonly schemaVersion: 1
  readonly kind: 'traces.analysis'
  readonly generatedAt: string
  readonly harness: string
  /** The facts sheet of every selected session, priced: the numbers `traces facts` prints. */
  readonly facts: SessionFactsReport
  /** The findings, ranked by severity, as the packet ADC's Intelligence API reads. */
  readonly packet: TraceFindingPacket
  readonly measures: AnalysisMeasures
  /** What these spans can and cannot answer, by capability. */
  readonly conformance: TraceValidation
  /** Every question the selection cannot answer, with the reason; the text report prints only their count. */
  readonly cannotAnswer: readonly CannotAnswer[]
}

export interface TraceFindingPacket {
  readonly schemaVersion: 1
  readonly kind: 'traces.finding_packet'
  readonly generatedAt: string
  readonly source: string
  readonly findings: readonly AnalystFinding[]
  readonly report: string
}

export interface BuildTraceFindingPacketOptions {
  readonly findings: readonly AnalystFinding[]
  readonly generatedAt?: string
  readonly source?: string
  readonly title?: string
}

/** The `trace://` URI that cites one span, the form agent-eval's evidence gate checks. */
export function spanEvidenceUri(traceId: string, spanId: string): string {
  return `trace://${encodeURIComponent(traceId)}/span/${encodeURIComponent(spanId)}`
}

const severityRank: Record<AnalystFinding['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

/** Findings, most severe first; ties by area, then claim. */
export function rankFindings(findings: readonly AnalystFinding[]): AnalystFinding[] {
  return [...findings].sort((a, b) =>
    severityRank[a.severity] - severityRank[b.severity] ||
    a.area.localeCompare(b.area) ||
    a.claim.localeCompare(b.claim))
}

function renderFindingPacket(packet: Omit<TraceFindingPacket, 'report'>, title = 'Trace finding packet'): string {
  const lines = [`# ${title}`, '']
  lines.push(`${packet.findings.length} evidence-backed finding(s) with actions and checks.`)
  lines.push('')
  if (packet.findings.length > 0) {
    lines.push('## findings')
    lines.push('')
    for (const finding of rankFindings(packet.findings)) {
      lines.push(`### ${finding.severity.toUpperCase()} — ${finding.claim}`)
      lines.push('')
      lines.push(`- **Area:** ${finding.area}`)
      lines.push(`- **Analyst:** ${finding.analyst_id}`)
      if (finding.recommended_action) lines.push(`- **Action:** ${finding.recommended_action}`)
      if (finding.validation_plan) lines.push(`- **Check:** ${finding.validation_plan}`)
      for (const ref of finding.evidence_refs.slice(0, 3)) {
        lines.push(`- **Evidence:** ${ref.kind} ${ref.uri}${ref.excerpt ? ` — \`${ref.excerpt.slice(0, 180)}\`` : ''}`)
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

export function buildTraceFindingPacket(opts: BuildTraceFindingPacketOptions): TraceFindingPacket {
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const packet: Omit<TraceFindingPacket, 'report'> = {
    schemaVersion: 1,
    kind: 'traces.finding_packet',
    generatedAt,
    source: opts.source ?? 'traces',
    findings: opts.findings,
  }
  return { ...packet, report: renderFindingPacket(packet, opts.title) }
}

/** Where each rule's findings belong. */
const RULE_AREA: Readonly<Record<string, string>> = {
  'same-failing-command': 'tool-use',
  'verification-without-change': 'verification',
  'high-tool-error-rate': 'tool-use',
}

/**
 * agent-eval finding kinds whose precision, labelled by hand on 10 real
 * sessions, fell below 0.8: each is shown one severity level lower (HIGH →
 * MED, MED → LOW). The table is in traces 1.0 step 13's PR. A rule of this
 * package carries its measured severity in its own definition (`pipelines.ts`).
 */
const DEMOTED: ReadonlySet<string> = new Set<string>(['no-self-verification'])

const LOWER: Readonly<Record<AnalystFinding['severity'], AnalystFinding['severity']>> = {
  critical: 'high',
  high: 'medium',
  medium: 'low',
  low: 'low',
  info: 'info',
}

function measuredSeverity(finding: AnalystFinding): AnalystFinding {
  return finding.subject !== undefined && DEMOTED.has(finding.subject)
    ? { ...finding, severity: LOWER[finding.severity] }
    : finding
}

/** A rule's finding in the packet's vocabulary, citing at most three spans by `trace://` URI. */
function ruleFinding(live: TraceLiveFinding, traceId: string): AnalystFinding {
  const spanIds = [...new Set(live.evidence.flatMap((item) => item.spanIds ?? []))]
  return makeFinding({
    analyst_id: 'traces-rules',
    area: RULE_AREA[live.ruleId] ?? 'tool-use',
    subject: live.ruleId,
    claim: live.claim,
    severity: live.severity,
    rationale: live.title,
    evidence_refs: [
      ...spanIds.slice(0, 3).map((spanId) => ({
        kind: 'span' as const,
        uri: spanEvidenceUri(traceId, spanId),
        excerpt: live.evidence.find((item) => item.spanIds?.includes(spanId))?.value.slice(0, 240) ?? live.title,
      })),
      ...live.evidence.filter((item) => item.kind === 'metric').map((item) => ({
        kind: 'metric' as const,
        uri: `metric://trace/${encodeURIComponent(traceId)}/rules/${live.ruleId}/${item.label}`,
        excerpt: item.value,
      })),
    ],
    recommended_action: live.action,
    validation_plan: live.check,
    confidence: 1,
    metadata: { source: 'traces.rules', ruleId: live.ruleId, sessionId: live.session.sessionId, traceId, spanIds },
    id_basis: `${traceId}:${live.fingerprint}`,
  })
}

/** A run whose root span ended in ERROR: the session itself failed, not one call inside it. */
function terminalFailureFinding(pipelines: PipelineReport, spans: readonly OtlpSpan[]): AnalystFinding | undefined {
  const failedRuns = pipelines.failureClusters.totalFailures
  if (failedRuns === 0) return undefined
  const top = pipelines.failureClusters.clusters[0]
  const root = spans.find((item) => item.parent_span_id === null && item.status.code === 'ERROR' && (!top?.exampleRunId || item.trace_id === top.exampleRunId))
  return makeFinding({
    analyst_id: 'traces-deterministic',
    area: 'reliability',
    subject: 'terminal-failure',
    claim: `${failedRuns}/${pipelines.failureClusters.totalRuns} session(s) ended in an error`,
    severity: 'high',
    rationale: 'A session whose root span failed did not finish its work.',
    evidence_refs: [
      ...(root
        ? [{ kind: 'span' as const, uri: spanEvidenceUri(root.trace_id, root.span_id), excerpt: `${root.name}: ${root.status.message ?? 'root span ended with ERROR'}`.slice(0, 240) }]
        : []),
      {
        kind: 'metric' as const,
        uri: `metric://pipelines/failure_cluster/${top?.failureClass ?? 'unknown'}`,
        excerpt: top ? `${top.runCount} session(s); example: ${top.exampleError ?? 'error details not captured'}` : `${failedRuns} failed session(s)`,
      },
    ],
    recommended_action: 'Read the error the session ended on and fix its cause before rerunning the task.',
    validation_plan: 'Rerun the task and require the session to end without an error.',
    confidence: 1,
    metadata: { source: 'agent-eval.failureClusterView', failedRuns, totalRuns: pipelines.failureClusters.totalRuns, topFailureClass: top?.failureClass },
  })
}

const ERROR_TEXT_CAP = 80
const CLUSTERS_KEPT = 5

/** The first line of what a failed call said: its status message, else its output. */
function errorLine(span: OtlpSpan): string {
  const output = span.attributes['output.value']
  const text = span.status.message ?? (typeof output === 'string' ? output : '')
  const line = text.split('\n').map((part) => part.replace(/\s+/gu, ' ').trim()).find((part) => part.length > 0) ?? 'no error text recorded'
  return line.length > ERROR_TEXT_CAP ? `${line.slice(0, ERROR_TEXT_CAP - 1)}…` : line
}

function toolErrorsOf(sessionId: string, tools: readonly OtlpSpan[], errored: readonly OtlpSpan[]): SessionToolErrors {
  const clusters = new Map<string, { tool: string; error: string; count: number; spanIds: string[] }>()
  for (const span of errored) {
    const tool = typeof span.attributes['tool.name'] === 'string' ? span.attributes['tool.name'] : span.name.replace(/^tool\./u, '')
    const error = errorLine(span)
    const key = `${tool}\0${error}`
    const cluster = clusters.get(key) ?? { tool, error, count: 0, spanIds: [] }
    cluster.count += 1
    if (cluster.spanIds.length < 3) cluster.spanIds.push(span.span_id)
    clusters.set(key, cluster)
  }
  return {
    sessionId,
    calls: tools.length,
    errors: errored.length,
    clusters: [...clusters.values()].sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)).slice(0, CLUSTERS_KEPT),
  }
}

/** The spans of each trace, in the order traces first appear. */
function byTrace(spans: readonly OtlpSpan[]): Map<string, OtlpSpan[]> {
  const groups = new Map<string, OtlpSpan[]>()
  for (const span of spans) {
    const group = groups.get(span.trace_id)
    if (group) group.push(span)
    else groups.set(span.trace_id, [span])
  }
  return groups
}

const FACT_FIELDS = ['cwd', 'repo', 'toolCalls', 'subagents', 'pullRequests', 'humanTurns', 'finalMessages', 'changedFiles', 'firstRecordAt', 'lastRecordAt'] as const

/** What each session's facts sheet could not state, from the null facts and their reasons. */
function factsCannotAnswer(facts: SessionFacts): CannotAnswer[] {
  const sessionId = facts.sessionId ?? facts.traceId
  const out: CannotAnswer[] = []
  for (const field of FACT_FIELDS) {
    const fact = facts[field]
    if (fact.value === null && fact.unavailable) out.push({ analysis: `facts.${field}`, reason: fact.unavailable, sessionId })
  }
  if (facts.tokens.input === null && facts.tokens.unavailable) out.push({ analysis: 'facts.tokens', reason: facts.tokens.unavailable, sessionId })
  else if (facts.cost.usd === null && facts.cost.unavailable) out.push({ analysis: 'facts.cost', reason: facts.cost.unavailable, sessionId })
  if (facts.firstFailure.status === 'unknown') out.push({ analysis: 'facts.firstFailure', reason: facts.firstFailure.reason, sessionId })
  const waste = facts.measurements.waste
  if (waste.minutes === null && waste.unavailable) out.push({ analysis: 'facts.measurements.waste', reason: waste.unavailable, sessionId })
  return out
}

/** Tool calls whose arguments were not kept: loops, repeats and failing streaks cannot compare them. */
function argumentsCannotAnswer(pipelines: PipelineReport): CannotAnswer[] {
  const calls = pipelines.toolUse.reduce((total, run) => total + run.totalCalls, 0)
  const captured = pipelines.toolUse.reduce((total, run) => total + run.callsWithCapturedArgs, 0)
  if (calls === 0 || captured === calls) return []
  return [{
    analysis: 'argument comparisons: repeated commands, loops, blind retries and failing streaks',
    reason: `${calls - captured}/${calls} tool call(s) kept no arguments, so whether two calls were the same cannot be compared`,
  }]
}

export async function runTraceInvestigation(opts: TraceInvestigationOptions): Promise<TraceInvestigationResult> {
  if (opts.spans.length === 0) throw new Error('runTraceInvestigation: no spans to analyze')
  opts.signal?.throwIfAborted()
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const builder = createSessionFactsReportBuilder({ ...opts.facts, harness: opts.harness, generatedAt })
  const groups = byTrace(opts.spans)
  for (const spans of groups.values()) builder.add(spans)
  for (const entry of opts.unread ?? []) builder.addUnread(entry)
  const facts = await priceReport(builder.build())
  opts.signal?.throwIfAborted()

  const pipelines = await runPipelines(opts.spans, { minLoopOccurrences: opts.minLoopOccurrences })
  opts.signal?.throwIfAborted()
  const findings: AnalystFinding[] = []
  const toolErrors: SessionToolErrors[] = []
  for (const sheet of facts.sessions) {
    const spans = groups.get(sheet.traceId)
    if (!spans) continue
    const sessionId = sheet.sessionId ?? sheet.traceId
    const context = ruleContext(spans, {
      session: { harness: sheet.harness ?? opts.harness, sessionId, cwd: sheet.cwd.value },
      generatedAt,
      facts: [sheet],
    })
    for (const live of runRules(context)) findings.push(ruleFinding(live, sheet.traceId))
    toolErrors.push(toolErrorsOf(sessionId, context.tools, context.erroredTools))
  }
  const terminal = terminalFailureFinding(pipelines, opts.spans)
  if (terminal) findings.push(terminal)
  const analysis = await analyzeSpans(opts.spans, {
    ...(opts.registry ? { registry: opts.registry } : {}),
    runId: `traces-analysis-${Date.parse(generatedAt) || Date.now()}`,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  })
  findings.push(...analysis.result.findings)
  for (const summary of analysis.result.per_analyst) {
    if (summary.status !== 'ok') opts.log?.(`[analyst] ${summary.status.toUpperCase()} ${summary.analyst_id}`, { error: summary.error?.message ?? summary.reason })
  }

  const conformance = opts.conformance ?? conformanceOfSpans(opts.spans)
  const cannotAnswer: CannotAnswer[] = [
    ...skippedAnalyses(conformance).map((skipped) => ({ analysis: `${skipped.capability}: ${skipped.analysis}`, reason: skipped.reason })),
    ...argumentsCannotAnswer(pipelines),
    ...analysis.result.per_analyst
      .filter((summary) => summary.status !== 'ok')
      .map((summary) => ({ analysis: `analyst ${summary.analyst_id}`, reason: summary.error?.message ?? summary.reason ?? summary.status })),
    ...(facts.selection?.unreadSessions ?? []).map((entry) => ({
      analysis: 'every question about this session',
      reason: entry.reason,
      sessionId: entry.sessionId ?? entry.traceId ?? entry.source ?? 'unknown',
    })),
    ...facts.sessions.flatMap(factsCannotAnswer),
  ]
  return {
    schemaVersion: 1,
    kind: 'traces.analysis',
    generatedAt,
    harness: opts.harness,
    facts,
    packet: buildTraceFindingPacket({
      findings: rankFindings(findings.map(measuredSeverity)),
      generatedAt,
      source: 'traces analyze',
      title: 'traces analyze findings',
    }),
    measures: { ...pipelines, toolErrors },
    conformance,
    cannotAnswer,
  }
}

export interface AnalysisArtifacts {
  readonly directory: string
  readonly report: string
  readonly findings: string
}

/** `analyze --out DIR`: `report.md` (with every cannot-answer reason) and `findings.json` (the packet), and nothing else. */
export async function writeAnalysisArtifacts(report: string, packet: TraceFindingPacket, outDir: string): Promise<AnalysisArtifacts> {
  const directory = resolve(outDir)
  await mkdir(directory, { recursive: true })
  const paths = { directory, report: join(directory, 'report.md'), findings: join(directory, 'findings.json') }
  await Promise.all([
    writeFile(paths.report, report, 'utf8'),
    writeFile(paths.findings, `${JSON.stringify(packet, null, 2)}\n`, 'utf8'),
  ])
  return paths
}
