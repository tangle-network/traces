import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AxAIService } from '@ax-llm/ax'
import {
  type Analyst,
  type AnalystFinding,
  type AnalystRunResult,
  AnalystRegistry,
  buildDefaultAnalystRegistry,
  makeFinding,
} from '@tangle-network/agent-eval/analyst'
import type { TraceAnalysisStore } from '@tangle-network/agent-eval/traces'
import { analyzeAdoption, type AdoptionReport } from './adoption.js'
import { analyzeSpans } from './analyze.js'
import type { ExternalAnalysisResult, ExternalAnalyzer } from './external.js'
import { runExternalAnalyzers } from './external.js'
import type { TraceLiveAnalyst } from './live.js'
import type { OtlpSpan } from './otlp.js'
import { type PipelineReport, runPipelines } from './pipelines.js'
import { analyzeReactions, type ReactionReport } from './reactions.js'
import { renderAdoption, renderPipelines, renderReactions, renderReport, summarizeDeterministicSignals } from './report.js'

export interface TracesConfig {
  readonly registry?: AnalystRegistry
  readonly analysts?: readonly Analyst[]
  readonly liveAnalysts?: readonly TraceLiveAnalyst[]
  readonly externalAnalyzers?: readonly ExternalAnalyzer[]
  readonly improvementAdapter?: ImprovementAdapter
}

export interface TraceInvestigationOptions {
  readonly spans: readonly OtlpSpan[]
  readonly harness: string
  readonly sessionCount: number
  readonly cwds?: readonly string[]
  readonly minLoopOccurrences?: number
  readonly ai?: AxAIService
  readonly model?: string
  readonly budgetUsd?: number
  readonly registry?: AnalystRegistry
  readonly externalAnalyzers?: readonly ExternalAnalyzer[]
  readonly analyzerPrompt?: string
  readonly otlpOutPath?: string
  readonly generatedAt?: string
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void
}

export interface TraceRecommendation {
  readonly schemaVersion: 1
  readonly id: string
  readonly severity: AnalystFinding['severity']
  readonly title: string
  readonly action: string
  readonly rationale: string
  readonly evidenceRefs: readonly AnalystFinding['evidence_refs'][number][]
  readonly findingIds: readonly string[]
  readonly validationPlan: string
  readonly source: 'analyst' | 'deterministic' | 'external'
}

export interface TraceClaim {
  readonly schemaVersion: 1
  readonly id: string
  readonly severity: AnalystFinding['severity']
  readonly text: string
  readonly area: string
  readonly sourceFindingId: string
  readonly evidenceRefs: readonly AnalystFinding['evidence_refs'][number][]
  readonly validationPlan?: string
}

export interface TraceEvidenceRow {
  readonly schemaVersion: 1
  readonly kind: 'traces.improvement_evidence'
  readonly findingId: string
  readonly severity: AnalystFinding['severity']
  readonly area: string
  readonly claim: string
  readonly evidence: AnalystFinding['evidence_refs'][number]
}

export interface ImprovementProposal {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly recommendationIds: readonly string[]
  readonly patch?: string
  readonly validationCommand?: string
  readonly evidenceRefs?: readonly AnalystFinding['evidence_refs'][number][]
}

export interface ImprovementAdapterInput {
  readonly findings: readonly AnalystFinding[]
  readonly recommendations: readonly TraceRecommendation[]
  readonly claims: readonly TraceClaim[]
  readonly spans: readonly OtlpSpan[]
  readonly otlpPath: string
}

export interface ImprovementAdapter {
  propose(input: ImprovementAdapterInput): Promise<readonly ImprovementProposal[]>
}

export interface FindingStore {
  append(runId: string, findings: readonly AnalystFinding[]): Promise<void>
}

export interface RecommendationWriter {
  write(recommendations: readonly TraceRecommendation[]): Promise<void>
}

