import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { TraceIndexedFile, TraceSessionIndex, TraceSessionIndexRow } from './session-index.js'

export type TraceInspectionSeverity = 'high' | 'medium' | 'low'
export type TraceInspectionArea = 'index' | 'session' | 'repo' | 'context'

export interface TraceInspectionFinding {
  readonly id: string
  readonly severity: TraceInspectionSeverity
  readonly area: TraceInspectionArea
  readonly title: string
  readonly impact: number
  readonly evidence: readonly string[]
  readonly next: string
  readonly refs?: readonly string[]
}

export interface TraceInspectionReport {
  readonly schemaVersion: 1
  readonly kind: 'traces.inspection_report'
  readonly generatedAt: string
  readonly source: {
    readonly indexGeneratedAt?: string
    readonly sessions: number
    readonly contextFiles: number
  }
  readonly totals: {
    readonly findings: number
    readonly high: number
    readonly medium: number
    readonly low: number
  }
  readonly findings: readonly TraceInspectionFinding[]
}

export interface InspectSessionIndexOptions {
  readonly generatedAt?: string
  readonly maxFindings?: number
}

interface MutableFinding {
  id: string
  severity: TraceInspectionSeverity
  area: TraceInspectionArea
  title: string
  impact: number
  evidence: string[]
  next: string
  refs?: string[]
}

const severityRank: Record<TraceInspectionSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
}

function allContextFiles(index: TraceSessionIndex): TraceIndexedFile[] {
  return index.context?.roots.flatMap((root) => root.files) ?? []
}

function repoLabel(row: TraceSessionIndexRow): string {
  return row.repo.subjectKey ?? row.repo.repository ?? row.repo.cwd ?? row.session.cwd ?? '(repo unknown)'
}

function sessionLabel(row: TraceSessionIndexRow): string {
  const id = row.session.sessionId.length > 12 ? row.session.sessionId.slice(0, 12) : row.session.sessionId
  return `${row.session.harness}:${id} (${repoLabel(row)})`
}

