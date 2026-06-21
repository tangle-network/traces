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

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
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
}

export function renderReport(result: AnalystRunResult, meta: ReportMeta): string {
  const lines: string[] = []
  const findings = [...result.findings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
  )

  lines.push(`# Trace analysis — ${meta.harness}`)
  lines.push('')
  lines.push(
    `${meta.sessionCount} session(s), ${meta.spanCount} spans → **${findings.length} findings** ` +
      `across ${result.per_analyst.length} analyst(s). Cost: $${result.total_cost_usd.toFixed(4)}.`,
  )
  lines.push('')

  // Analyst run summary.
  lines.push('| Analyst | Status | Findings | Latency |')
  lines.push('|---|---|---|---|')
  for (const s of result.per_analyst) {
    lines.push(`| \`${s.analyst_id}\` | ${s.status} | ${s.findings_count} | ${s.latency_ms}ms |`)
  }
  lines.push('')

  if (findings.length === 0) {
    lines.push('_No findings — no behavioral inefficiencies or failure modes detected._')
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
    lines.push('- **Stuck loops:** none (no tool called ≥3× with identical args).')
  } else {
    lines.push(`- **Stuck loops:** ${pr.stuckLoops.findings.length} (${(pr.stuckLoops.affectedRunRatio * 100).toFixed(0)}% of runs affected)`)
    for (const f of pr.stuckLoops.findings.sort((a, b) => b.occurrences - a.occurrences).slice(0, 10)) {
      lines.push(`  - 🔁 \`${f.toolName}\` ×${f.occurrences} with identical args over ${(f.windowMs / 1000).toFixed(1)}s`)
    }
  }

  for (const m of pr.toolUse) {
    if (m.totalCalls === 0) continue
    lines.push(
      `- **Tool use** (${m.totalCalls} calls): ${(m.duplicateRate * 100).toFixed(0)}% duplicate, ` +
        `${(m.retryRate * 100).toFixed(0)}% retry, ${(m.errorRate * 100).toFixed(0)}% error`,
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
