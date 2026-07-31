import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TraceAnalysisEngine } from '@tangle-network/agent-eval/analyst'
import type { ExecutionReport } from '@tangle-network/agent-eval/contract'
import {
  type Analyst,
  type AnalystFinding,
  type AnalystRunResult,
  type AnalystRunSummary,
  AnalystRegistry,
  buildDefaultAnalystRegistry,
  makeFinding,
} from '@tangle-network/agent-eval/analyst'
import type { TraceAnalysisStore } from '@tangle-network/agent-eval/traces'
import { analyzeAdoption, type AdoptionReport } from './adoption.js'
import {
  planTraceAgenticRoute,
  traceAgenticKinds,
  type TraceAgenticRoute,
} from './agentic-routing.js'
import { analyzeSpans } from './analyze.js'
import type { ExternalAnalysisResult, ExternalAnalyzer } from './external.js'
import { spanEvidenceUri } from './external-analysis-validation.js'
import { runExternalAnalyzers } from './external.js'
import type { TraceLiveAnalyst } from './live.js'
import type { OtlpSpan } from './otlp.js'
import { type PipelineReport, runPipelines } from './pipelines.js'
import { analyzeReactions, type ReactionReport } from './reactions.js'
import {
  condenseAnalystError,
  renderAdoption,
  renderPipelines,
  renderReactions,
  renderReport,
  type ReportSource,
  summarizeDeterministicSignals,
} from './report.js'
import type { SessionWorkflowSummary } from './session-workflow.js'

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
  readonly workflow?: SessionWorkflowSummary
  readonly cwds?: readonly string[]
  readonly minLoopOccurrences?: number
  readonly engine?: TraceAnalysisEngine
  readonly model?: string
  readonly budgetUsd?: number
  readonly registry?: AnalystRegistry
  /** Agentic registry override for custom trace-analysis agents. */
  readonly agenticRegistry?: AnalystRegistry
  readonly externalAnalyzers?: readonly ExternalAnalyzer[]
  readonly analyzerPrompt?: string
  readonly otlpOutPath?: string
  readonly generatedAt?: string
  readonly signal?: AbortSignal
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
  readonly workflow?: SessionWorkflowSummary
  readonly spanCount: number
  readonly otlpPath: string
  readonly execution: ExecutionReport
  readonly analystResult: AnalystRunResult
  readonly findings: readonly AnalystFinding[]
  readonly pipelines: PipelineReport
  readonly reactions: ReactionReport
  readonly adoption: AdoptionReport
  /** Deterministic routing record for the agentic trace-analysis pass. */
  readonly agenticRoute?: TraceAgenticRoute
  /**
   * Per-analyst summaries from the agentic pass alone. Present only when an
   * agentic pass ran; failed entries carry the engine's error (bridge stderr
   * included), so callers can fail loud instead of reporting the deterministic
   * findings as if the requested LLM analysis had happened.
   */
  readonly agenticPerAnalyst?: readonly AnalystRunSummary[]
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
  readonly engine?: TraceAnalysisEngine
  readonly model?: string
  readonly budgetUsd?: number
  readonly runId?: string
  readonly generatedAt?: string
  readonly signal?: AbortSignal
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

function sortedToolErrorSpans(spans: readonly OtlpSpan[]): OtlpSpan[] {
  return spans
    .filter((item) =>
      item.attributes['openinference.span.kind'] === 'TOOL' &&
      item.status.code === 'ERROR')
    .sort((left, right) =>
      left.start_time.localeCompare(right.start_time) ||
      left.trace_id.localeCompare(right.trace_id) ||
      left.span_id.localeCompare(right.span_id))
}

function toolErrorEvidence(item: OtlpSpan): AnalystFinding['evidence_refs'][number] {
  return evidence(
    'span',
    spanEvidenceUri(item.trace_id, item.span_id),
    `${String(item.attributes['tool.name'] ?? item.name)}: ${item.status.message ?? 'tool span ended with ERROR'}`.slice(0, 240),
  )
}

