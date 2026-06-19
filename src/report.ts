/**
 * Render analyst findings as a markdown report.
 *
 * Findings are grouped by area, ordered by severity. Each carries its
 * claim, the deterministic evidence excerpt, and the recommended action —
 * the actionable output for improving a stuck/looping agent.
 */

import type { AnalystFinding, AnalystRunResult } from '@tangle-network/agent-eval/analyst'
import type { PipelineReport } from './pipelines.js'

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
  lines.push(`OTLP artifact: \`${meta.otlpPath}\` — also runnable with \`halo ${meta.otlpPath} -p "diagnose"\`.`)
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