function pct(value: number): string {
  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`
}

function topToolErrors(row: TraceSessionIndexRow): string {
  const tools = row.tools
    .filter((tool) => tool.errors > 0)
    .sort((a, b) => b.errors - a.errors || b.calls - a.calls || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((tool) => `${tool.name} ${tool.errors}/${tool.calls}`)
  return tools.length > 0 ? tools.join(', ') : 'no tool-level error breakdown'
}

function topLoopTools(row: TraceSessionIndexRow): string {
  const byTool = new Map<string, { groups: number; maxOccurrences: number }>()
  for (const loop of row.signals.stuckLoops) {
    const current = byTool.get(loop.toolName) ?? { groups: 0, maxOccurrences: 0 }
    current.groups += 1
    current.maxOccurrences = Math.max(current.maxOccurrences, loop.occurrences)
    byTool.set(loop.toolName, current)
  }
  const loops = [...byTool.entries()]
    .sort(([, a], [, b]) => b.groups - a.groups || b.maxOccurrences - a.maxOccurrences)
    .slice(0, 3)
    .map(([toolName, stats]) => `${toolName} ${stats.groups} group(s), max x${stats.maxOccurrences}`)
  const suffix = row.signals.stuckLoopsOmitted > 0 ? `, +${row.signals.stuckLoopsOmitted} omitted` : ''
  return loops.length > 0 ? `${loops.join(', ')}${suffix}` : `${row.signals.stuckLoopCount} loop(s)`
}

function sortFindings(findings: MutableFinding[]): TraceInspectionFinding[] {
  return findings
    .sort((a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      b.impact - a.impact ||
      a.id.localeCompare(b.id))
    .map((finding) => ({ ...finding }))
}

function contextSourceCounts(index: TraceSessionIndex): { contextFiles: number } {
  return { contextFiles: allContextFiles(index).length }
}

function addSessionFindings(index: TraceSessionIndex, findings: MutableFinding[]): void {
  const sessions = index.sessions
  if (index.totals.sessions === 0) {
    findings.push({
      id: 'index.no-sessions',
      severity: 'high',
      area: 'index',
      title: 'No sessions were indexed',
      impact: 100,
      evidence: ['The index contains 0 session rows.'],
      next: 'Run `traces list` for the target harness, then rerun `traces index` with the right --harness, --cwd, --since, or --last.',
    })
    return
  }

  const missingRepo = sessions.filter((row) =>
    !row.repo.subjectKey &&
    !row.repo.repository &&
    !row.repo.cwd &&
    !row.session.cwd)
  if (missingRepo.length > 0) {
    findings.push({
      id: 'repo.missing-attribution',
      severity: missingRepo.length / index.totals.sessions >= 0.25 ? 'high' : 'medium',
      area: 'repo',
      title: `${missingRepo.length}/${index.totals.sessions} session(s) have no repo or cwd`,
      impact: missingRepo.length,
      evidence: missingRepo.slice(0, 5).map((row) => `${row.session.harness}:${row.session.sessionId} at ${row.session.path}`),
      next: 'Improve adapter cwd recovery or pass --cwd for explicit session files so findings can be grouped by repo.',
      refs: missingRepo.slice(0, 5).map((row) => row.session.path),
    })
  }

  const loopSessions = sessions
    .filter((row) => row.signals.stuckLoopCount > 0)
    .sort((a, b) => b.signals.stuckLoopCount - a.signals.stuckLoopCount)
  if (loopSessions.length > 0) {
    const stuckLoops = loopSessions.reduce((sum, row) => sum + row.signals.stuckLoopCount, 0)
    findings.push({
      id: 'session.repeated-call-loops',
      severity: stuckLoops >= 10 || loopSessions.length / index.totals.sessions >= 0.3 ? 'high' : 'medium',
      area: 'session',
      title: `Repeated tool-call loops in ${loopSessions.length}/${index.totals.sessions} session(s)`,
      impact: stuckLoops,
      evidence: [
        `${stuckLoops} repeated-call loop(s) across ${loopSessions.length} session(s).`,
        ...loopSessions.slice(0, 5).map((row) => `${sessionLabel(row)}: ${row.signals.stuckLoopCount} loop(s); ${topLoopTools(row)}`),
      ],
      next: 'Inspect the repeated commands and results in the referenced sessions; fix the instruction or tool path that lets the same failed action repeat.',
      refs: loopSessions.slice(0, 5).map((row) => row.session.path),
    })
  }

  const errorSessions = sessions
    .filter((row) => row.metrics.erroredToolCallCount >= 10 || row.metrics.toolErrorRate >= 0.1)
    .sort((a, b) =>
      b.metrics.erroredToolCallCount - a.metrics.erroredToolCallCount ||
      b.metrics.toolErrorRate - a.metrics.toolErrorRate)
  if (errorSessions.length > 0) {
    const errors = errorSessions.reduce((sum, row) => sum + row.metrics.erroredToolCallCount, 0)
    const worstRate = Math.max(...errorSessions.map((row) => row.metrics.toolErrorRate))
    findings.push({
      id: 'session.tool-errors',
      severity: errors >= 50 || worstRate >= 0.3 ? 'high' : 'medium',
      area: 'session',
      title: `High tool-error count/rate in ${errorSessions.length}/${index.totals.sessions} session(s)`,
      impact: errors,
      evidence: errorSessions.slice(0, 5).map((row) =>
        `${sessionLabel(row)}: ${row.metrics.erroredToolCallCount}/${row.metrics.toolCallCount} tool errors (${pct(row.metrics.toolErrorRate)}); ${topToolErrors(row)}`),
      next: 'Fix the most common failing command/tool first, then rerun `traces index` to confirm the error count drops.',
      refs: errorSessions.slice(0, 5).map((row) => row.session.path),
    })
  }

  const largeSessions = sessions
    .map((row) => ({ row, tokens: row.metrics.inputTokens + row.metrics.outputTokens }))
    .filter(({ tokens }) => tokens >= 500_000)
    .sort((a, b) => b.tokens - a.tokens)
  if (largeSessions.length > 0) {
    const largest = largeSessions[0]?.tokens ?? 0
    findings.push({
      id: 'session.large-token-runs',
      severity: largest >= 1_000_000 ? 'medium' : 'low',
      area: 'session',
      title: `${largeSessions.length} session(s) reported at least 500k summed tokens`,
      impact: largest,
      evidence: largeSessions.slice(0, 5).map(({ row, tokens }) =>
        `${sessionLabel(row)}: ${tokens.toLocaleString()} reported summed tokens (${row.metrics.inputTokens.toLocaleString()} in, ${row.metrics.outputTokens.toLocaleString()} out)`),
      next: 'Check whether these sessions need shorter handoffs, smaller files, split tasks, or clearer token accounting before optimizing anything else.',
      refs: largeSessions.slice(0, 5).map(({ row }) => row.session.path),
    })
  }
}

function addContextFindings(index: TraceSessionIndex, findings: MutableFinding[]): void {
  const files = allContextFiles(index)
  if (index.totals.sessions > 0 && files.length === 0) {
    findings.push({
      id: 'context.none-indexed',
      severity: 'medium',
      area: 'context',
      title: 'No nearby repo instructions or .evolve files were indexed',
      impact: index.totals.sessions,
      evidence: ['The index has session rows but 0 context files.'],
      next: 'Add AGENTS.md or CLAUDE.md near active repos, or ensure session cwd points at the repo so traces can join sessions to local process docs.',
    })
    return
  }

  const hasContextRoots = (index.context?.totals.roots ?? 0) > 0
  if (hasContextRoots && (index.context?.totals.instructionDocs ?? 0) === 0) {
    findings.push({
      id: 'context.no-instruction-docs',
      severity: 'medium',
      area: 'context',
      title: 'Context roots exist but no AGENTS.md, CLAUDE.md, or GEMINI.md files were found',
      impact: index.context?.totals.roots ?? 0,
      evidence: index.context?.roots.slice(0, 5).map((root) => root.root) ?? [],
      next: 'Add a short repo-level instruction file that links to stable process docs and anti-patterns.',
    })
  }

  const longInstructionDocs = files
    .filter((file) => file.kind === 'instruction-doc' && (file.lines ?? 0) >= 100 && file.markdown?.hasToc === false)
    .sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0))
  if (longInstructionDocs.length > 0) {
    const longest = longInstructionDocs[0]?.lines ?? 0
    findings.push({
      id: 'context.long-docs-without-toc',
      severity: longest >= 200 ? 'medium' : 'low',
      area: 'context',
      title: `${longInstructionDocs.length} long instruction doc(s) are missing a Contents section`,
      impact: longest,
      evidence: longInstructionDocs.slice(0, 5).map((file) =>
        `${file.path}: ${file.lines ?? 0} lines, ${file.markdown?.headings ?? 0} heading(s), no Contents section`),
      next: 'Add a compact Contents section or split stable rules into linked docs/processes and docs/anti-patterns files.',
      refs: longInstructionDocs.slice(0, 5).map((file) => file.path),
    })
  }

  const longNarrativeDocs = files
    .filter((file) =>
      (file.kind === 'reflection' || file.kind === 'handoff') &&
      (file.lines ?? 0) >= 40 &&
      file.markdown?.hasToc === false)
    .sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0))
  if (longNarrativeDocs.length > 0) {
    const longest = longNarrativeDocs[0]?.lines ?? 0
    findings.push({
      id: 'context.long-narrative-docs-without-toc',
      severity: longest >= 120 ? 'medium' : 'low',
      area: 'context',
      title: `${longNarrativeDocs.length} long reflection/handoff doc(s) are hard to scan`,
      impact: longest,
      evidence: longNarrativeDocs.slice(0, 5).map((file) =>
        `${file.path}: ${file.lines ?? 0} lines, ${file.markdown?.headings ?? 0} heading(s), no Contents section`),
      next: 'Put the decision, evidence, and next action at the top; add Contents only when the note is long enough to revisit.',
      refs: longNarrativeDocs.slice(0, 5).map((file) => file.path),
    })
  }

  const invalidJsonlFiles = files
    .filter((file) => (file.jsonl?.invalidRows ?? 0) > 0)
    .sort((a, b) => (b.jsonl?.invalidRows ?? 0) - (a.jsonl?.invalidRows ?? 0))
  if (invalidJsonlFiles.length > 0) {
    const invalidRows = invalidJsonlFiles.reduce((sum, file) => sum + (file.jsonl?.invalidRows ?? 0), 0)
    findings.push({
      id: 'context.invalid-jsonl',
      severity: 'high',
      area: 'context',
      title: `${invalidRows} invalid JSONL row(s) in indexed context files`,
      impact: invalidRows,
      evidence: invalidJsonlFiles.slice(0, 5).map((file) =>
        `${file.path}: ${file.jsonl?.invalidRows ?? 0}/${file.jsonl?.rows ?? 0} invalid row(s)`),
      next: 'Fix or quarantine invalid rows before mining these logs; malformed rows make downstream joins incomplete.',
      refs: invalidJsonlFiles.slice(0, 5).map((file) => file.path),
    })
  }

  const skillRunFiles = files
    .filter((file) => basename(file.path) === 'skill-runs.jsonl' && (file.jsonl?.rows ?? 0) > 0)
    .map((file) => {
      const rows = file.jsonl?.rows ?? 0
      const keys = file.jsonl?.keys ?? {}
      const linkedRows = Math.max(
        keys.transcriptPath ?? 0,
        keys.traceDir ?? 0,
        keys.sessionPath ?? 0,
        keys.sessionId ?? 0,
      )
      return { file, rows, linkedRows }
    })
    .filter(({ rows, linkedRows }) => linkedRows < rows)
    .sort((a, b) => (b.rows - b.linkedRows) - (a.rows - a.linkedRows))
  if (skillRunFiles.length > 0) {
    const missing = skillRunFiles.reduce((sum, row) => sum + (row.rows - row.linkedRows), 0)
    findings.push({
      id: 'context.skill-run-trace-links',
      severity: skillRunFiles.some((row) => row.linkedRows === 0) ? 'medium' : 'low',
      area: 'context',
      title: `${missing} skill-run row(s) are missing a direct session link`,
      impact: missing,
      evidence: skillRunFiles.slice(0, 5).map(({ file, rows, linkedRows }) =>
        `${file.path}: ${linkedRows}/${rows} row(s) include transcriptPath, traceDir, sessionPath, or sessionId`),
      next: 'Write a transcriptPath or sessionId on every skill-run row so traces can connect skill outcomes to the actual session behavior.',
      refs: skillRunFiles.slice(0, 5).map(({ file }) => file.path),
    })
  }
}

export function inspectSessionIndex(index: TraceSessionIndex, opts: InspectSessionIndexOptions = {}): TraceInspectionReport {
  const findings: MutableFinding[] = []
  addSessionFindings(index, findings)
  addContextFindings(index, findings)

  const ranked = sortFindings(findings).slice(0, opts.maxFindings ?? 25)
  const sourceCounts = contextSourceCounts(index)
  return {
    schemaVersion: 1,
    kind: 'traces.inspection_report',
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    source: {
      indexGeneratedAt: index.generatedAt,
      sessions: index.totals.sessions,
      contextFiles: sourceCounts.contextFiles,
    },
    totals: {
      findings: ranked.length,
      high: ranked.filter((finding) => finding.severity === 'high').length,
      medium: ranked.filter((finding) => finding.severity === 'medium').length,
      low: ranked.filter((finding) => finding.severity === 'low').length,
    },
    findings: ranked,
  }
}

export function renderInspectionReport(report: TraceInspectionReport): string {
  const lines: string[] = []
  lines.push(
    `traces inspect - ${report.totals.findings} finding(s) from ${report.source.sessions} session(s), ` +
      `${report.source.contextFiles} context file(s)`,
  )
  lines.push(`Index generated: ${report.source.indexGeneratedAt ?? 'unknown'}`)
  lines.push(`Report generated: ${report.generatedAt}`)
  lines.push(`Severity totals: high ${report.totals.high}, medium ${report.totals.medium}, low ${report.totals.low}`)

  if (report.findings.length === 0) {
    lines.push('')
    lines.push('No ranked findings. Keep rerunning this after larger or fresher indexes.')
    return `${lines.join('\n')}\n`
  }

  report.findings.forEach((finding, i) => {
    lines.push('')
    lines.push(`## ${i + 1}. [${finding.severity}] ${finding.title}`)
    lines.push(`Area: ${finding.area}  Impact: ${finding.impact}`)
    lines.push('Evidence:')
    for (const item of finding.evidence) lines.push(`- ${item}`)
    lines.push(`Next: ${finding.next}`)
    if (finding.refs && finding.refs.length > 0) {
      lines.push('Refs:')
      for (const ref of finding.refs.slice(0, 5)) lines.push(`- ${ref}`)
    }
  })

  return `${lines.join('\n')}\n`
}

export function serializeInspectionReport(report: TraceInspectionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

function assertSessionIndex(value: unknown): asserts value is TraceSessionIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('session index file must contain a JSON object')
  }
  const candidate = value as { kind?: unknown; schemaVersion?: unknown; sessions?: unknown; totals?: unknown }
  if (candidate.kind !== 'traces.session_index' || candidate.schemaVersion !== 1 || !Array.isArray(candidate.sessions)) {
    throw new Error('input is not a traces.session_index v1 file')
  }
  if (!candidate.totals || typeof candidate.totals !== 'object') {
    throw new Error('session index is missing totals')
  }
}

export async function readSessionIndexFile(path: string): Promise<TraceSessionIndex> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  assertSessionIndex(parsed)
  return parsed
}

export async function writeInspectionReportFile(report: TraceInspectionReport, outPath?: string): Promise<string> {
  const path = outPath ?? join(await mkdtemp(join(tmpdir(), 'traces-inspect-')), 'inspection-report.md')
  await writeFile(path, renderInspectionReport(report), 'utf8')
  return path
}