export interface TraceReplayProof {
  readonly schemaVersion: 1
  readonly kind: 'traces.improvement_replay'
  readonly generatedAt: string
  readonly status: 'proposal-only' | 'not-run'
  readonly candidateApplied: false
  readonly baseline: {
    readonly spanCount: number
    readonly findingCount: number
    readonly recommendationCount: number
    readonly stuckLoops: number
    readonly reactionSignals: number
    readonly toolErrorRuns: number
  }
  readonly proposals: readonly ImprovementProposal[]
  readonly note: string
}

export interface TraceImprovementArtifacts {
  readonly directory: string
  readonly findings: string
  readonly recommendations: string
  readonly proposals: string
  readonly evidence: string
  readonly claims: string
  readonly report: string
  readonly replay: string
}

export interface TraceInvestigationResult {
  readonly schemaVersion: 1
  readonly kind: 'traces.investigation'
  readonly generatedAt: string
  readonly harness: string
  readonly sessionCount: number
  readonly spanCount: number
  readonly otlpPath: string
  readonly findings: readonly AnalystFinding[]
  readonly recommendations: readonly TraceRecommendation[]
  readonly claims: readonly TraceClaim[]
  readonly pipelines: PipelineReport
  readonly reactions: ReactionReport
  readonly adoption: AdoptionReport
  readonly external: readonly ExternalAnalysisResult[]
  readonly report: string
}

export interface TraceFindingPacket {
  readonly schemaVersion: 1
  readonly kind: 'traces.finding_packet'
  readonly generatedAt: string
  readonly source: string
  readonly findings: readonly AnalystFinding[]
  readonly recommendations: readonly TraceRecommendation[]
  readonly claims: readonly TraceClaim[]
  readonly report: string
}

export interface BuildTraceFindingPacketOptions {
  readonly findings: readonly AnalystFinding[]
  readonly generatedAt?: string
  readonly source?: string
  readonly title?: string
}

export interface TraceStoreInvestigationOptions {
  readonly traceStore: TraceAnalysisStore
  readonly registry?: AnalystRegistry
  readonly ai?: AxAIService
  readonly model?: string
  readonly budgetUsd?: number
  readonly runId?: string
  readonly generatedAt?: string
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void
}

export interface TraceStoreInvestigationResult extends Omit<TraceFindingPacket, 'kind'> {
  readonly kind: 'traces.store_investigation'
  readonly analystResult: AnalystRunResult
}

export interface TraceImprovementResult extends Omit<TraceInvestigationResult, 'kind'> {
  readonly kind: 'traces.improvement'
  readonly proposals: readonly ImprovementProposal[]
  readonly replay: TraceReplayProof
  readonly artifacts?: TraceImprovementArtifacts
}

export interface TraceImprovementOptions extends TraceInvestigationOptions {
  readonly adapter?: ImprovementAdapter
  readonly outDir?: string
}

