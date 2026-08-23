/**
 * Render analyst findings as a markdown report.
 *
 * Findings are grouped by area, ordered by severity. Each carries its
 * claim, the deterministic evidence excerpt, and the recommended action —
 * the actionable output for improving a stuck/looping agent.
 */

import type { AnalystFinding, AnalystRunResult, AnalystRunSummary } from '@tangle-network/agent-eval/analyst'
import type {
  ExecutionReport,
  ScalarDistribution,
  TokenUsageInsight,
} from '@tangle-network/agent-eval/contract'
import type { AdoptionReport } from './adoption.js'
import { ACTOR_ATTR } from './adapters/conversation.js'
import { ATTR, sessionIdFromAttributes } from './attributes.js'
import { incompleteInputsNote, type UnavailableCapabilities } from './conformance.js'
import type { LoopConvergenceReport, SteeringChainReport } from './loop-analysis.js'
import type { OtlpSpan } from './otlp.js'
import type { PipelineReport } from './pipelines.js'
import type { ReactionReport } from './reactions.js'
import { describeSessionRelationship } from './session-relationship.js'
import type { SessionWorkflowIssue, SessionWorkflowSummary } from './session-workflow.js'
import type { SessionCorruptionReceipt, SessionRef } from './types.js'

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
export const CORRUPTION_RECEIPT_DISPLAY_LIMIT = 100
const SOURCE_DISPLAY_LIMIT = 20
const SEVERITY_BADGE: Record<string, string> = {
  critical: '🔴 CRITICAL',
  high: '🟠 HIGH',
  medium: '🟡 MEDIUM',
  low: '🔵 LOW',
  info: 'ℹ️  INFO',
}

export interface ReportMeta {
  harness: string
  sessionCount: number
  unassignedTraceCount?: number
  spanCount: number
  otlpPath: string
  execution: ExecutionReport
  deterministic?: DeterministicSummary
  sources?: readonly ReportSource[]
  workflow?: SessionWorkflowSummary
  /**
   * Rendered trace-conformance section (see `src/conformance.ts`). Printed
   * BEFORE the execution facts, because a reader who meets a 0-token table
   * first and its explanation last reads a measurement gap as a measurement.
   */
  conformance?: string
  /**
   * Capabilities the trace cannot support → the trace's own reason. Every
   * section computed from a missing field is marked AT THE TABLE with this;
   * a conformance section that only narrates, while the tables below print
   * confident totals, is worse than no conformance section at all.
   */
  unavailableCapabilities?: UnavailableCapabilities
}

export interface ReportSource {
  sessionId: string
  path: string
  subject: string
  role: 'operator' | 'child' | 'unknown'
  parentSessionId?: string
  childSessionIds?: readonly string[]
  depth?: number
  agentNickname?: string
  agentRole?: string
  agentPath?: string
  taskScope?: 'all' | 'latest' | 'turn' | 'fork-current'
  turnId?: string
  integrity?: 'complete' | 'degraded_not_lossless'
  corruptionCount?: number
  corruptionDigest?: string
  corruptions?: readonly SessionCorruptionReceipt[]
}

/**
 * Build the report-source header row for one parsed session: subject line from
 * the first human prompt, parent/child relationship, and any corruption
 * receipts. Every span-consuming surface (CLI report, bundle) derives its
 * source identity through here so the same session always reads the same.
 */
export function sessionReportSource(
  ref: SessionRef,
  spans: readonly OtlpSpan[],
  sessionIdOverride?: string,
): ReportSource {
  const root = spans.find((item) => item.parent_span_id === null) ?? spans[0]
  const prompt = spans.find(
    (item) => item.name === 'user.prompt' && item.attributes[ACTOR_ATTR] === 'human',
  ) ?? spans.find((item) => item.name === 'user.prompt') ?? spans.find(
    (item) => item.attributes['span.type'] === 'interaction' && typeof item.attributes.content === 'string',
  )
  const content = typeof prompt?.attributes.content === 'string' ? prompt.attributes.content : ''
  const firstLine = content.split(/\r?\n/, 1)[0]!.trim()
  const subject = firstLine.length > 240
    ? `${firstLine.slice(0, 240)}… [+${firstLine.length - 240} chars]`
    : firstLine
  const role = root?.attributes['traces.session.role']
  const parentSessionId = root?.attributes['traces.parent_session_id']
  const relationship = describeSessionRelationship(ref, spans)
  const corruptionDigest = root?.attributes[ATTR.CORRUPTION_DIGEST]
  const sessionId = [
    sessionIdOverride,
    root ? sessionIdFromAttributes(root.attributes) : undefined,
    root?.trace_id,
    ref.sessionId,
  ].find((value): value is string => typeof value === 'string' && value.length > 0)!
  return {
    sessionId,
    path: ref.path,
    subject,
    role: role === 'operator' || role === 'child' ? role : 'unknown',
    ...(typeof parentSessionId === 'string' ? { parentSessionId } : {}),
    childSessionIds: relationship.childSessionIds,
    ...(relationship.depth !== undefined ? { depth: relationship.depth } : {}),
    ...(relationship.agentNickname ? { agentNickname: relationship.agentNickname } : {}),
    ...(relationship.agentRole ? { agentRole: relationship.agentRole } : {}),
    ...(relationship.agentPath ? { agentPath: relationship.agentPath } : {}),
    ...(relationship.taskScope ? { taskScope: relationship.taskScope } : {}),
    ...(relationship.turnId ? { turnId: relationship.turnId } : {}),
    integrity: ref.integrity?.status ?? 'complete',
    ...(ref.integrity ? {
      corruptionCount: ref.integrity.corruptions.length,
      ...(typeof corruptionDigest === 'string' ? { corruptionDigest } : {}),
      corruptions: ref.integrity.corruptions.slice(0, CORRUPTION_RECEIPT_DISPLAY_LIMIT),
    } : {}),
  }
}

