/**
 * Render analyst findings as a markdown report.
 *
 * Findings are grouped by area, ordered by severity. Each carries its
 * claim, the deterministic evidence excerpt, and the recommended action —
 * the actionable output for improving a stuck/looping agent.
 */

import type { AnalystFinding, AnalystRunResult } from '@tangle-network/agent-eval/analyst'
import type { AdoptionReport } from './adoption.js'
import type { PipelineReport } from './pipelines.js'
import type { ReactionReport } from './reactions.js'
import type { SessionCorruptionReceipt } from './types.js'

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
export const CORRUPTION_RECEIPT_DISPLAY_LIMIT = 100
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
  spanCount: number
  otlpPath: string
  deterministic?: DeterministicSummary
  sources?: readonly ReportSource[]
}

export interface ReportSource {
  sessionId: string
  path: string
  subject: string
  role: 'operator' | 'child' | 'unknown'
  parentSessionId?: string
  integrity?: 'complete' | 'degraded_not_lossless'
  corruptionCount?: number
  corruptionDigest?: string
  corruptions?: readonly SessionCorruptionReceipt[]
}

export interface DeterministicSummary {
  stuckLoops: number
  reactionSignals: number
  toolErrorRuns: number
  totalSignals: number
}

function deterministicSummaryText(summary: DeterministicSummary): string {
  const parts: string[] = []
  if (summary.stuckLoops > 0) parts.push(`${summary.stuckLoops} stuck loop(s)`)
  if (summary.reactionSignals > 0) parts.push(`${summary.reactionSignals} human reaction signal(s)`)
  if (summary.toolErrorRuns > 0) parts.push(`${summary.toolErrorRuns} tool-error run(s)`)
  if (parts.length === 0) return '0 deterministic signals'
  if (parts.length === 1) return parts[0]!
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm
}

function tableCell(value: string): string {
  return value.replace(/\s+/g, ' ').replaceAll('|', '\\|').trim()
}

export function summarizeDeterministicSignals(
  pipelines: PipelineReport,
  reactions: ReactionReport,
): DeterministicSummary {
  const stuckLoops = pipelines.stuckLoops.findings.length
  const reactionSignals = Object.values(reactions.signals).reduce((total, count) => total + count, 0)
  const toolErrorRuns = pipelines.toolUse.filter((run) => run.errorRate > 0).length
  return {
    stuckLoops,
    reactionSignals,
    toolErrorRuns,
    totalSignals: stuckLoops + reactionSignals + toolErrorRuns,
  }
}