const severityRank: Record<AnalystFinding['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'item'
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function jsonl(rows: readonly unknown[]): string {
  return rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
}

function evidence(kind: AnalystFinding['evidence_refs'][number]['kind'], uri: string, excerpt?: string): AnalystFinding['evidence_refs'][number] {
  return excerpt ? { kind, uri, excerpt } : { kind, uri }
}

function totalReactionSignals(reactions: ReactionReport): number {
  return Object.values(reactions.signals).reduce((sum, count) => sum + count, 0)
}

function toolErrorRuns(pipelines: PipelineReport): number {
  return pipelines.toolUse.filter((run) => run.errorRate > 0).length
}

function deterministicFindings(pipelines: PipelineReport, reactions: ReactionReport, adoption: AdoptionReport): AnalystFinding[] {
  const findings: AnalystFinding[] = []
  const loops = pipelines.stuckLoops.findings
  if (loops.length > 0) {
    const top = [...loops].sort((a, b) => b.occurrences - a.occurrences)[0]
    findings.push(makeFinding({
      analyst_id: 'traces-deterministic',
      area: 'tool-use',
      claim: `${loops.length} repeated tool-call loop(s) were observed`,
      severity: loops.length >= 10 ? 'high' : 'medium',
      rationale: 'Repeated identical tool calls usually mean the agent is retrying without new information or a stop rule.',
      evidence_refs: [
        evidence('metric', 'pipelines.stuck_loop_count', `${loops.length} loop(s)`),
        ...(top ? [evidence('metric', `tool.${top.toolName}.repeated_calls`, `${top.toolName} repeated ${top.occurrences} time(s)`)] : []),
      ],
      recommended_action: 'Add a loop breaker: when the same tool and arguments fail or repeat, force a state check, alternate plan, or stop condition before retrying.',
      validation_plan: 'Rerun traces over fresh sessions and require repeated-call loops to drop to zero or explain each remaining loop with changed state.',
      confidence: 0.95,
      metadata: { source: 'traces.pipeline.stuckLoopView', loopCount: loops.length },
    }))
  }

  const erroredRuns = toolErrorRuns(pipelines)
  if (erroredRuns > 0) {
    findings.push(makeFinding({
      analyst_id: 'traces-deterministic',
      area: 'tool-use',
      claim: `${erroredRuns} run(s) included tool errors`,
      severity: erroredRuns >= 5 ? 'high' : 'medium',
      rationale: 'Tool errors are expensive when the agent keeps planning as if the call succeeded.',
      evidence_refs: [evidence('metric', 'pipelines.tool_error_runs', `${erroredRuns} run(s) with errorRate > 0`)],
      recommended_action: 'Fix the highest-frequency failing tool path first, then make the agent inspect failure output before retrying.',
      validation_plan: 'Rerun the same trace window and require the tool-error run count and repeated retries to decrease.',
      confidence: 0.9,
      metadata: { source: 'traces.pipeline.computeToolUseMetrics', erroredRuns },
    }))
  }

  const corrective = reactions.signals.correction + reactions.signals.frustration + reactions.signals.jargon + reactions.signals.structure
  if (corrective > 0) {
    findings.push(makeFinding({
      analyst_id: 'traces-deterministic',
      area: 'communication',
      claim: `${corrective} corrective human reaction signal(s) followed assistant turns`,
      severity: corrective >= 10 ? 'high' : 'medium',
      rationale: 'Human corrections are direct product feedback: the agent either missed the task, overexplained, used unclear language, or failed to adapt.',
      evidence_refs: reactions.triggerPairs.slice(0, 3).map((pair, index) =>
        evidence('event', `reaction.trigger_pair.${index + 1}`, `${pair.reactions.join(', ')}: ${pair.human.slice(0, 180)}`)),
      recommended_action: 'Turn the top correction pattern into an agent profile rule or analyst skill, then rerun traces and check the corrective-to-positive ratio.',
      validation_plan: 'Rerun traces on fresh sessions and require corrective reaction signals per human reaction turn to decrease.',
      confidence: 0.85,
      metadata: { source: 'traces.reactions', correctiveSignals: corrective, totalSignals: totalReactionSignals(reactions) },
    }))
  }

  const skillRuns = adoption.totalSkillInvocations + adoption.totalLoopDispatchedRuns
  if (adoption.sessionCount > 0 && skillRuns === 0) {
    findings.push(makeFinding({
      analyst_id: 'traces-deterministic',
      area: 'workflow',
      claim: 'No skill usage was observed in the selected sessions',
      severity: 'low',
      rationale: 'Repeatable work without explicit skills is harder to improve because the trace has no reusable policy boundary to patch.',
      evidence_refs: [evidence('metric', 'adoption.skill_runs', '0 explicit or loop-dispatched skill runs')],
      recommended_action: 'Create or invoke a narrow skill for the repeated workflow, then let traces compare future sessions against this baseline.',
      validation_plan: 'Rerun traces and require skill-run attribution to appear for repeated workflows.',
      confidence: 0.75,
      metadata: { source: 'traces.adoption', sessionCount: adoption.sessionCount },
    }))
  }

  return findings
}

function validSeverity(value: unknown): value is AnalystFinding['severity'] {
  return value === 'critical' || value === 'high' || value === 'medium' || value === 'low' || value === 'info'
}

function validEvidenceRef(value: unknown): value is AnalystFinding['evidence_refs'][number] {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    (row.kind === 'span' || row.kind === 'event' || row.kind === 'artifact' || row.kind === 'finding' || row.kind === 'metric') &&
    typeof row.uri === 'string' &&
    (row.excerpt === undefined || typeof row.excerpt === 'string')
  )
}

