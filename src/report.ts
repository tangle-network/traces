/**
 * The `traces analyze` text: at most 40 lines, answer first, in one fixed order.
 *
 *   1  header: who, where, when, active time, cost
 *   2  what was asked
 *   3  the first failure and its blame
 *   4  repeated or failing commands
 *   5  tool-error clusters
 *   6  stalls of 10 minutes or more no turn ended
 *   7  interrupts and rejections
 *   8  unverified completion claims
 *   9  pull requests
 *   10 findings, HIGH first, each with span ids
 *   11 how many questions the trace cannot answer, and where they are listed
 *
 * Several sessions put sections 2–9 in a table of the 15 with the most waste.
 * A section whose data is absent is left out; a fact that is unknown is one
 * of the questions section 11 counts, never a 0. Every number is the facts
 * sheet's (`session-facts.ts`) or the measure's that owns it.
 */

import type { AnalystFinding } from '@tangle-network/agent-eval/analyst'
import { ACTOR_ATTR } from './adapters/conversation.js'
import { isInheritedSpan } from './adapters/provenance.js'
import { ATTR, sessionIdFromAttributes } from './attributes.js'
import type { CannotAnswer, SessionToolErrors, TraceInvestigationResult, UnverifiedClaim } from './improvement.js'
import type { OtlpSpan } from './otlp.js'
import { describeSessionRelationship } from './session-relationship.js'
import {
  minutesText,
  renderFirstFailure,
  sheetText,
  topCounts,
  utcMinute,
  type SessionFacts,
  type SessionTurnFact,
} from './session-facts.js'
import type { SessionCorruptionReceipt, SessionRef } from './types.js'

const CORRUPTION_RECEIPT_DISPLAY_LIMIT = 100

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
 * The source row for one parsed session: subject line from the first human
 * prompt, parent/child relationship, and any corruption receipts.
 */