export interface DeterministicSummary {
  stuckLoops: number
  reactionSignals: number
  failedRuns: number
  totalSignals: number
}

function deterministicSummaryText(summary: DeterministicSummary): string {
  const parts: string[] = []
  if (summary.stuckLoops > 0) parts.push(`${summary.stuckLoops} stuck loop(s)`)
  if (summary.reactionSignals > 0) parts.push(`${summary.reactionSignals} human reaction signal(s)`)
  if (summary.failedRuns > 0) parts.push(`${summary.failedRuns} failed run(s)`)
  if (parts.length === 0) return '0 deterministic signals'
  if (parts.length === 1) return parts[0]!
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm
}

function workflowIssueText(issue: SessionWorkflowIssue): string {
  if (issue.kind === 'cycle') return `Cycle: ${issue.sessionIds.map((id) => `\`${tableCell(id)}\``).join(' -> ')}`
  if (issue.kind === 'unresolved-parent-task') {
    return `Could not resolve parent task for child \`${tableCell(issue.childSessionId)}\` ` +
      `in \`${tableCell(issue.parentSessionId)}\`: ${issue.reason}`
  }
  if (issue.kind === 'parent-conflict') {
    return `Parent conflict for \`${tableCell(issue.sessionId)}\`: declared ` +
      `${issue.declaredParentSessionId ? `\`${tableCell(issue.declaredParentSessionId)}\`` : 'none'}, ` +
      `referenced by ${issue.referencedParentSessionIds.length > 0
        ? issue.referencedParentSessionIds.map((id) => `\`${tableCell(id)}\``).join(', ')
        : 'none'}`
  }
  const paths = issue.kind === 'ambiguous-session'
    ? `; candidates: ${issue.paths.map((path) => `\`${tableCell(path)}\``).join(', ')}`
    : ''
  return `${issue.kind === 'missing-session' ? 'Missing' : 'Ambiguous'} session ` +
    `\`${tableCell(issue.sessionId)}\`, referenced as ${issue.relation} by ` +
    `\`${tableCell(issue.referencedBySessionId)}\`${paths}`
}

function tableCell(value: string): string {
  return value.replace(/\s+/g, ' ').replaceAll('|', '\\|').trim()
}

const ANALYST_DETAIL_MAX_CHARS = 240

/**
 * Failure-reason marker printed by newer (currently unreleased) agent-eval
 * bridges. The pinned agent-eval-rpc release never emits it, so the head+tail
 * condensation below is the supported path today — but skew failures come
 * precisely from mismatched newer bridges, which is when the marker appears.
 */
const BRIDGE_FAILURE_MARKER = 'DSPY-BRIDGE-FAILURE:'

/**
 * Condense an analyst engine error to one actionable line. The bridge's
 * `DSPY-BRIDGE-FAILURE:` reason wins when present; otherwise keep head AND
 * tail, because a Python traceback names its terminal exception at the end —
 * head-only truncation would cut exactly the part worth reading. Slicing is
 * code-point-safe so a boundary never splits a surrogate pair.
 */
export function condenseAnalystError(raw: string, maxChars: number): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  const marker = flat.indexOf(BRIDGE_FAILURE_MARKER)
  let text = flat
  if (marker >= 0) {
    const fromMarker = flat.slice(marker)
    const traceback = fromMarker.indexOf(' Traceback (most recent call last)')
    text = traceback > 0 ? fromMarker.slice(0, traceback) : fromMarker
  }
  const chars = [...text]
  if (chars.length <= maxChars) return text
  const headChars = Math.floor(maxChars * 0.4)
  return `${chars.slice(0, headChars).join('')} … ${chars.slice(chars.length - (maxChars - headChars)).join('')}`
}

/**
 * Why a failed/skipped analyst produced nothing, condensed to one table cell.
 * Failed engine runs die with the whole bridge stderr in the error message;
 * without this cell the report scores the analyst without saying why.
 */
export function analystRunDetail(summary: AnalystRunSummary): string {
  const raw = summary.status === 'failed' && summary.error
    ? [summary.error.class, summary.error.message].map((part) => part.trim()).filter(Boolean).join(': ')
    : summary.status === 'skipped' && summary.reason
      ? summary.reason
      : ''
  const cell = tableCell(condenseAnalystError(raw, ANALYST_DETAIL_MAX_CHARS))
  return cell === '' ? '—' : cell
}