function externalRows(output: string): unknown[] {
  const trimmed = output.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return []
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === 'object') {
      const row = parsed as Record<string, unknown>
      if (Array.isArray(row.findings)) return row.findings
      if (Array.isArray(row.issues)) return row.issues
      if (Array.isArray(row.recommendations)) return row.recommendations
    }
  } catch {
    return []
  }
  return []
}

function coerceExternalFinding(analyzer: string, row: unknown, index: number): AnalystFinding | null {
  if (!row || typeof row !== 'object') return null
  const item = row as Record<string, unknown>
  const claim = item.claim ?? item.title ?? item.issue ?? item.recommendation
  if (typeof claim !== 'string' || claim.trim().length === 0) return null
  const evidenceRefs = Array.isArray(item.evidence_refs)
    ? item.evidence_refs.filter(validEvidenceRef)
    : Array.isArray(item.evidenceRefs)
      ? item.evidenceRefs.filter(validEvidenceRef)
      : []
  return makeFinding({
    analyst_id: `external:${analyzer}`,
    area: typeof item.area === 'string' && item.area ? item.area : 'external',
    claim,
    severity: validSeverity(item.severity) ? item.severity : 'medium',
    rationale: typeof item.rationale === 'string' ? item.rationale : undefined,
    evidence_refs: evidenceRefs,
    recommended_action: typeof item.recommended_action === 'string'
      ? item.recommended_action
      : typeof item.action === 'string'
        ? item.action
        : undefined,
    validation_plan: typeof item.validation_plan === 'string' ? item.validation_plan : undefined,
    confidence: typeof item.confidence === 'number' && Number.isFinite(item.confidence) ? item.confidence : 0.65,
    subject: typeof item.subject === 'string' ? item.subject : undefined,
    metadata: { source: 'traces.external', analyzer, rowIndex: index },
  })
}

function normalizeExternalFindings(results: readonly ExternalAnalysisResult[]): AnalystFinding[] {
  const out: AnalystFinding[] = []
  for (const result of results) {
    if (result.findings) out.push(...result.findings)
    externalRows(result.output).forEach((row, index) => {
      const finding = coerceExternalFinding(result.analyzer, row, index)
      if (finding) out.push(finding)
    })
  }
  return out
}

function sourceOf(finding: AnalystFinding): TraceRecommendation['source'] {
  if (finding.analyst_id.startsWith('external:')) return 'external'
  if (finding.analyst_id === 'traces-deterministic') return 'deterministic'
  return 'analyst'
}

function recommendationTitle(finding: AnalystFinding): string {
  if (finding.recommended_action) return finding.recommended_action.replace(/\.$/, '')
  return `Investigate ${finding.area}: ${finding.claim}`.replace(/\.$/, '')
}