export function sessionReportSource(
  ref: SessionRef,
  spans: readonly OtlpSpan[],
  sessionIdOverride?: string,
): ReportSource {
  const root = spans.find((item) => item.parent_span_id === null) ?? spans[0]
  // The subject names what THIS scope was asked to do, so an inherited turn
  // (a fork's parent prompt, a compacted history) never supplies it.
  const inScope = spans.filter((item) => !isInheritedSpan(item.attributes))
  const prompt = inScope.find(
    (item) => item.name === 'user.prompt' && item.attributes[ACTOR_ATTR] === 'human',
  ) ?? inScope.find((item) => item.name === 'user.prompt') ?? inScope.find(
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

/** The most lines `traces analyze` prints for any selection. */
export const ANALYZE_TEXT_LINES = 40

/** Sessions the table of a several-session selection lists. */
const TABLE_SESSIONS = 15

const SEVERITY_LABEL: Readonly<Record<AnalystFinding['severity'], string>> = {
  critical: 'CRIT',
  high: 'HIGH',
  medium: 'MED',
  low: 'LOW',
  info: 'INFO',
}

function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`
}

const short = (id: string): string => id.slice(0, 8)

/** `48h 29m`, `42 min`, `18 s`: an elapsed time a person reads at a glance. */
export function elapsedText(ms: number): string {
  const minutes = ms / 60_000
  if (minutes < 60) return minutesText(minutes)
  const whole = Math.round(minutes)
  return `${Math.floor(whole / 60)}h ${whole % 60}m`
}

function costText(facts: SessionFacts): string {
  return facts.cost.usd === null
    ? `cost unknown: ${sheetText(facts.cost.unavailable ?? 'no reason recorded', 60)}`
    : `$${facts.cost.usd.toFixed(facts.cost.usd < 1 ? 4 : 2)} ${facts.cost.label}`
}

/** `10-14 10:00→10-16 10:29 UTC, 48h 29m`, or null when the session's times are unknown. */
function windowText(first: string | null, last: string | null): string | null {
  if (first === null || last === null) return null
  const [from, to] = [utcMinute(first), utcMinute(last)]
  const elapsed = Date.parse(last) - Date.parse(first)
  return `${from}→${from.slice(0, 5) === to.slice(0, 5) ? to.slice(6) : to} UTC${Number.isFinite(elapsed) && elapsed > 0 ? `, ${elapsedText(elapsed)}` : ''}`
}

function placeOf(facts: SessionFacts): string | undefined {
  const repo = facts.repo.value
  return repo
    ? `${repo.repository.split('/').at(-1)}${repo.branch ? ` (${repo.branch})` : ''}`
    : facts.cwd.value?.split('/').filter(Boolean).at(-1)
}

/** 1: `a263bb08 claude-code · agent-dev-container (main) · 10-14 10:00→10-16 10:29 UTC, 48h 29m · active 3.1 h · $519.00 list price (Router rates)`. */
function header(facts: SessionFacts): string {
  const parts = [`${short(facts.sessionId ?? facts.traceId)} ${facts.harness ?? 'unknown harness'}`]
  const place = placeOf(facts)
  if (place) parts.push(place)
  const window = windowText(facts.firstRecordAt.value, facts.lastRecordAt.value)
  if (window) parts.push(window)
  if (facts.measurements.activeMinutes.value !== null) parts.push(`active ${minutesText(facts.measurements.activeMinutes.value)}`)
  if (facts.parentSessionId) parts.push(`child of ${short(facts.parentSessionId)}`)
  parts.push(costText(facts))
  return parts.join(' · ')
}

/** 2: the first turn a person typed, and how many followed it. */
function askedLine(facts: SessionFacts): string | null {
  const turns = facts.humanTurns.value
  if (turns === null) return null
  const [first, ...rest] = turns
  if (!first) return null
  return `asked "${sheetText(first.text, 110)}"${rest.length > 0 ? ` (+${plural(rest.length, 'more human turn')})` : ''}`
}

/** 3: the first failure, when the spans name one. */
function firstFailureLine(facts: SessionFacts): string | null {
  const failure = facts.firstFailure
  return failure.status === 'found' || failure.status === 'ambiguous' ? `first failure ${renderFirstFailure(failure)}` : null
}

/** 4: failing streaks, then rework and rollbacks, from the facts sheet's waste measures. */
function commandLines(facts: SessionFacts): string[] {
  const waste = facts.measurements.waste
  const lines: string[] = []
  const streaks = [...(waste.failingStreaks.value ?? [])].sort((a, b) => b.minutes - a.minutes || b.runs - a.runs)
  if (streaks.length > 0) {
    const shown = streaks.slice(0, 2).map((streak) => {
      const command = streak.command === null ? `a ${streak.tool} command` : `\`${sheetText(streak.command, 60)}\``
      return `${command} ${streak.runs}× in a row (${minutesText(streak.minutes)}, ${utcMinute(streak.at).slice(6)}, span ${streak.spanIds[0]})`
    })
    lines.push(`failing commands ${streaks.length}: ${shown.join(' · ')}${streaks.length > 2 ? ` · +${streaks.length - 2} more` : ''}`)
  }
  const repeated = waste.repeatedCommands.value
  const rollbacks = waste.rollbacks.value ?? 0
  const rework: string[] = []
  if (repeated && repeated.commands > 0) rework.push(`${plural(repeated.commands, 'command')} rerun, ${plural(repeated.extraRuns, 'extra run')}`)
  if (rollbacks > 0) rework.push(`${plural(rollbacks, 'revert or reset --hard', 'reverts or resets --hard')}`)
  if (rework.length > 0) lines.push(`repeated ${rework.join(' · ')}`)
  return lines
}

/** 5: the session's own failed tool calls, clustered by tool and first line of error. */
function toolErrorLine(errors: SessionToolErrors | undefined): string | null {
  if (!errors || errors.errors === 0) return null
  const clusters = errors.clusters.slice(0, 3).map((cluster) => `${cluster.tool} ×${cluster.count} "${sheetText(cluster.error, 50)}" (span ${cluster.spanIds[0]})`)
  return `tool errors ${errors.errors}/${errors.calls}: ${clusters.join(' · ')}`
}