function count(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

function decimal(value: number, digits = 1): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function measured(value: number | null, render: (captured: number) => string): string {
  return value === null ? 'not captured' : render(value)
}

function distributionRow(label: string, distribution: ScalarDistribution, unit = ''): string {
  if (distribution.n === 0) return `| ${label} | 0 | not captured | not captured | not captured | not captured | not captured |`
  const value = (number: number | null) => measured(number, (captured) => `${decimal(captured)}${unit}`)
  return `| ${label} | ${count(distribution.n)} | ${value(distribution.min)} | ${value(distribution.mean)} | ${value(distribution.p50)} | ${value(distribution.p95)} | ${value(distribution.max)} |`
}

function tokenRows(usage: TokenUsageInsight): string[] {
  const rows: Array<[string, number, ScalarDistribution]> = [
    ['Input', usage.totals.input, usage.input],
    ['Output', usage.totals.output, usage.output],
    ['Reasoning (output subset)', usage.totals.reasoning, usage.reasoning],
    ['Cache read', usage.totals.cached, usage.cached],
    ['Cache write', usage.totals.cacheWrite, usage.cacheWrite],
  ]
  return rows.map(([label, total, values]) =>
    `| ${label} | ${count(total)} | ${count(values.n)} | ${measured(values.mean, decimal)} | ${measured(values.p50, decimal)} | ${measured(values.p95, decimal)} | ${measured(values.max, count)} |`,
  )
}

function analysisCost(result: AnalystRunResult): string {
  const cost = `$${result.total_cost_usd.toFixed(4)}`
  if (result.total_cost_provenance?.kind === 'observed') return `Analysis cost: ${cost} observed.`
  if (result.total_cost_provenance?.kind === 'estimated') return `Analysis cost: ${cost} estimated.`
  return `Known analysis cost: ${cost}; additional cost was not captured.`
}

/** Push an incomplete-inputs marker for `capability`, if it is unavailable. */
function pushGate(lines: string[], unavailable: UnavailableCapabilities | undefined, capability: string): void {
  const note = incompleteInputsNote(unavailable, capability)
  if (note === '') return
  lines.push(note)
  lines.push('')
}

/**
 * Every capability a table's numbers depend on, marked before the table.
 *
 * A table gated on ONE of its inputs is a table that prints confident numbers
 * whenever the OTHER input is the missing one — which is how a report came to
 * say "latency-analysis unavailable" at the top and then print a mean-latency
 * column and a `279,042,860ms` round duration with no marker on either. Any
 * table carrying a duration lists `latency-analysis` here, not only the
 * capability that decides whether the table appears at all.
 */
function pushGates(
  lines: string[],
  unavailable: UnavailableCapabilities | undefined,
  capabilities: readonly string[],
): void {
  for (const capability of capabilities) pushGate(lines, unavailable, capability)
}

/**
 * A duration cell for a table whose latency inputs are incomplete. The number
 * is withheld rather than printed with a warning forty lines away: a millisecond
 * count computed from spans that failed their own timestamp check is not a
 * measurement of anything, and printing it invites exactly one reading.
 */
function latencyCell(
  unavailable: UnavailableCapabilities | undefined,
  render: () => string,
): string {
  return unavailable?.has('latency-analysis') === true ? 'not measurable' : render()
}

/**
 * A round-over-round verdict for a trace whose loop inputs are incomplete,
 * withheld for the same reason a duration is.
 *
 * `loop-convergence` unavailable is not a thinner answer, it is no answer. Its
 * commonest cause is every span declaring `agent.loop.iteration: 1`: there is
 * one round, and a trend computed across it compares a series to itself. A word
 * like `plateaued` in a Trend column is read as the finding, whatever marker
 * sits above the table — so the word does not get printed.
 */
function trendCell(
  unavailable: UnavailableCapabilities | undefined,
  render: () => string,
): string {
  return unavailable?.has('loop-convergence') === true ? 'not measurable' : render()
}

export function renderExecution(
  report: ExecutionReport,
  unavailable?: UnavailableCapabilities,
): string {
  const execution = report.execution
  const lines = ['## execution facts', '']
  lines.push(
    `- **Sessions:** ${count(execution.durationMs.n)}  |  ` +
      `**Model-call runs:** ${count(execution.modelCalls.runs)}  |  ` +
      `**Model-call events:** ${count(execution.modelCalls.events)}  |  ` +
      `**Sessions with execution errors:** ${count(execution.executionErrors.runs)}/${count(execution.executionErrors.reportingRuns)} ` +
      `(${measured(execution.executionErrors.fraction, (fraction) => `${decimal(fraction * 100, 2)}%`)})`,
  )
  lines.push(
    `- **Terminal outcomes:** ${count(execution.terminalOutcomes.succeeded)} succeeded  |  ` +
      `${count(execution.terminalOutcomes.failed)} failed  |  ` +
      `${count(execution.terminalOutcomes.cancelled)} cancelled  |  ` +
      `${count(execution.terminalOutcomes.incomplete)} incomplete  |  ` +
      `${count(execution.terminalOutcomes.unknown)} unknown`,
  )
  lines.push('- **Task quality:** not measured; these traces do not include comparable task outcome labels.')
  lines.push('')
  pushGate(lines, unavailable, 'latency-analysis')
  lines.push('| Time | Sessions measured | Min | Mean | p50 | p95 | Max |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|')
  lines.push(distributionRow('Recorded session interval', execution.durationMs, 'ms'))
  lines.push(distributionRow('Queue', execution.queueMs, 'ms'))
  lines.push('')
  lines.push('Recorded session interval is first-to-last trace time and can include idle time; it is not active agent runtime.')
  lines.push('')
  lines.push(`### Direct model usage${unavailable?.has('token-accounting') ? ' — inputs incomplete' : ''}`)
  lines.push('')
  pushGate(lines, unavailable, 'token-accounting')
  lines.push('| Token category | Total | Runs measured | Mean | p50 | p95 | Max |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|')
  lines.push(...tokenRows(execution.tokenUsage))
  lines.push('')
  lines.push('| Model | Runs |')
  lines.push('|---|---:|')
  for (const model of execution.models) {
    lines.push(`| \`${tableCell(model.model)}\` | ${count(model.runs)} |`)
  }
  lines.push('')
  lines.push(`### Cost coverage${unavailable?.has('cost-attribution') ? ' — inputs incomplete' : ''}`)
  lines.push('')
  pushGate(lines, unavailable, 'cost-attribution')
  lines.push('| Source | Runs | Total USD |')
  lines.push('|---|---:|---:|')
  lines.push(`| Observed | ${count(report.costProvenance.observed.n)} | $${report.costProvenance.observed.totalUsd.toFixed(6)} |`)
  lines.push(`| Estimated | ${count(report.costProvenance.estimated.n)} | $${report.costProvenance.estimated.totalUsd.toFixed(6)} |`)
  lines.push(`| Uncaptured | ${count(report.costProvenance.uncaptured.n)} | not available |`)
  lines.push('')
  lines.push(`Known cost coverage: ${decimal(report.costProvenance.knownFraction * 100, 2)}%.`)
  lines.push('')
  if (execution.aggregateUsage.runs > 0) {
    lines.push(`### Orchestration-reported usage${unavailable?.has('token-accounting') ? ' — inputs incomplete' : ''}`)
    lines.push('')
    pushGate(lines, unavailable, 'token-accounting')
    lines.push(
      `Kept separate from direct model usage because orchestration totals can overlap model-call telemetry. ` +
        `${count(execution.aggregateUsage.runs)} run(s) reported aggregate values.`,
    )
    lines.push('')
    lines.push('| Token category | Total | Runs measured | Mean | p50 | p95 | Max |')
    lines.push('|---|---:|---:|---:|---:|---:|---:|')
    lines.push(...tokenRows(execution.aggregateUsage.tokenUsage))
    lines.push('')
    lines.push(
      `Aggregate cost: $${execution.aggregateUsage.totalCostUsd.toFixed(6)} across ` +
        `${count(execution.aggregateUsage.costUsd.n)} reporting run(s).`,
    )
    lines.push('')
  }
  return lines.join('\n')
}

export function summarizeDeterministicSignals(
  pipelines: PipelineReport,
  reactions: ReactionReport,
): DeterministicSummary {
  const stuckLoops = pipelines.stuckLoops.findings.length
  const reactionSignals = Object.values(reactions.signals).reduce((total, count) => total + count, 0)
  const failedRuns = pipelines.failureClusters.totalFailures
  return {
    stuckLoops,
    reactionSignals,
    failedRuns,
    totalSignals: stuckLoops + reactionSignals + failedRuns,
  }
}

export function renderReport(result: AnalystRunResult, meta: ReportMeta): string {
  const lines: string[] = []
  const findings = [...result.findings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
  )
  const deterministic = meta.deterministic ?? { stuckLoops: 0, reactionSignals: 0, failedRuns: 0, totalSignals: 0 }
  const findingSummary =
    deterministic.totalSignals > 0
      ? `${findings.length} ${plural(findings.length, 'finding')}; ` +
        `${deterministic.totalSignals} raw deterministic ${plural(deterministic.totalSignals, 'signal')}`
      : `${findings.length} ${plural(findings.length, 'finding')}`

  lines.push(`# Trace analysis — ${meta.harness}`)
  lines.push('')
  const sessionSummary = meta.unassignedTraceCount
    ? `${meta.sessionCount} identified session(s) + ${meta.unassignedTraceCount} ${plural(meta.unassignedTraceCount, 'trace')} without a single stable session identity`
    : `${meta.sessionCount} session(s)`
  lines.push(
    `${sessionSummary}, ${meta.spanCount} spans → **${findingSummary}** ` +
      `across ${result.per_analyst.length} analyst(s). ${analysisCost(result)}`,
  )
  lines.push('')
  if (meta.unassignedTraceCount) {
    lines.push(
      `> ${meta.unassignedTraceCount} ${plural(meta.unassignedTraceCount, 'trace')} lacked a single stable session identity. ` +
        'Their spans were analyzed but were not relabeled as sessions.',
    )
    lines.push('')
  }

  if (meta.workflow) {
    lines.push(
      `> Session workflow: ${meta.workflow.seedSessionIds.length} seed ` +
        `${plural(meta.workflow.seedSessionIds.length, 'session')}, ${meta.sessionCount} resolved ` +
        `${plural(meta.sessionCount, 'session')}, ${meta.workflow.issues.length} relationship ` +
        `${plural(meta.workflow.issues.length, 'issue')}.`,
    )
    lines.push('')
    if (!meta.workflow.complete) {
      for (const issue of meta.workflow.issues) lines.push(`- ${workflowIssueText(issue)}`)
      lines.push('')
    }
  }

  if (meta.conformance) {
    lines.push(meta.conformance)
    lines.push('')
  }

  lines.push(renderExecution(meta.execution, meta.unavailableCapabilities))
  lines.push('')

  if (meta.sources && meta.sources.length > 0) {
    lines.push('## Selected sessions')
    lines.push('')
    lines.push('| Role | Depth | Agent | Turn | Session ID | Parent session | Children | Integrity | Subject (first prompt line) | Source path |')
    lines.push('|---|---:|---|---|---|---|---:|---|---|---|')
    for (const source of meta.sources.slice(0, SOURCE_DISPLAY_LIMIT)) {
      const corruptionCount = source.corruptionCount ?? source.corruptions?.length ?? 0
      const integrity = source.integrity === 'degraded_not_lossless'
        ? `degraded, not lossless (${corruptionCount} corrupt ${plural(corruptionCount, 'record')})`
        : 'complete'
      const agent = [source.agentNickname, source.agentRole, source.agentPath].filter(Boolean).join(' / ')
      const turn = [source.taskScope, source.turnId].filter(Boolean).join(': ')
      lines.push(
        `| ${source.role} | ${source.depth ?? '-'} | ${tableCell(agent) || '-'} | ${tableCell(turn) || '-'} | ` +
          `\`${tableCell(source.sessionId)}\` | ` +
          `${source.parentSessionId ? `\`${tableCell(source.parentSessionId)}\`` : '—'} | ` +
          `${source.childSessionIds?.length ?? 0} | ` +
          `${integrity} | ` +
          `${tableCell(source.subject) || '(no prompt captured)'} | \`${tableCell(source.path)}\` |`,
      )
    }
    if (meta.sources.length > SOURCE_DISPLAY_LIMIT) {
      lines.push(
        `| ... | - | - | - | ${meta.sources.length - SOURCE_DISPLAY_LIMIT} additional sessions omitted | - | - | - | - | - |`,
      )
    }
    lines.push('')
    const childCount = meta.sources.filter((source) => source.role === 'child').length
    if (childCount > 0 && !meta.workflow) {
      lines.push(
        `> Scope: ${childCount}/${meta.sources.length} selected session(s) are children. ` +
          'Counts below describe only the selected files, not their parent operator sessions.',
      )
      lines.push('')
    }

    const totalCorruptionCount = meta.sources.reduce(
      (total, source) => total + (source.corruptionCount ?? source.corruptions?.length ?? 0),
      0,
    )
    const corruptions: SessionCorruptionReceipt[] = []
    for (const source of meta.sources) {
      for (const receipt of source.corruptions ?? []) {
        if (corruptions.length === CORRUPTION_RECEIPT_DISPLAY_LIMIT) break
        corruptions.push(receipt)
      }
      if (corruptions.length === CORRUPTION_RECEIPT_DISPLAY_LIMIT) break
    }
    if (totalCorruptionCount > 0) {
      lines.push('## Source corruption receipts')
      lines.push('')
      lines.push(
        '> Degraded, not lossless: every valid JSONL record was analyzed. ' +
          'Malformed content is fingerprinted, not retained; exact bytes are retrievable only while ' +
          'the local source file still contains that byte range.',
      )
      lines.push('')
      for (const source of meta.sources) {
        const count = source.corruptionCount ?? source.corruptions?.length ?? 0
        if (count === 0) continue
        const digest = source.corruptionDigest ? `, digest \`${source.corruptionDigest}\`` : ''
        lines.push(`- Session \`${tableCell(source.sessionId)}\`: ${count} ${plural(count, 'receipt')}${digest}.`)
      }
      lines.push('')
      if (corruptions.length > 0) {
        lines.push('| Session ID | Source path | Line | Byte offset | Byte length | SHA-256 | Raw bytes |')
        lines.push('|---|---|---:|---:|---:|---|---|')
        for (const receipt of corruptions) {
          lines.push(
            `| \`${tableCell(receipt.sessionId)}\` | \`${tableCell(receipt.sourcePath)}\` | ` +
              `${receipt.lineNumber} | ${receipt.byteOffset} | ${receipt.byteLength} | ` +
              `\`${receipt.sha256}\` | local source only |`,
          )
        }
        lines.push('')
      }
      const omitted = totalCorruptionCount - corruptions.length
      if (omitted > 0) {
        lines.push(
          `_${omitted} additional ${plural(omitted, 'receipt')} omitted from this report; ` +
            'all receipts remain in `source.corruption.receipt` child spans._',
        )
        lines.push('')
      }
    }
  }

  // Analyst run summary.
  lines.push('| Analyst | Status | Findings | Latency | Detail |')
  lines.push('|---|---|---|---|---|')
  for (const s of result.per_analyst) {
    lines.push(`| \`${s.analyst_id}\` | ${s.status} | ${s.findings_count} | ${s.latency_ms}ms | ${analystRunDetail(s)} |`)
  }
  lines.push('')

  if (findings.length === 0 && deterministic.totalSignals === 0) {
    lines.push('_No supported behavioral findings in the captured fields._')
  } else if (findings.length === 0) {
    lines.push(
      `_No analyst findings. Deterministic checks found ${deterministicSummaryText(deterministic)}; see sections below._`,
    )
  } else {
    const byArea = new Map<string, AnalystFinding[]>()
    for (const f of findings) {
      const arr = byArea.get(f.area) ?? []
      arr.push(f)
      byArea.set(f.area, arr)
    }
    for (const [area, arr] of byArea) {
      lines.push(`## ${area} (${arr.length})`)
      lines.push('')
      for (const f of arr) {
        lines.push(`### ${SEVERITY_BADGE[f.severity] ?? f.severity} — ${f.claim}`)
        lines.push('')
        if (f.subject) lines.push(`- **Subject:** \`${f.subject}\``)
        lines.push(`- **Confidence:** ${f.confidence}`)
        if (f.recommended_action) lines.push(`- **Fix:** ${f.recommended_action}`)
        if (f.validation_plan) lines.push(`- **Check:** ${f.validation_plan}`)
        for (const ev of f.evidence_refs.slice(0, 3)) {
          const excerpt = ev.excerpt ? ` — \`${ev.excerpt.slice(0, 200)}\`` : ''
          lines.push(`- **Evidence:** ${ev.kind} ${ev.uri}${excerpt}`)
        }
        lines.push('')
      }
    }
  }

  lines.push('---')
  lines.push(`OTLP artifact: \`${meta.otlpPath}\` — run external engines with \`traces analyze --analyzer halo\`.`)
  lines.push('')
  return lines.join('\n')
}