function toolErrorFinding(
  pipelines: PipelineReport,
  spans: readonly OtlpSpan[],
): AnalystFinding | undefined {
  const terminalFailureTraceIds = new Set(
    spans
      .filter((item) => item.parent_span_id === null && item.status.code === 'ERROR')
      .map((item) => item.trace_id),
  )
  const nonTerminalRuns = pipelines.toolUse.filter(
    (run) => !terminalFailureTraceIds.has(run.runId),
  )
  const totalCalls = nonTerminalRuns.reduce((total, run) => total + run.totalCalls, 0)
  const errorCount = nonTerminalRuns.reduce(
    (total, run) => total + Object.values(run.byTool)
      .reduce((runTotal, tool) => runTotal + tool.errors, 0),
    0,
  )
  if (errorCount === 0) return undefined

  const errorSpans = sortedToolErrorSpans(spans)
    .filter((item) => !terminalFailureTraceIds.has(item.trace_id))
  if (errorSpans.length === 0) return undefined

  const affectedRuns = new Set(errorSpans.map((item) => item.trace_id)).size
  const errorRate = errorCount / Math.max(1, totalCalls)
  const citedSpans = errorSpans.slice(0, 3)

  return makeFinding({
    analyst_id: 'traces-deterministic',
    area: 'tool-use',
    subject: 'non-terminal-tool-errors',
    claim: `${errorCount}/${totalCalls} tool call(s) ended in errors across ${affectedRuns} run(s) without a terminal failure`,
    severity: errorRate >= 0.25 ? 'high' : 'medium',
    rationale: 'Recovered tool errors still consume time and tokens, and repeated failures can hide brittle retry or recovery behavior.',
    evidence_refs: citedSpans.map(toolErrorEvidence),
    recommended_action: 'Inspect the most frequent failing tool and its cited inputs, then change the retry or recovery policy so a failure produces new state before another call.',
    validation_plan: 'Rerun comparable sessions and require non-terminal tool errors to decrease without increasing terminal failures.',
    confidence: 1,
    metadata: {
      source: 'agent-eval.computeToolUseMetrics',
      errorCount,
      totalCalls,
      errorRate,
      affectedRuns,
      citedErrorSpans: citedSpans.length,
      omittedErrorSpans: Math.max(0, errorSpans.length - citedSpans.length),
    },
    id_basis: 'non-terminal-tool-errors',
  })
}