/** 6: stalls of 10 minutes or more that no turn ended, the longest first. */
function stallLine(facts: SessionFacts): string | null {
  const stalls = facts.measurements.waste.stalls.value ?? []
  if (stalls.length === 0) return null
  const total = stalls.reduce((sum, stall) => sum + stall.minutes, 0)
  const shown = [...stalls].sort((a, b) => b.minutes - a.minutes).slice(0, 2)
    .map((stall) => `${utcMinute(stall.at).slice(6)} ${stall.kind} ${minutesText(stall.minutes)} (span ${stall.spanId})`)
  return `stalls ${stalls.length} ≥ 10 min, ${minutesText(total)}: ${shown.join(' · ')}${stalls.length > 2 ? ` · +${stalls.length - 2} more` : ''}`
}

/** One quoted turn of section 7, with the claim it answered when it followed one. */
function signalQuote(turn: SessionTurnFact): string {
  const when = utcMinute(turn.at).slice(6)
  if (turn.signals.includes('interrupt')) return `  ${when} after an interrupt: "${sheetText(turn.text, 90)}"`
  if (turn.signals.includes('rejected-tool')) return `  ${when} after a rejected tool call: "${sheetText(turn.text, 90)}"`
  return `  ${when} "${sheetText(turn.text, 60)}" after the claim "${sheetText(turn.answered ?? '', 60)}"`
}

/**
 * 7: interrupts, rejected tool calls, and turns typed right after a completion
 * claim. Step 10 measured these against the lexical baseline on labelled
 * turns: a turn after a claim is a correction at about the base rate, so they
 * are reported as what they are, never as corrections.
 */
function interruptLines(facts: SessionFacts): string[] {
  const turns = facts.humanTurns.value ?? []
  const with_ = (signal: SessionTurnFact['signals'][number]): SessionTurnFact[] => turns.filter((turn) => turn.signals.includes(signal))
  const interrupts = with_('interrupt')
  const rejected = with_('rejected-tool')
  const afterClaim = with_('after-claim')
  if (interrupts.length + rejected.length + afterClaim.length === 0) return []
  const quoted = [...new Set([...interrupts, ...rejected, ...afterClaim])].slice(0, 3)
  return [
    `Interrupts and rejections: ${plural(interrupts.length, 'turn')} after an interrupt · ${plural(rejected.length, 'turn')} after a rejected tool call · ${plural(afterClaim.length, 'turn')} right after a completion claim`,
    ...quoted.map(signalQuote),
  ]
}

/** 8: completion claims after an edit with no check since, the latest first. */
function claimLine(claims: readonly UnverifiedClaim[]): string | null {
  if (claims.length === 0) return null
  const shown = claims.slice(-2).reverse().map((claim) => `${utcMinute(claim.at).slice(6)} "${sheetText(claim.text, 70)}" (span ${claim.spanId})`)
  return `unverified claims ${claims.length}: ${shown.join(' · ')}`
}

/** PR numbers as `#12 #13`, at most `keep` of them, then how many more. */
function prList(entries: readonly { readonly identifier: string | null }[], keep = 6): string {
  const ids = entries.map((entry) => entry.identifier === null ? 'unnumbered' : /^\d+$/u.test(entry.identifier) ? `#${entry.identifier}` : sheetText(entry.identifier, 30))
  return `${entries.length}${ids.length > 0 ? ` (${ids.slice(0, keep).join(' ')}${ids.length > keep ? ` +${ids.length - keep}` : ''})` : ''}`
}

/** 9: pull requests, when the session opened or merged any. */
function prLine(facts: SessionFacts): string | null {
  const prs = facts.pullRequests.value
  if (prs === null || prs.created.length + prs.merged.length === 0) return null
  const files = facts.changedFiles.value === null ? '' : ` · changed ${plural(facts.changedFiles.value.length, 'file')}`
  return `PRs opened ${prList(prs.created)} · merged ${prList(prs.merged)}${files}`
}

/** The span ids a finding cites: its span evidence, else the first and last span a metric names. */
function citedSpans(finding: AnalystFinding): string[] {
  const fromUris = finding.evidence_refs.flatMap((ref) => {
    const match = /\/span\/([^/]+)$/u.exec(ref.uri)
    return match ? [decodeURIComponent(match[1]!)] : []
  })
  if (fromUris.length > 0) return [...new Set(fromUris)]
  return finding.evidence_refs.flatMap((ref) => {
    if (!ref.excerpt?.startsWith('{')) return []
    try {
      const parsed = JSON.parse(ref.excerpt) as Record<string, unknown>
      return [parsed.first_span_id, parsed.last_span_id].filter((id): id is string => typeof id === 'string')
    } catch {
      return []
    }
  })
}