export function renderReport(result: AnalystRunResult, meta: ReportMeta): string {
  const lines: string[] = []
  const findings = [...result.findings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
  )
  const deterministic = meta.deterministic ?? { stuckLoops: 0, reactionSignals: 0, toolErrorRuns: 0, totalSignals: 0 }
  const findingSummary =
    deterministic.totalSignals > 0
      ? `${findings.length} analyst ${plural(findings.length, 'finding')} + ` +
        `${deterministic.totalSignals} deterministic ${plural(deterministic.totalSignals, 'signal')}`
      : `${findings.length} ${plural(findings.length, 'finding')}`

  lines.push(`# Trace analysis — ${meta.harness}`)
  lines.push('')
  lines.push(
    `${meta.sessionCount} session(s), ${meta.spanCount} spans → **${findingSummary}** ` +
      `across ${result.per_analyst.length} analyst(s). Cost: $${result.total_cost_usd.toFixed(4)}.`,
  )
  lines.push('')

  if (meta.sources && meta.sources.length > 0) {
    lines.push('## Selected sessions')
    lines.push('')
    lines.push('| Role | Session ID | Parent session | Integrity | Subject (first prompt line) | Source path |')
    lines.push('|---|---|---|---|---|---|')
    for (const source of meta.sources) {
      const corruptionCount = source.corruptionCount ?? source.corruptions?.length ?? 0
      const integrity = source.integrity === 'degraded_not_lossless'
        ? `degraded, not lossless (${corruptionCount} corrupt ${plural(corruptionCount, 'record')})`
        : 'complete'
      lines.push(
        `| ${source.role} | \`${tableCell(source.sessionId)}\` | ` +
          `${source.parentSessionId ? `\`${tableCell(source.parentSessionId)}\`` : '—'} | ` +
          `${integrity} | ` +
          `${tableCell(source.subject) || '(no prompt captured)'} | \`${tableCell(source.path)}\` |`,
      )
    }
    lines.push('')
    const childCount = meta.sources.filter((source) => source.role === 'child').length
    if (childCount > 0) {
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
  lines.push('| Analyst | Status | Findings | Latency |')
  lines.push('|---|---|---|---|')
  for (const s of result.per_analyst) {
    lines.push(`| \`${s.analyst_id}\` | ${s.status} | ${s.findings_count} | ${s.latency_ms}ms |`)
  }
  lines.push('')

  if (findings.length === 0 && deterministic.totalSignals === 0) {
    lines.push('_No findings — no behavioral inefficiencies or failure modes detected._')
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
export function renderPipelines(pr: PipelineReport): string {
  const lines: string[] = ['## loops & waste (deterministic)', '']

  if (pr.stuckLoops.findings.length === 0) {
    lines.push('- **Stuck loops:** none (no tool called ≥3× with identical args in a short interval).')
  } else {
    lines.push(`- **Stuck loops:** ${pr.stuckLoops.findings.length} (${(pr.stuckLoops.affectedRunRatio * 100).toFixed(0)}% of runs affected)`)
    for (const f of pr.stuckLoops.findings.sort((a, b) => b.occurrences - a.occurrences).slice(0, 10)) {
      lines.push(`  - 🔁 \`${f.toolName}\` ×${f.occurrences} with identical args over ${(f.windowMs / 1000).toFixed(1)}s`)
    }
  }

  for (const m of pr.toolUse) {
    if (m.totalCalls === 0) continue
    const toolStats = Object.values(m.byTool)
    const duplicateCalls = toolStats.length > 0
      ? toolStats.reduce((total, stats) => total + stats.duplicates, 0)
      : Math.round(m.duplicateRate * m.totalCalls)
    const errorCalls = toolStats.length > 0
      ? toolStats.reduce((total, stats) => total + stats.errors, 0)
      : Math.round(m.errorRate * m.totalCalls)
    const retriedFailures = Math.round(m.retryRate * errorCalls)
    const failureFollowUp =
      errorCalls > 0
        ? `; ${(m.retryRate * 100).toFixed(0)}% of failed calls retried with the same tool (${retriedFailures}/${errorCalls})`
        : ''
    lines.push(
      `- **Tool use:** ${m.totalCalls} calls; ${duplicateCalls}/${m.totalCalls} repeated exactly; ` +
        `${errorCalls}/${m.totalCalls} failed${failureFollowUp}`,
    )
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
 * Render skill + subagent adoption. Explicit trace-level invocations and
 * loop-dispatched runs are reported SEPARATELY — the trace count alone
 * undercounts loop-dispatched skills by orders of magnitude.
 */
export function renderAdoption(ar: AdoptionReport): string {
  const lines: string[] = ['## skill & subagent adoption (deterministic)', '']
  lines.push(
    `- **Skill penetration:** ${(ar.skillPenetration * 100).toFixed(0)}% ` +
      `(${ar.sessionsWithSkill}/${ar.sessionCount} session(s) invoked a skill explicitly)`,
  )
  lines.push(
    `- **Explicit skill invocations:** ${ar.totalSkillInvocations} (Skill tool spans)  ·  ` +
      `**Loop-dispatched runs:** ${ar.totalLoopDispatchedRuns} ` +
      `(from ${ar.skillRunFilesRead} \`.evolve/skill-runs.jsonl\` file(s))`,
  )
  lines.push(
    `- **Subagent spawns:** ${ar.totalSubagentSpawns} across ${ar.sessionsWithSubagent} session(s)`,
  )
  lines.push('')

  const skillRows = Object.entries(ar.skillInvocations).sort((a, b) => b[1] - a[1])
  const loopRows = Object.entries(ar.loopDispatchedRuns).sort((a, b) => b[1] - a[1])
  if (skillRows.length > 0 || loopRows.length > 0) {
    lines.push('| Skill | Explicit invocations | Loop-dispatched runs |')
    lines.push('|---|---|---|')
    const names = [...new Set([...skillRows.map((r) => r[0]), ...loopRows.map((r) => r[0])])].sort(
      (a, b) => (ar.skillInvocations[b] ?? 0) + (ar.loopDispatchedRuns[b] ?? 0) - (ar.skillInvocations[a] ?? 0) - (ar.loopDispatchedRuns[a] ?? 0),
    )
    for (const n of names) {
      lines.push(`| \`${n}\` | ${ar.skillInvocations[n] ?? 0} | ${ar.loopDispatchedRuns[n] ?? 0} |`)
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