function deterministicFindings(
  pipelines: PipelineReport,
  reactions: ReactionReport,
  adoption: AdoptionReport,
  spans: readonly OtlpSpan[],
): AnalystFinding[] {
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

  const toolErrors = toolErrorFinding(pipelines, spans)
  if (toolErrors) findings.push(toolErrors)

  const failedRuns = pipelines.failureClusters.totalFailures
  if (failedRuns > 0) {
    const top = pipelines.failureClusters.clusters[0]
    const failureRate = failedRuns / Math.max(1, pipelines.failureClusters.totalRuns)
    const exampleSpans = top?.exampleRunId
      ? spans.filter((item) => item.trace_id === top.exampleRunId)
      : []
    const exampleRoot = exampleSpans.find((item) =>
      item.parent_span_id === null && item.status.code === 'ERROR')
    const exampleToolErrors = sortedToolErrorSpans(exampleSpans)
    const citedToolErrors = exampleToolErrors.slice(0, 3)
    findings.push(makeFinding({
      analyst_id: 'traces-deterministic',
      area: 'reliability',
      claim: `${failedRuns}/${pipelines.failureClusters.totalRuns} run(s) had execution errors`,
      severity: failureRate >= 0.1 ? 'high' : 'medium',
      rationale: 'Execution errors consume time and tokens, and sparse error telemetry can hide whether the agent recovered or repeated the same failure.',
      evidence_refs: [
        ...(exampleRoot
          ? [evidence(
              'span',
              spanEvidenceUri(exampleRoot.trace_id, exampleRoot.span_id),
              `${exampleRoot.name}: ${exampleRoot.status.message ?? 'root span ended with ERROR'}`.slice(0, 240),
            )]
          : []),
        ...citedToolErrors.map(toolErrorEvidence),
        evidence(
          'metric',
          `pipelines.failure_cluster.${top?.failureClass ?? 'unknown'}`,
          top
            ? `${top.runCount} run(s); example: ${top.exampleError ?? 'error details not captured'}`
            : `${failedRuns} failed run(s)`,
        ),
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
        citedToolErrorSpans: citedToolErrors.length,
        omittedToolErrorSpans: Math.max(0, exampleToolErrors.length - citedToolErrors.length),
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

function normalizeExternalFindings(results: readonly ExternalAnalysisResult[]): AnalystFinding[] {
  return results.flatMap((result) =>
    result.ok && result.kind === 'findings' ? [...(result.findings ?? [])] : [],
  )
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
    lines.push(`### ${result.analyzer} (${result.kind})`)
    lines.push('')
    if (!result.ok) lines.push(`failed: ${result.error}`)
    else if (result.kind === 'discovery') {
      lines.push(`${result.candidates?.length ?? 0} review candidate(s).`)
      if (result.output) lines.push('', result.output)
    } else lines.push(result.output || '(no output)')
    lines.push('')
  }
  return lines.join('\n')
}

function renderAgenticRoute(route: TraceAgenticRoute | undefined): string {
  if (!route) return ''
  const lines = ['## LLM trace analysis', '']
  lines.push(`- **Selected analysts:** ${route.analystIds.map((id) => `\`${id}\``).join(', ')}`)
  for (const reason of route.reasons) lines.push(`- **${reason.code}:** ${reason.detail}`)
  lines.push('')
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
      workflow: result.workflow,
    })}\n${renderAgenticRoute(result.agenticRoute)}` +
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
    } catch (error) {
      if (path) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') throw new Error(`traces config not found: ${resolved}`)
        throw error
      }
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
  opts.signal?.throwIfAborted()
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const [pipelines, reactions, adoption] = await Promise.all([
    runPipelines(opts.spans, { minLoopOccurrences: opts.minLoopOccurrences }),
    Promise.resolve(analyzeReactions(opts.spans)),
    analyzeAdoption(opts.spans, { cwds: opts.cwds }),
  ])
  opts.signal?.throwIfAborted()
  const deterministic = deterministicFindings(pipelines, reactions, adoption, opts.spans)
  // A supplied registry owns its own composition. Only describe a route when
  // this package builds the maintained agent-eval suite itself.
  const agenticRoute = opts.engine && !opts.agenticRegistry
    ? planTraceAgenticRoute(pipelines, reactions)
    : undefined
  const analysis = await analyzeSpans(opts.spans, {
    engine: opts.engine,
    model: opts.model,
    budgetUsd: opts.budgetUsd,
    registry: opts.registry,
    agenticRegistry: opts.agenticRegistry,
    agenticKinds: agenticRoute ? traceAgenticKinds(agenticRoute) : undefined,
    agenticPriorFindings: deterministic,
    otlpOutPath: opts.otlpOutPath,
    runId: `traces-investigation-${Date.parse(generatedAt) || Date.now()}`,
    signal: opts.signal,
    log: opts.log,
  })
  const external = opts.externalAnalyzers?.length
    ? await runExternalAnalyzers(analysis.otlpPath, opts.externalAnalyzers, {
        prompt: opts.analyzerPrompt,
        signal: opts.signal,
        spans: opts.spans,
      })
    : []
  opts.signal?.throwIfAborted()
  const findings = [
    ...analysis.result.findings,
    ...deterministic,
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
    workflow: opts.workflow,
    spanCount: opts.spans.length,
    otlpPath: analysis.otlpPath,
    execution: analysis.execution,
    analystResult: analysis.result,
    findings,
    pipelines,
    reactions,
    adoption,
    ...(agenticRoute ? { agenticRoute } : {}),
    ...(analysis.agenticPerAnalyst ? { agenticPerAnalyst: analysis.agenticPerAnalyst } : {}),
    external,
  }
  const result = { ...partial, report: '' }
  return { ...result, report: renderInvestigationReport(result, analysis.result) }
}

/** Cap for one analyst's reason inside the failure banner; the full error is
 * already on that analyst's `[analyst] FAIL` stderr line. */
const AGENTIC_FAILURE_REASON_MAX_CHARS = 400

/** Startup-class bridge failures whose fix is aligning the Python bridge with
 * the bundled `@tangle-network/agent-eval` version. */
const BRIDGE_MISMATCH_PATTERN = /DSPY-BRIDGE-FAILURE|agent_eval_rpc|No module named|could not start/

function condensedReason(summary: AnalystRunSummary): string {
  const raw = summary.error
    ? `${summary.error.class}: ${summary.error.message}`
    : 'failed without an error message'
  return condenseAnalystError(raw, AGENTIC_FAILURE_REASON_MAX_CHARS)
}

/**
 * Operator-facing message for a fully dead agentic pass: non-empty exactly
 * when an agentic pass ran and EVERY analyst in it failed. Partial failures
 * return undefined — some agentic findings were produced, and the per-analyst
 * report table carries the individual reasons.
 */
export function totalAgenticFailureMessage(
  agenticPerAnalyst: readonly AnalystRunSummary[] | undefined,
  opts: { requiredBridgeVersion?: string } = {},
): string | undefined {
  if (!agenticPerAnalyst || agenticPerAnalyst.length === 0) return undefined
  if (agenticPerAnalyst.some((summary) => summary.status !== 'failed')) return undefined
  const lines = [
    `LLM analysis produced nothing: all ${agenticPerAnalyst.length} agentic analyst(s) failed. ` +
      'The reported findings are from the deterministic pass only.',
    ...agenticPerAnalyst.map((summary) => `  ${summary.analyst_id}: ${condensedReason(summary)}`),
  ]
  if (
    opts.requiredBridgeVersion &&
    agenticPerAnalyst.some((summary) => BRIDGE_MISMATCH_PATTERN.test(summary.error?.message ?? ''))
  ) {
    lines.push(
      'hint: the DSPy bridge protocol is version-locked — the TRACES_PYTHON interpreter needs ' +
        `agent-eval-rpc[dspy]==${opts.requiredBridgeVersion} (matching this package's @tangle-network/agent-eval).`,
    )
  }
  return lines.join('\n')
}

export async function runTraceStoreInvestigation(opts: TraceStoreInvestigationOptions): Promise<TraceStoreInvestigationResult> {
  opts.signal?.throwIfAborted()
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const registry = opts.registry ?? buildDefaultAnalystRegistry({
    ...(opts.engine ? { engine: opts.engine } : {}),
    registry: { log: opts.log },
  })
  const runId = opts.runId ?? `traces-store-investigation-${Date.parse(generatedAt) || Date.now()}`
  const analystResult = await registry.run(runId, { traceStore: opts.traceStore }, {
    budget: opts.budgetUsd != null ? { totalUsd: opts.budgetUsd } : undefined,
    chainFindings: true,
    signal: opts.signal,
  })
  opts.signal?.throwIfAborted()
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