/**
 * Render the deterministic loop/stall/waste pipelines (agent-eval's shipped
 * detectors). This is the "is the agent stuck" view.
 */
export function renderPipelines(pr: PipelineReport, unavailable?: UnavailableCapabilities): string {
  const lines: string[] = ['## reliability, loops & waste (deterministic)', '']
  // The tool table carries a mean-latency column, so it depends on BOTH.
  pushGates(lines, unavailable, ['tool-usage', 'latency-analysis'])

  lines.push(
    `- **Terminal failures:** ${pr.failureClusters.totalFailures}/${pr.failureClusters.totalRuns} run(s)`,
  )
  if (pr.failureClusters.clusters.length > 0) {
    lines.push('')
    lines.push('| Failure class | Runs | Tool | Example trace | Example error |')
    lines.push('|---|---:|---|---|---|')
    for (const cluster of pr.failureClusters.clusters.slice(0, 10)) {
      lines.push(
        `| ${tableCell(cluster.failureClass)} | ${cluster.runCount} | ` +
          `${cluster.toolName ? `\`${tableCell(cluster.toolName)}\`` : 'not captured'} | ` +
          `${cluster.exampleRunId ? `\`${tableCell(cluster.exampleRunId)}\`` : 'not captured'} | ` +
          `${tableCell(cluster.exampleError ?? 'not captured')} |`,
      )
    }
    lines.push('')
  }

  if (pr.stuckLoops.findings.length === 0) {
    lines.push('- **Stuck loops:** none (no tool called ≥3× with identical args in a short interval).')
  } else {
    lines.push(`- **Stuck loops:** ${pr.stuckLoops.findings.length} (${(pr.stuckLoops.affectedRunRatio * 100).toFixed(0)}% of runs affected)`)
    for (const f of pr.stuckLoops.findings.sort((a, b) => b.occurrences - a.occurrences).slice(0, 10)) {
      lines.push(`  - 🔁 \`${f.toolName}\` ×${f.occurrences} with identical args over ${(f.windowMs / 1000).toFixed(1)}s`)
    }
  }

  const runsWithTools = pr.toolUse.filter((metrics) => metrics.totalCalls > 0)
  if (runsWithTools.length > 0) {
    let totalCalls = 0
    let callsWithCapturedArgs = 0
    let duplicateCalls = 0
    let errorCalls = 0
    let followedFailures = 0
    const byTool = new Map<string, {
      calls: number
      captured: number
      duplicates: number
      errors: number
      latencyMs: number
    }>()
    for (const metrics of runsWithTools) {
      const toolStats = Object.values(metrics.byTool)
      const duplicates = toolStats.length > 0
        ? toolStats.reduce((total, stats) => total + stats.duplicates, 0)
        : Math.round(metrics.duplicateRate * metrics.totalCalls)
      const errors = toolStats.length > 0
        ? toolStats.reduce((total, stats) => total + stats.errors, 0)
        : Math.round(metrics.errorRate * metrics.totalCalls)
      totalCalls += metrics.totalCalls
      callsWithCapturedArgs += metrics.callsWithCapturedArgs
      duplicateCalls += duplicates
      errorCalls += errors
      followedFailures += Math.round(metrics.retryRate * errors)
      for (const [name, stats] of Object.entries(metrics.byTool)) {
        const aggregate = byTool.get(name) ?? {
          calls: 0,
          captured: 0,
          duplicates: 0,
          errors: 0,
          latencyMs: 0,
        }
        aggregate.calls += stats.calls
        aggregate.captured += stats.callsWithCapturedArgs
        aggregate.duplicates += stats.duplicates
        aggregate.errors += stats.errors
        aggregate.latencyMs += stats.avgLatencyMs * stats.calls
        byTool.set(name, aggregate)
      }
    }
    // Exact per-failure classification (from spans) outranks the derived
    // retryRate estimate; the derived clause remains for hand-built reports.
    const followUps = pr.failureFollowUps
    let failureFollowUp = ''
    if (followUps && followUps.failures > 0) {
      const split = [
        `${followUps.blind} blind (identical args)`,
        `${followUps.adapted} adapted (changed args)`,
      ]
      if (followUps.argsUnknown > 0) split.push(`${followUps.argsUnknown} not comparable`)
      const succeeded = followUps.followed > 0
        ? `; ${followUps.followUpSucceeded}/${followUps.followed} follow-ups succeeded`
        : ''
      failureFollowUp = `; ${followUps.followed}/${followUps.failures} failed calls followed by another same-tool call (${(
        (followUps.followed / followUps.failures) * 100
      ).toFixed(0)}%) — ${split.join(', ')}${succeeded}`
    } else if (errorCalls > 0) {
      failureFollowUp = `; ${followedFailures}/${errorCalls} failed calls followed by another same-tool call (${(
        (followedFailures / errorCalls) * 100
      ).toFixed(0)}%)`
    }
    const duplicateSummary = callsWithCapturedArgs > 0
      ? `${duplicateCalls}/${callsWithCapturedArgs} captured calls repeated exactly`
      : 'exact repeats unavailable'
    lines.push(
      `- **Tool use:** ${totalCalls} calls across ${runsWithTools.length}/${pr.toolUse.length} traces; ` +
        `${callsWithCapturedArgs}/${totalCalls} arguments captured; ${duplicateSummary}; ` +
        `${errorCalls}/${totalCalls} failed${failureFollowUp}`,
    )
    if (followUps && followUps.blind > 0) {
      const byTool = Object.entries(followUps.blindByTool)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([name, count]) => `\`${tableCell(name)}\` ×${count}`)
      lines.push(`  - 🔁 Blind retries (same args re-sent after a failure): ${byTool.join(', ')}`)
    }
    if (byTool.size > 0) {
      lines.push('')
      lines.push('| Tool | Calls | Args captured | Exact repeats | Errors | Mean latency |')
      lines.push('|---|---:|---:|---:|---:|---:|')
      for (const [name, stats] of [...byTool].sort(
        (left, right) => right[1].calls - left[1].calls || left[0].localeCompare(right[0]),
      )) {
        lines.push(
          `| \`${tableCell(name)}\` | ${stats.calls} | ${stats.captured}/${stats.calls} | ` +
            `${stats.duplicates}/${stats.captured} | ${stats.errors}/${stats.calls} | ` +
            `${latencyCell(unavailable, () => `${(stats.latencyMs / stats.calls).toFixed(1)}ms`)} |`,
        )
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}

const TREND_BADGE: Record<string, string> = {
  improved: '📈 improved',
  plateaued: '➖ plateaued',
  regressed: '📉 regressed',
  mixed: '🔀 mixed (peaked, then fell back)',
  unscored: '· unscored',
}

const LOOP_DISPLAY_LIMIT = 20
const EDGE_DISPLAY_LIMIT = 50

/**
 * Round-over-round convergence: the reason a loop trace exists. A flat event
 * list can say what happened and in what order; only `agent.loop.iteration`
 * plus a verdict can say whether round N+1 was BETTER than round N.
 */
export function renderLoopConvergence(
  report: LoopConvergenceReport,
  unavailable?: UnavailableCapabilities,
): string {
  const lines: string[] = ['## round-over-round convergence', '']
  // The per-round table carries a Duration column, so it depends on BOTH.
  pushGates(lines, unavailable, ['loop-convergence', 'latency-analysis'])
  if (report.loops.length === 0) {
    lines.push(
      `- No rounds recorded: ${report.iterationSpans} span(s) carry \`agent.loop.iteration\`. ` +
        'Without it a retry is indistinguishable from a first attempt, so improvement cannot be measured.',
    )
    lines.push('')
    return lines.join('\n')
  }

  const byTrend = new Map<string, number>()
  for (const loop of report.loops) byTrend.set(loop.trend, (byTrend.get(loop.trend) ?? 0) + 1)
  lines.push(
    `- **Loops:** ${report.loops.length} across ${report.iterationSpans} round span(s) — ` +
      trendCell(unavailable, () => [...byTrend].map(([trend, n]) => `${n} ${trend}`).join(', ')),
  )
  lines.push('')
  lines.push('| Loop | Trace | Rounds | Trend | Basis | Series |')
  lines.push('|---|---|---:|---|---|---|')
  for (const loop of report.loops.slice(0, LOOP_DISPLAY_LIMIT)) {
    lines.push(
      `| \`${tableCell(loop.loopId)}\` | \`${tableCell(loop.traceId)}\` | ${loop.iterations.length} | ` +
        `${trendCell(unavailable, () => TREND_BADGE[loop.trend] ?? loop.trend)} | ${loop.basis} | ` +
        // The series text ("score 0.4 → 0.9 across 3 graded round(s)") states the
        // same verdict in prose; withholding only the badge would leave it standing.
        `${trendCell(unavailable, () => tableCell(loop.detail))} |`,
    )
  }
  if (report.loops.length > LOOP_DISPLAY_LIMIT) {
    lines.push(`| ... | - | - | - | - | ${report.loops.length - LOOP_DISPLAY_LIMIT} more omitted |`)
  }
  lines.push('')

  for (const loop of report.loops.slice(0, LOOP_DISPLAY_LIMIT)) {
    lines.push(
      `### loop \`${tableCell(loop.loopId)}\` — ` +
        trendCell(unavailable, () => TREND_BADGE[loop.trend] ?? loop.trend),
    )
    lines.push('')
    lines.push('| Round | Span | Outcome | Score | Graded by | Duration |')
    lines.push('|---:|---|---|---:|---|---:|')
    for (const round of loop.iterations) {
      lines.push(
        `| ${round.iteration} | \`${tableCell(round.spanId)}\` | ${round.outcome ?? 'not captured'} | ` +
          `${round.score ?? 'not captured'} | ` +
          `${round.verdictSpanId ? `\`${tableCell(round.verdictSpanId)}\`` : 'not captured'} | ` +
          `${latencyCell(unavailable, () => (round.durationMs === null ? 'not captured' : `${count(round.durationMs)}ms`))} |`,
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * The steering chain. `parent_span_id` would claim round N+1 happened INSIDE
 * round N; the link says round N's verdict CAUSED it, which is the edge this
 * table follows — backwards from the caused work to the verdict that caused it.
 */
export function renderSteeringChain(
  report: SteeringChainReport,
  unavailable?: UnavailableCapabilities,
): string {
  const lines: string[] = ['## steering chain (which verdict caused which retry)', '']
  pushGate(lines, unavailable, 'steering-chain')
  if (report.links === 0) {
    lines.push(
      '- No causal links recorded. Containment was captured; causality was not, so the chain from a ' +
        'verdict to the round it steered cannot be followed.',
    )
    lines.push('')
    return lines.join('\n')
  }

  lines.push(
    `- **Links:** ${report.links} (${report.dangling} point at a span absent from this export) — ` +
      Object.entries(report.byKind)
        .sort((left, right) => right[1] - left[1])
        .map(([kind, n]) => `${n} \`${kind}\``)
        .join(', '),
  )
  lines.push('')
  lines.push('| Caused round | Caused span | Link | Caused by | Its outcome | Its score |')
  lines.push('|---|---|---|---|---|---:|')
  for (const edge of report.edges.slice(0, EDGE_DISPLAY_LIMIT)) {
    const cause = edge.resolved
      ? `\`${tableCell(edge.causeName ?? edge.causeSpanId)}\``
      : `\`${tableCell(edge.causeSpanId)}\` (absent from export)`
    lines.push(
      `| ${edge.effectIteration ?? '—'} | \`${tableCell(edge.effectName)}\` | \`${tableCell(edge.linkKind)}\` | ` +
        `${cause} | ${edge.causeOutcome ?? 'not captured'} | ${edge.causeScore ?? 'not captured'} |`,
    )
  }
  if (report.edges.length > EDGE_DISPLAY_LIMIT) {
    lines.push(`| ... | - | - | ${report.edges.length - EDGE_DISPLAY_LIMIT} more omitted | - | - |`)
  }
  lines.push('')
  return lines.join('\n')
}

const REACTION_BADGE: Record<string, string> = {
  correction: 'correction',
  frustration: 'frustration',
  jargon: 'jargon-complaint',
  structure: 'structure-complaint',
  praise: 'praise',
}

function ratioStr(r: number | null): string {
  if (r === null) return 'n/a (no reaction signals)'
  if (!Number.isFinite(r)) return '∞ (corrective with zero praise)'
  return `${r.toFixed(2)}:1`
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * Render the user-reaction analyst: how the real human reacted to the agent's
 * prose. Only `actor === 'human'` turns are counted (see actor tag) — agent-to-
 * agent and injected prompts are excluded.
 */
export function renderReactions(rr: ReactionReport): string {
  const lines: string[] = ['## user reactions (deterministic, human turns only)', '']
  const total = Object.values(rr.signals).reduce((a, b) => a + b, 0)
  if (rr.humanReactionTurns === 0) {
    lines.push('- No human turns followed an assistant turn (nothing to classify).')
    lines.push('')
    return lines.join('\n')
  }
  lines.push(
    `- **Reaction turns:** ${rr.humanReactionTurns} human turn(s) followed an assistant turn; ` +
      `${total} carried a reaction signal.`,
  )
  lines.push(`- **Corrective-to-positive ratio:** ${ratioStr(rr.correctiveToPositiveRatio)}`)
  lines.push('')
  lines.push('| Signal | Count |')
  lines.push('|---|---|')
  for (const [k, v] of Object.entries(rr.signals)) {
    if (v > 0) lines.push(`| ${REACTION_BADGE[k] ?? k} | ${v} |`)
  }
  lines.push('')
  if (rr.triggerPairs.length > 0) {
    lines.push('### top trigger pairs (assistant prose → human reaction)')
    lines.push('')
    for (const p of rr.triggerPairs) {
      lines.push(`- **[${p.reactions.map((r) => REACTION_BADGE[r] ?? r).join(', ')}]**`)
      lines.push(`  - assistant: \`${oneLine(p.assistant, 180)}\``)
      lines.push(`  - human: \`${oneLine(p.human, 180)}\``)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Render skill + subagent adoption without treating a catalog, a document read,
 * or unlinked repository history as an invocation.
 */
export function renderAdoption(ar: AdoptionReport): string {
  const lines: string[] = ['## skill & subagent adoption (deterministic)', '']
  const scopeParts = [`${ar.identifiedSessionCount} identified session(s)`]
  if (ar.unassignedTraceCount > 0) {
    scopeParts.push(`${ar.unassignedTraceCount} trace(s) without a single stable session identity`)
  }
  lines.push(`- **Scope:** ${scopeParts.join(' + ')}`)
  if (ar.sessionIdentityConflicts.length > 0) {
    const displayed = ar.sessionIdentityConflicts.slice(0, SOURCE_DISPLAY_LIMIT)
    const details = displayed
      .map((conflict) => `\`${conflict.traceId}\` (${conflict.sessionIds.map((id) => `\`${id}\``).join(', ')})`)
      .join('; ')
    const omitted = ar.sessionIdentityConflicts.length - displayed.length
    lines.push(
      `- **Conflicting session identity:** ${ar.sessionIdentityConflicts.length} trace(s): ${details}` +
        `${omitted > 0 ? `; ${omitted} more omitted from this report` : ''}`,
    )
  }
  lines.push(
    '- **Prompt, tools, MCP, hooks, and full agent profile:** not assessed; no baseline profile was supplied.',
  )
  if (ar.skillPenetration === null) {
    const label = ar.skillTelemetryStatus === 'unsupported' ? 'uncaptured/unsupported' : 'uncaptured/unknown'
    lines.push(
      `- **Explicit skill invocation rate:** ${label} ` +
        `(${ar.skillTelemetrySessions}/${ar.executionGroupCount} observed group(s) expose a dedicated Skill event)`,
    )
  } else {
    const excluded = ar.executionGroupCount - ar.skillTelemetrySessions
    lines.push(
      `- **Explicit skill invocation rate:** ${(ar.skillPenetration * 100).toFixed(0)}% ` +
        `(${ar.sessionsWithSkill}/${ar.skillTelemetrySessions} measurable group(s)` +
        `${excluded > 0 ? `; ${excluded} unmeasurable group(s) excluded` : ''})`,
    )
  }
  lines.push(
    `- **Materialized skill catalogs/instructions:** ${ar.sessionsWithMaterializedSkills}/${ar.executionGroupCount} observed group(s)  ·  ` +
      `**Sessions with successful skill-document reads:** ${ar.sessionsWithSkillFileReference}/${ar.executionGroupCount}`,
  )
  lines.push(
    `- **Explicit skill invocations:** ${ar.totalSkillInvocations} (Skill tool spans)  ·  ` +
      `**Session-linked loop runs:** ${ar.totalLoopDispatchedRuns}`,
  )
  if (ar.totalUnlinkedLoopDispatchedRuns > 0) {
    lines.push(
      `- **Unlinked repository history:** ${ar.totalUnlinkedLoopDispatchedRuns} run(s) from ` +
        `${ar.skillRunFilesRead} current or legacy \`skill-runs.jsonl\` file(s); unassigned to these sessions.`,
    )
  }
  if (ar.totalSkillDocumentReads > 0) {
    lines.push(`- **Successful skill-document reads:** ${ar.totalSkillDocumentReads}; inspection is not outcome evidence.`)
  }
  lines.push(
    `- **Subagent spawns observed:** ${ar.totalSubagentSpawns} across ${ar.sessionsWithSubagent} observed group(s); ` +
      'capture completeness depends on source telemetry.',
  )
  lines.push('')

  const skillRows = Object.entries(ar.skillInvocations).sort((a, b) => b[1] - a[1])
  const documentRows = Object.entries(ar.skillDocumentReads).sort((a, b) => b[1] - a[1])
  const loopRows = Object.entries(ar.loopDispatchedRuns).sort((a, b) => b[1] - a[1])
  if (skillRows.length > 0 || documentRows.length > 0 || loopRows.length > 0) {
    lines.push('| Skill | Explicit invocations | Documents read | Session-linked loop runs |')
    lines.push('|---|---|---|---|')
    const names = [...new Set([
      ...skillRows.map((r) => r[0]),
      ...documentRows.map((r) => r[0]),
      ...loopRows.map((r) => r[0]),
    ])].sort(
      (a, b) =>
        (ar.skillInvocations[b] ?? 0) + (ar.skillDocumentReads[b] ?? 0) + (ar.loopDispatchedRuns[b] ?? 0) -
        (ar.skillInvocations[a] ?? 0) - (ar.skillDocumentReads[a] ?? 0) - (ar.loopDispatchedRuns[a] ?? 0),
    )
    for (const n of names) {
      lines.push(`| \`${n}\` | ${ar.skillInvocations[n] ?? 0} | ${ar.skillDocumentReads[n] ?? 0} | ${ar.loopDispatchedRuns[n] ?? 0} |`)
    }
    lines.push('')
  }

  const agentRows = Object.entries(ar.subagentSpawns).sort((a, b) => b[1] - a[1])
  if (agentRows.length > 0) {
    lines.push('| Subagent | Spawns |')
    lines.push('|---|---|')
    for (const [n, c] of agentRows) lines.push(`| \`${n}\` | ${c} |`)
    lines.push('')
  }
  return lines.join('\n')
}