function buildRecommendations(findings: readonly AnalystFinding[]): TraceRecommendation[] {
  return [...findings]
    .filter((finding) => finding.severity !== 'info')
    .sort((a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      b.confidence - a.confidence ||
      a.finding_id.localeCompare(b.finding_id))
    .slice(0, 20)
    .map((finding, index) => ({
      schemaVersion: 1,
      id: `rec-${index + 1}-${slug(finding.area)}`,
      severity: finding.severity,
      title: recommendationTitle(finding),
      action: finding.recommended_action ?? `Review and fix: ${finding.claim}`,
      rationale: finding.rationale ?? finding.claim,
      evidenceRefs: finding.evidence_refs,
      findingIds: [finding.finding_id],
      validationPlan: finding.validation_plan ?? 'Rerun `traces improve` on a fresh comparable session window and confirm this finding disappears or drops in severity.',
      source: sourceOf(finding),
    }))
}

function buildClaims(findings: readonly AnalystFinding[]): TraceClaim[] {
  return findings.map((finding, index) => ({
    schemaVersion: 1,
    id: `claim-${index + 1}-${slug(finding.area)}`,
    severity: finding.severity,
    text: finding.claim,
    area: finding.area,
    sourceFindingId: finding.finding_id,
    evidenceRefs: finding.evidence_refs,
    validationPlan: finding.validation_plan,
  }))
}

function buildEvidenceRows(findings: readonly AnalystFinding[]): TraceEvidenceRow[] {
  return findings.flatMap((finding) =>
    finding.evidence_refs.map((ref) => ({
      schemaVersion: 1,
      kind: 'traces.improvement_evidence' as const,
      findingId: finding.finding_id,
      severity: finding.severity,
      area: finding.area,
      claim: finding.claim,
      evidence: ref,
    })))
}

function renderRecommendations(recommendations: readonly TraceRecommendation[]): string {
  const lines = ['## recommendations', '']
  if (recommendations.length === 0) {
    lines.push('- No recommendations emitted.')
    lines.push('')
    return lines.join('\n')
  }
  for (const rec of recommendations.slice(0, 10)) {
    lines.push(`### ${rec.severity.toUpperCase()} — ${rec.title}`)
    lines.push('')
    lines.push(`- **Action:** ${rec.action}`)
    lines.push(`- **Why:** ${rec.rationale}`)
    lines.push(`- **Check:** ${rec.validationPlan}`)
    for (const ref of rec.evidenceRefs.slice(0, 3)) {
      lines.push(`- **Evidence:** ${ref.kind} ${ref.uri}${ref.excerpt ? ` — \`${ref.excerpt.slice(0, 180)}\`` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function renderFindingPacket(packet: Omit<TraceFindingPacket, 'report'>, title = 'Trace finding packet'): string {
  const lines = [`# ${title}`, '']
  lines.push(`${packet.findings.length} finding(s), ${packet.recommendations.length} recommendation(s), ${packet.claims.length} claim(s).`)
  lines.push('')
  lines.push(renderRecommendations(packet.recommendations))
  if (packet.findings.length > 0) {
    lines.push('## findings')
    lines.push('')
    for (const finding of [...packet.findings].sort((a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      a.area.localeCompare(b.area) ||
      a.claim.localeCompare(b.claim))) {
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
    recommendations: buildRecommendations(opts.findings),
    claims: buildClaims(opts.findings),
  }
  return { ...packet, report: renderFindingPacket(packet, opts.title) }
}

function buildDefaultImprovementProposals(input: ImprovementAdapterInput): ImprovementProposal[] {
  return input.recommendations.slice(0, 5).map((recommendation, index) => {
    const matchingFindings = input.findings.filter((finding) => recommendation.findingIds.includes(finding.finding_id))
    const evidenceRefs = recommendation.evidenceRefs.length > 0
      ? recommendation.evidenceRefs
      : matchingFindings.flatMap((finding) => finding.evidence_refs)
    return {
      id: `proposal-${index + 1}-${slug(recommendation.title)}`,
      title: recommendation.title,
      description: [
        recommendation.action,
        '',
        `Why: ${recommendation.rationale}`,
        `Validation: ${recommendation.validationPlan}`,
        '',
        'This is a proposal-only artifact. It does not mutate code, prompts, skills, tools, MCP config, hooks, subagents, or external systems until a human applies it and reruns validation.',
      ].join('\n'),
      recommendationIds: [recommendation.id],
      validationCommand: 'traces improve --last 1 --dir .traces/improvement',
      evidenceRefs,
    }
  })
}

function renderExternal(results: readonly ExternalAnalysisResult[]): string {
  if (results.length === 0) return ''
  const lines = ['## external analyzers', '']
  for (const result of results) {
    lines.push(`### ${result.analyzer}`)
    lines.push('')
    lines.push(result.ok ? result.output || '(no output)' : `failed: ${result.error}`)
    lines.push('')
  }
  return lines.join('\n')
}

function renderInvestigationReport(result: TraceInvestigationResult, analystResult: Awaited<ReturnType<typeof analyzeSpans>>['result']): string {
  const base =
    `${renderReport({ ...analystResult, findings: [...result.findings] }, {
      harness: result.harness,
      sessionCount: result.sessionCount,
      spanCount: result.spanCount,
      otlpPath: result.otlpPath,
      deterministic: summarizeDeterministicSignals(result.pipelines, result.reactions),
    })}\n` +
    `${renderRecommendations(result.recommendations)}\n` +
    `${renderPipelines(result.pipelines)}\n${renderReactions(result.reactions)}\n${renderAdoption(result.adoption)}`
  const external = renderExternal(result.external)
  return external ? `${base}\n${external}` : base
}

function registryFromConfig(config?: TracesConfig): AnalystRegistry | undefined {
  if (!config) return undefined
  if (config.registry) return config.registry
  if (!config.analysts || config.analysts.length === 0) return undefined
  const registry = new AnalystRegistry()
  for (const analyst of config.analysts) registry.register(analyst)
  return registry
}

async function existingConfigPath(path?: string): Promise<string | undefined> {
  const candidates = path ? [path] : ['traces.config.mjs', 'traces.config.js', 'traces.config.cjs']
  for (const candidate of candidates) {
    const resolved = resolve(candidate)
    try {
      await access(resolved)
      return resolved
    } catch {
      if (path) return undefined
    }
  }
  return undefined
}

export async function loadTracesConfig(path?: string): Promise<TracesConfig | undefined> {
  const resolved = await existingConfigPath(path)
  if (!resolved) return undefined
  let mod: Record<string, unknown>
  try {
    mod = await import(pathToFileURL(resolved).href) as Record<string, unknown>
  } catch (err) {
    if (resolved.endsWith('.ts')) {
      throw new Error(`traces config is TypeScript (${resolved}); use traces.config.mjs/js, or run the CLI through a TS loader`)
    }
    throw err
  }
  const value = mod.default ?? mod.config
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new Error(`${path} must export a config object`)
  return value as TracesConfig
}

export function mergeTracesConfig(opts: TraceInvestigationOptions, config?: TracesConfig): TraceInvestigationOptions {
  if (!config) return opts
  return {
    ...opts,
    registry: opts.registry ?? registryFromConfig(config),
    externalAnalyzers: [...(config.externalAnalyzers ?? []), ...(opts.externalAnalyzers ?? [])],
  }
}

export async function runTraceInvestigation(opts: TraceInvestigationOptions): Promise<TraceInvestigationResult> {
  if (opts.spans.length === 0) throw new Error('runTraceInvestigation: no spans to analyze')
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const [analysis, pipelines, reactions, adoption] = await Promise.all([
    analyzeSpans(opts.spans, {
      ai: opts.ai,
      model: opts.model,
      budgetUsd: opts.budgetUsd,
      registry: opts.registry,
      otlpOutPath: opts.otlpOutPath,
      runId: `traces-investigation-${Date.parse(generatedAt) || Date.now()}`,
      log: opts.log,
    }),
    runPipelines(opts.spans, { minLoopOccurrences: opts.minLoopOccurrences }),
    Promise.resolve(analyzeReactions(opts.spans)),
    analyzeAdoption(opts.spans, { cwds: opts.cwds }),
  ])
  const external = opts.externalAnalyzers?.length
    ? await runExternalAnalyzers(analysis.otlpPath, opts.externalAnalyzers, { prompt: opts.analyzerPrompt })
    : []
  const findings = [
    ...analysis.result.findings,
    ...deterministicFindings(pipelines, reactions, adoption),
    ...normalizeExternalFindings(external),
  ]
  const recommendations = buildRecommendations(findings)
  const claims = buildClaims(findings)
  const partial: Omit<TraceInvestigationResult, 'report'> = {
    schemaVersion: 1,
    kind: 'traces.investigation',
    generatedAt,
    harness: opts.harness,
    sessionCount: opts.sessionCount,
    spanCount: opts.spans.length,
    otlpPath: analysis.otlpPath,
    findings,
    recommendations,
    claims,
    pipelines,
    reactions,
    adoption,
    external,
  }
  const result = { ...partial, report: '' }
  return { ...result, report: renderInvestigationReport(result, analysis.result) }
}

export async function runTraceStoreInvestigation(opts: TraceStoreInvestigationOptions): Promise<TraceStoreInvestigationResult> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const registry = opts.registry ?? buildDefaultAnalystRegistry({
    ai: opts.ai,
    model: opts.model,
    registry: { log: opts.log },
  })
  const runId = opts.runId ?? `traces-store-investigation-${Date.parse(generatedAt) || Date.now()}`
  const analystResult = await registry.run(runId, { traceStore: opts.traceStore }, {
    budget: opts.budgetUsd != null ? { totalUsd: opts.budgetUsd } : undefined,
  })
  const packet = buildTraceFindingPacket({
    findings: analystResult.findings,
    generatedAt,
    source: 'trace-store',
    title: 'Trace store investigation',
  })
  return {
    ...packet,
    kind: 'traces.store_investigation',
    analystResult,
  }
}

function replayProof(result: TraceInvestigationResult, proposals: readonly ImprovementProposal[]): TraceReplayProof {
  const deterministic = summarizeDeterministicSignals(result.pipelines, result.reactions)
  return {
    schemaVersion: 1,
    kind: 'traces.improvement_replay',
    generatedAt: result.generatedAt,
    status: proposals.length > 0 ? 'proposal-only' : 'not-run',
    candidateApplied: false,
    baseline: {
      spanCount: result.spanCount,
      findingCount: result.findings.length,
      recommendationCount: result.recommendations.length,
      stuckLoops: deterministic.stuckLoops,
      reactionSignals: deterministic.reactionSignals,
      toolErrorRuns: deterministic.toolErrorRuns,
    },
    proposals,
    note: proposals.length > 0
      ? 'traces produced reviewable proposals only; apply one and rerun traces on a comparable window to populate after metrics.'
      : 'no proposal adapter was configured, so no candidate was applied; recommendations remain reviewable guidance.',
  }
}

export async function writeTraceImprovementArtifacts(
  result: Pick<TraceImprovementResult, 'findings' | 'recommendations' | 'proposals' | 'claims' | 'report' | 'replay'>,
  outDir?: string,
): Promise<TraceImprovementArtifacts> {
  const directory = outDir ? resolve(outDir) : await mkdtemp(join(tmpdir(), 'traces-improvement-'))
  await mkdir(directory, { recursive: true })
  const paths: TraceImprovementArtifacts = {
    directory,
    findings: join(directory, 'findings.json'),
    recommendations: join(directory, 'recommendations.json'),
    proposals: join(directory, 'proposals.json'),
    evidence: join(directory, 'evidence.jsonl'),
    claims: join(directory, 'claims.json'),
    report: join(directory, 'report.md'),
    replay: join(directory, 'replay-before-after.json'),
  }
  await Promise.all([
    writeFile(paths.findings, json(result.findings), 'utf8'),
    writeFile(paths.recommendations, json(result.recommendations), 'utf8'),
    writeFile(paths.proposals, json(result.proposals), 'utf8'),
    writeFile(paths.evidence, jsonl(buildEvidenceRows(result.findings)), 'utf8'),
    writeFile(paths.claims, json(result.claims), 'utf8'),
    writeFile(paths.report, result.report, 'utf8'),
    writeFile(paths.replay, json(result.replay), 'utf8'),
  ])
  return paths
}

export async function runTraceImprovementLoop(opts: TraceImprovementOptions): Promise<TraceImprovementResult> {
  const investigation = await runTraceInvestigation(opts)
  const adapterInput = {
    findings: investigation.findings,
    recommendations: investigation.recommendations,
    claims: investigation.claims,
    spans: opts.spans,
    otlpPath: investigation.otlpPath,
  }
  const proposals = opts.adapter
    ? await opts.adapter.propose(adapterInput)
    : buildDefaultImprovementProposals(adapterInput)
  const replay = replayProof(investigation, proposals)
  const result: TraceImprovementResult = {
    ...investigation,
    kind: 'traces.improvement',
    proposals,
    replay,
  }
  return {
    ...result,
    artifacts: await writeTraceImprovementArtifacts(result, opts.outDir),
  }
}

export async function saveReport(path: string, report: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(path, report, 'utf8')
}
