import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AxAIService } from '@ax-llm/ax'
import type { ExecutionReport } from '@tangle-network/agent-eval/contract'
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
import {
  renderAdoption,
  renderPipelines,
  renderReactions,
  renderReport,
  type ReportSource,
  summarizeDeterministicSignals,
} from './report.js'

export interface TracesConfig {
  readonly registry?: AnalystRegistry
  readonly analysts?: readonly Analyst[]
  readonly liveAnalysts?: readonly TraceLiveAnalyst[]
  readonly externalAnalyzers?: readonly ExternalAnalyzer[]
}

export interface TraceInvestigationOptions {
  readonly spans: readonly OtlpSpan[]
  readonly harness: string
  readonly sources?: readonly ReportSource[]
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

export interface TraceEvidenceRow {
  readonly schemaVersion: 1
  readonly kind: 'traces.improvement_evidence'
  readonly findingId: string
  readonly severity: AnalystFinding['severity']
  readonly area: string
  readonly claim: string
  readonly evidence: AnalystFinding['evidence_refs'][number]
}

export interface TraceImprovementArtifacts {
  readonly directory: string
  readonly result: string
  readonly evidence: string
  readonly report: string
  readonly traces: string
}

export interface TraceInvestigationResult {
  readonly schemaVersion: 1
  readonly kind: 'traces.investigation'
  readonly generatedAt: string
  readonly harness: string
  /** Distinct stable session identities observed in the selected spans. */
  readonly sessionCount: number
  /** Traces without exactly one stable session identity. */
  readonly unassignedTraceCount: number
  readonly sources?: readonly ReportSource[]
  readonly spanCount: number
  readonly otlpPath: string
  readonly execution: ExecutionReport
  readonly findings: readonly AnalystFinding[]
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
  readonly artifacts?: TraceImprovementArtifacts
}

export interface TraceImprovementOptions extends TraceInvestigationOptions {
  readonly outDir?: string
}

const severityRank: Record<AnalystFinding['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
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

function traceCoverageFinding(
  pipelines: PipelineReport,
  adoption: AdoptionReport,
): AnalystFinding | undefined {
  const toolCalls = pipelines.toolUse.reduce((total, run) => total + run.totalCalls, 0)
  const capturedToolCalls = pipelines.toolUse.reduce(
    (total, run) => total + run.callsWithCapturedArgs,
    0,
  )
  const missingToolArgs = toolCalls - capturedToolCalls
  const traces = pipelines.toolUse.length
  const missingSessionIds = adoption.unassignedTraceCount
  const sessionIdentityConflicts = adoption.sessionIdentityConflicts
  const unmeasurableSkillGroups = adoption.executionGroupCount - adoption.skillTelemetrySessions
  if (missingToolArgs === 0 && missingSessionIds === 0 && unmeasurableSkillGroups === 0) {
    return undefined
  }

  const parts: string[] = []
  const refs: AnalystFinding['evidence_refs'] = []
  if (missingToolArgs > 0) {
    parts.push(`${missingToolArgs}/${toolCalls} tool call(s) lacked comparable arguments`)
    refs.push(evidence('metric', 'coverage.tool_arguments', `${capturedToolCalls}/${toolCalls} captured`))
  }
  if (missingSessionIds > 0) {
    parts.push(`${missingSessionIds}/${traces} trace(s) lacked a single stable session identity`)
    refs.push(evidence('metric', 'coverage.session_identity', `${traces - missingSessionIds}/${traces} identified`))
  }
  if (sessionIdentityConflicts.length > 0) {
    refs.push(evidence(
      'span',
      'coverage.session_identity_conflicts',
      sessionIdentityConflicts.map((conflict) => conflict.traceId).join(', '),
    ))
  }
  if (unmeasurableSkillGroups > 0) {
    parts.push(`${unmeasurableSkillGroups}/${adoption.executionGroupCount} execution group(s) lacked measurable skill events`)
    refs.push(evidence(
      'metric',
      'coverage.skill_events',
      `${adoption.skillTelemetrySessions}/${adoption.executionGroupCount} measurable`,
    ))
  }

  const argumentCoverage = toolCalls === 0 ? 1 : capturedToolCalls / toolCalls
  const sessionCoverage = traces === 0 ? 1 : (traces - missingSessionIds) / traces
  const severity: AnalystFinding['severity'] =
    argumentCoverage < 0.5 || sessionCoverage < 0.5
      ? 'high'
      : argumentCoverage < 0.9 || sessionCoverage < 0.9 || unmeasurableSkillGroups > 0
        ? 'medium'
        : 'low'
  return makeFinding({
    analyst_id: 'traces-deterministic',
    area: 'instrumentation',
    claim: `Trace capture is incomplete: ${parts.join('; ')}`,
    severity,
    rationale:
      'Missing identity or agent-profile evidence prevents reliable cross-run comparison and can hide tool, prompt, skill, or subagent failures.',
    evidence_refs: refs,
    recommended_action:
      'Update the source telemetry bridge once: emit a stable session ID, complete canonical tool arguments, explicit argument-capture status, and dedicated skill/subagent events before optimizing the agent profile.',
    validation_plan:
      'Rerun the same source and require every trace to carry exactly one session identity, every tool call to declare and preserve its full arguments, and every supported execution group to expose skill events.',
    confidence: 1,
    metadata: {
      source: 'traces.coverage',
      toolCalls,
      capturedToolCalls,
      traces,
      missingSessionIds,
      sessionIdentityConflictCount: sessionIdentityConflicts.length,
      skillTelemetryGroups: adoption.skillTelemetrySessions,
      executionGroups: adoption.executionGroupCount,
    },
  })
}

function deterministicFindings(pipelines: PipelineReport, reactions: ReactionReport, adoption: AdoptionReport): AnalystFinding[] {
  const findings: AnalystFinding[] = []
  const coverage = traceCoverageFinding(pipelines, adoption)
  if (coverage) findings.push(coverage)
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

  const failedRuns = pipelines.failureClusters.totalFailures
  if (failedRuns > 0) {
    const top = pipelines.failureClusters.clusters[0]
    const failureRate = failedRuns / Math.max(1, pipelines.failureClusters.totalRuns)
    findings.push(makeFinding({
      analyst_id: 'traces-deterministic',
      area: 'reliability',
      claim: `${failedRuns}/${pipelines.failureClusters.totalRuns} run(s) had execution errors`,
      severity: failureRate >= 0.1 ? 'high' : 'medium',
      rationale: 'Execution errors consume time and tokens, and sparse error telemetry can hide whether the agent recovered or repeated the same failure.',
      evidence_refs: [
        evidence(
          'metric',
          `pipelines.failure_cluster.${top?.failureClass ?? 'unknown'}`,
          top
            ? `${top.runCount} run(s); example: ${top.exampleError ?? 'error details not captured'}`
            : `${failedRuns} failed run(s)`,
        ),
        ...(top?.exampleRunId
          ? [evidence('span', `trace:${top.exampleRunId}`, top.exampleError)]
          : []),
      ],
      recommended_action: top?.failureClass === 'unknown'
        ? 'Instrument the failing operation name and arguments, then start with the highest-frequency example error and verify the agent changes state before retrying.'
        : 'Fix the highest-frequency failure cluster first, then require the agent to inspect the error and change state before retrying.',
      validation_plan: 'Rerun a comparable trace window and require failed runs and repeated failures in the top cluster to decrease.',
      confidence: 1,
      metadata: {
        source: 'agent-eval.failureClusterView',
        failedRuns,
        totalRuns: pipelines.failureClusters.totalRuns,
        topFailureClass: top?.failureClass,
        exampleRunId: top?.exampleRunId,
      },
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
  const allSessionsMeasurable = adoption.skillTelemetrySessions === adoption.executionGroupCount
  if (allSessionsMeasurable && adoption.executionGroupCount > 0 && skillRuns === 0) {
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
      metadata: { source: 'traces.adoption', executionGroupCount: adoption.executionGroupCount },
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

function renderFindingPacket(packet: Omit<TraceFindingPacket, 'report'>, title = 'Trace finding packet'): string {
  const lines = [`# ${title}`, '']
  lines.push(`${packet.findings.length} evidence-backed finding(s) with actions and checks.`)
  lines.push('')
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
  }
  return { ...packet, report: renderFindingPacket(packet, opts.title) }
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
      unassignedTraceCount: result.unassignedTraceCount,
      spanCount: result.spanCount,
      otlpPath: result.otlpPath,
      execution: result.execution,
      deterministic: summarizeDeterministicSignals(result.pipelines, result.reactions),
      sources: result.sources,
    })}\n` +
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
  const partial: Omit<TraceInvestigationResult, 'report'> = {
    schemaVersion: 1,
    kind: 'traces.investigation',
    generatedAt,
    harness: opts.harness,
    sessionCount: adoption.identifiedSessionCount,
    unassignedTraceCount: adoption.unassignedTraceCount,
    sources: opts.sources,
    spanCount: opts.spans.length,
    otlpPath: analysis.otlpPath,
    execution: analysis.execution,
    findings,
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

export async function writeTraceImprovementArtifacts(
  result: Omit<TraceImprovementResult, 'artifacts'>,
  outDir?: string,
): Promise<TraceImprovementArtifacts> {
  const directory = outDir ? resolve(outDir) : await mkdtemp(join(tmpdir(), 'traces-improvement-'))
  await mkdir(directory, { recursive: true })
  const paths: TraceImprovementArtifacts = {
    directory,
    result: join(directory, 'result.json'),
    evidence: join(directory, 'evidence.jsonl'),
    report: join(directory, 'report.md'),
    traces: result.otlpPath,
  }
  const { report, ...machineResult } = result
  await Promise.all([
    writeFile(paths.result, json(machineResult), 'utf8'),
    writeFile(paths.evidence, jsonl(buildEvidenceRows(result.findings)), 'utf8'),
    writeFile(paths.report, report, 'utf8'),
  ])
  return paths
}

export async function runTraceImprovement(
  opts: TraceImprovementOptions,
): Promise<TraceImprovementResult> {
  const directory = opts.outDir
    ? resolve(opts.outDir)
    : await mkdtemp(join(tmpdir(), 'traces-improvement-'))
  await mkdir(directory, { recursive: true })
  const investigation = await runTraceInvestigation({
    ...opts,
    otlpOutPath: opts.otlpOutPath ?? join(directory, 'traces.otlp.jsonl'),
  })
  const result: Omit<TraceImprovementResult, 'artifacts'> = {
    ...investigation,
    kind: 'traces.improvement',
  }
  return {
    ...result,
    artifacts: await writeTraceImprovementArtifacts(result, directory),
  }
}

export async function saveReport(path: string, report: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(path, report, 'utf8')
}