function findingLine(finding: AnalystFinding, sessions: number): string {
  const spans = citedSpans(finding)
  const session = sessions > 1 && typeof finding.metadata?.sessionId === 'string' ? `${short(finding.metadata.sessionId)} ` : ''
  const cite = spans.length > 0 ? ` (span${spans.length > 1 ? 's' : ''} ${spans.slice(0, 2).join(', ')}${spans.length > 2 ? ', …' : ''})` : ''
  return `  ${SEVERITY_LABEL[finding.severity].padEnd(4)} ${session}${finding.subject ?? finding.area}: ${sheetText(finding.claim, 110)}${cite}`
}

/** 10 and 11, fitted into the lines left. */
function closingLines(result: TraceInvestigationResult, used: number): string[] {
  const findings = result.packet.findings
  const lines: string[] = []
  if (findings.length > 0) {
    const counts = (['critical', 'high', 'medium', 'low', 'info'] as const)
      .map((severity) => [SEVERITY_LABEL[severity], findings.filter((finding) => finding.severity === severity).length] as const)
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${label} ${count}`)
    lines.push(`findings ${findings.length} (${counts.join(', ')})`)
    const room = ANALYZE_TEXT_LINES - used - lines.length - 1 - (result.cannotAnswer.length > 0 ? 1 : 0)
    const shown = findings.length > room ? Math.max(0, room - 1) : findings.length
    for (const finding of findings.slice(0, shown)) lines.push(findingLine(finding, result.facts.sessions.length))
    if (shown < findings.length) lines.push(`  … ${findings.length - shown} more: --format json | jq .packet.findings`)
  } else {
    lines.push('findings none')
  }
  if (result.cannotAnswer.length > 0) {
    lines.push(`cannot answer ${plural(result.cannotAnswer.length, 'question')}: --format json | jq .cannotAnswer, or report.md under --out DIR`)
  }
  return lines
}

function singleSession(result: TraceInvestigationResult, facts: SessionFacts): string[] {
  const sessionId = facts.sessionId ?? facts.traceId
  return [
    header(facts),
    askedLine(facts),
    firstFailureLine(facts),
    ...commandLines(facts),
    toolErrorLine(result.measures.toolErrors.find((entry) => entry.sessionId === sessionId)),
    stallLine(facts),
    ...interruptLines(facts),
    claimLine(result.measures.unverifiedClaims.filter((claim) => claim.sessionId === sessionId)),
    prLine(facts),
  ].filter((line): line is string => line !== null)
}

function sum(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0)
}

/** 1 for several sessions: counts per harness, the window, total cost, waste hours and interrupts. */
function fleetHeader(result: TraceInvestigationResult): string[] {
  const sessions = result.facts.sessions
  const byHarness: Record<string, number> = {}
  for (const facts of sessions) byHarness[facts.harness ?? 'unknown'] = (byHarness[facts.harness ?? 'unknown'] ?? 0) + 1
  const firsts = sessions.map((facts) => facts.firstRecordAt.value).filter((value): value is string => value !== null).sort()
  const lasts = sessions.map((facts) => facts.lastRecordAt.value).filter((value): value is string => value !== null).sort()
  const unpriced = sessions.filter((facts) => facts.cost.usd === null).length
  const priced = sum(sessions.map((facts) => facts.cost.usd))
  const cost = unpriced === sessions.length
    ? 'cost unknown'
    : `$${priced.toFixed(2)} list price (Router rates)${unpriced > 0 ? `, ${unpriced} unpriced` : ''}`
  const wasteKnown = sessions.filter((facts) => facts.measurements.waste.minutes !== null)
  const waste = wasteKnown.length === 0
    ? 'waste unknown'
    : `waste ${(sum(wasteKnown.map((facts) => facts.measurements.waste.minutes)) / 60).toFixed(1)} h${wasteKnown.length < sessions.length ? ` (${sessions.length - wasteKnown.length} unknown)` : ''}`
  const interrupts = sum(sessions.map((facts) => (facts.humanTurns.value ?? []).filter((turn) => turn.signals.includes('interrupt')).length))
  const window = windowText(firsts[0] ?? null, lasts.at(-1) ?? null)
  const lines = [[
    `${plural(sessions.length, 'session')} (${topCounts(byHarness, 4)})`,
    ...(window ? [window] : []),
    cost,
    waste,
    `${plural(interrupts, 'interrupt')}`,
  ].join(' · ')]
  const unread = result.facts.selection?.unreadSessions ?? []
  if (unread.length > 0) lines.push(`unreadable ${unread.length}: ${unread.slice(0, 2).map((entry) => `${short(entry.sessionId ?? entry.traceId ?? entry.source ?? '?')} ${sheetText(entry.reason, 50)}`).join(' · ')}`)
  return lines
}

function cell(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}

/** 2–9 for several sessions: one row each for the 15 with the most waste. */
function sessionTable(result: TraceInvestigationResult): string[] {
  const sessions = [...result.facts.sessions].sort((a, b) =>
    (b.measurements.waste.minutes ?? -1) - (a.measurements.waste.minutes ?? -1))
  const rows = sessions.slice(0, TABLE_SESSIONS).map((facts) => {
    const waste = facts.measurements.waste
    const turns = facts.humanTurns.value ?? []
    const prs = facts.pullRequests.value
    const signals = turns.filter((turn) => turn.signals.length > 0).length
    return [
      cell(short(facts.sessionId ?? facts.traceId), 8),
      cell(facts.harness ?? '?', 11),
      cell(placeOf(facts) ?? '?', 22),
      cell(facts.measurements.activeMinutes.value === null ? '?' : minutesText(facts.measurements.activeMinutes.value), 7),
      cell(facts.cost.usd === null ? '?' : `$${facts.cost.usd.toFixed(2)}`, 8),
      cell(waste.minutes === null ? '?' : minutesText(waste.minutes), 7),
      cell(String((waste.failingStreaks.value ?? []).length), 7),
      cell(String((waste.stalls.value ?? []).length), 6),
      cell(String(signals), 7),
      cell(prs === null ? '?' : `${prs.created.length}/${prs.merged.length}`, 5),
      sheetText(turns[0]?.text ?? '', 40),
    ].join(' ').trimEnd()
  })
  const head = ['session ', 'harness    ', 'repo                  ', 'active ', 'cost    ', 'waste  ', 'streaks', 'stalls', 'signals', 'PRs  ', 'asked'].join(' ')
  return [head, ...rows, ...(sessions.length > TABLE_SESSIONS ? [`… ${sessions.length - TABLE_SESSIONS} more sessions: --format json | jq .facts.sessions`] : [])]
}

/** The `traces analyze` text: at most {@link ANALYZE_TEXT_LINES} lines. */
export function renderAnalysis(result: TraceInvestigationResult): string {
  const sessions = result.facts.sessions
  const body = sessions.length === 1 ? singleSession(result, sessions[0]!) : [...fleetHeader(result), ...sessionTable(result)]
  const lines = [...body, ...closingLines(result, body.length)]
  return `${lines.slice(0, ANALYZE_TEXT_LINES).join('\n')}\n`
}

function cannotAnswerLine(entry: CannotAnswer): string {
  return `- **${entry.analysis}**${entry.sessionId ? ` (session \`${entry.sessionId}\`)` : ''}: ${entry.reason}`
}

/** `report.md` under `analyze --out DIR`: the text, every finding in full, and every question the trace cannot answer, with its reason. */
export function renderAnalysisReport(result: TraceInvestigationResult): string {
  return [
    '# traces analyze',
    '',
    '```text',
    renderAnalysis(result).trimEnd(),
    '```',
    '',
    '## Findings',
    ...result.packet.report.split('\n').filter((line) => !/^#{1,2} /u.test(line)),
    '',
    `## What these traces cannot answer (${result.cannotAnswer.length})`,
    '',
    ...(result.cannotAnswer.length > 0 ? result.cannotAnswer.map(cannotAnswerLine) : ['Nothing: every analysis had what it reads.']),
    '',
  ].join('\n')
}
