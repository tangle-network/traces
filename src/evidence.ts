import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ATTR } from './attributes.js'
import type { OtlpSpan } from './otlp.js'
import { runPipelines } from './pipelines.js'
import { type ScanOptions, scanSessions } from './session-source.js'
import type { SessionRef } from './types.js'

export interface PolicyEvidenceToolSummary {
  readonly name: string
  readonly calls: number
  readonly errors: number
}

export interface PolicyEvidenceLoopSummary {
  readonly toolName: string
  readonly occurrences: number
}

export interface PolicyEvidenceRecord {
  readonly schemaVersion: 1
  readonly kind: 'traces.policy_evidence.session'
  readonly generatedAt: string
  readonly session: {
    readonly harness: string
    readonly sessionId: string
    readonly path: string
    readonly cwd: string | null
    readonly mtimeMs: number
  }
  readonly repo: {
    readonly subjectKey?: string
    readonly repository?: string
    readonly branch?: string
    readonly commit?: string
    readonly cwd?: string
    readonly resolutionSource?: string
  }
  readonly metrics: {
    readonly spanCount: number
    readonly llmTurnCount: number
    readonly toolCallCount: number
    readonly erroredToolCallCount: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly models: readonly string[]
    readonly tools: readonly PolicyEvidenceToolSummary[]
    readonly firstSpanAt: string | null
    readonly lastSpanAt: string | null
  }
  readonly signals: {
    readonly stuckLoopCount: number
    readonly affectedRunRatio: number
    readonly stuckLoops: readonly PolicyEvidenceLoopSummary[]
    readonly stuckLoopsOmitted: number
    readonly toolErrorRate: number
  }
  readonly provenance: {
    readonly source: 'traces'
    readonly evidenceKind: 'session-summary'
    readonly otlpPath?: string
    readonly notCampaignCell: true
    readonly note: string
  }
}

export interface BuildPolicyEvidenceOptions {
  readonly generatedAt?: string
  readonly minLoopOccurrences?: number
  readonly maxLoopExamples?: number
  readonly otlpPath?: string
}

export interface CollectPolicyEvidenceOptions extends ScanOptions, BuildPolicyEvidenceOptions {}

function stringAttr(span: OtlpSpan, key: string): string | undefined {
  const value = span.attributes[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberAttr(span: OtlpSpan, key: string): number {
  const value = span.attributes[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function spanKind(span: OtlpSpan): string | undefined {
  return stringAttr(span, 'openinference.span.kind')
}

function repoFromSpans(spans: readonly OtlpSpan[]): PolicyEvidenceRecord['repo'] {
  const attrs: {
    subjectKey?: string
    repository?: string
    branch?: string
    commit?: string
    cwd?: string
    resolutionSource?: string
  } = {}
  for (const span of spans) {
    attrs.subjectKey ??= stringAttr(span, ATTR.SUBJECT_KEY)
    attrs.repository ??= stringAttr(span, ATTR.GIT_REPOSITORY)
    attrs.branch ??= stringAttr(span, ATTR.GIT_BRANCH_NAME)
    attrs.commit ??= stringAttr(span, ATTR.GIT_COMMIT)
    attrs.cwd ??= stringAttr(span, ATTR.CWD)
    attrs.resolutionSource ??= stringAttr(span, ATTR.REPO_RESOLUTION_SOURCE)
    if (attrs.subjectKey && attrs.repository && attrs.branch && attrs.commit && attrs.cwd && attrs.resolutionSource) break
  }
  return attrs
}

function timeBounds(spans: readonly OtlpSpan[]): { firstSpanAt: string | null; lastSpanAt: string | null } {
  const times = spans
    .flatMap((span) => [span.start_time, span.end_time])
    .filter((value) => value && value !== 'now')
    .sort()
  return {
    firstSpanAt: times[0] ?? null,
    lastSpanAt: times[times.length - 1] ?? null,
  }
}

function summarizeTools(spans: readonly OtlpSpan[]): PolicyEvidenceToolSummary[] {
  const byTool = new Map<string, { calls: number; errors: number }>()
  for (const span of spans) {
    if (spanKind(span) !== 'TOOL') continue
    const name = stringAttr(span, 'tool.name') ?? span.name.replace(/^tool\./, '')
    const current = byTool.get(name) ?? { calls: 0, errors: 0 }
    current.calls += 1
    if (span.status.code === 'ERROR') current.errors += 1
    byTool.set(name, current)
  }
  return [...byTool.entries()]
    .map(([name, row]) => ({ name, calls: row.calls, errors: row.errors }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
}

export async function buildPolicyEvidenceRecord(
  ref: SessionRef,
  spans: readonly OtlpSpan[],
  opts: BuildPolicyEvidenceOptions = {},
): Promise<PolicyEvidenceRecord> {
  const llmSpans = spans.filter((span) => spanKind(span) === 'LLM')
  const toolSpans = spans.filter((span) => spanKind(span) === 'TOOL')
  const erroredToolCallCount = toolSpans.filter((span) => span.status.code === 'ERROR').length
  const pipelines = await runPipelines(spans, { minLoopOccurrences: opts.minLoopOccurrences })
  const loopLimit = opts.maxLoopExamples ?? 25
  const loopFindings = pipelines.stuckLoops.findings
  const { firstSpanAt, lastSpanAt } = timeBounds(spans)
  const repo = repoFromSpans(spans)
  return {
    schemaVersion: 1,
    kind: 'traces.policy_evidence.session',
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    session: {
      harness: ref.harness,
      sessionId: ref.sessionId,
      path: ref.path,
      cwd: repo.cwd ?? ref.cwd,
      mtimeMs: ref.mtimeMs,
    },
    repo,
    metrics: {
      spanCount: spans.length,
      llmTurnCount: llmSpans.length,
      toolCallCount: toolSpans.length,
      erroredToolCallCount,
      inputTokens: llmSpans.reduce((sum, span) => sum + numberAttr(span, 'llm.input_tokens'), 0),
      outputTokens: llmSpans.reduce((sum, span) => sum + numberAttr(span, 'llm.output_tokens'), 0),
      models: [...new Set(llmSpans.map((span) => stringAttr(span, 'llm.model_name')).filter((value): value is string => Boolean(value)))].sort(),
      tools: summarizeTools(spans),
      firstSpanAt,
      lastSpanAt,
    },
    signals: {
      stuckLoopCount: loopFindings.length,
      affectedRunRatio: pipelines.stuckLoops.affectedRunRatio,
      stuckLoops: loopFindings.slice(0, loopLimit).map((finding) => ({
        toolName: finding.toolName,
        occurrences: finding.occurrences,
      })),
      stuckLoopsOmitted: Math.max(0, loopFindings.length - loopLimit),
      toolErrorRate: toolSpans.length === 0 ? 0 : erroredToolCallCount / toolSpans.length,
    },
    provenance: {
      source: 'traces',
      evidenceKind: 'session-summary',
      ...(opts.otlpPath ? { otlpPath: opts.otlpPath } : {}),
      notCampaignCell: true,
      note: 'This is normalized coding-agent session evidence for downstream policy mining; it is not an eval campaign cell.',
    },
  }
}

export async function collectPolicyEvidence(opts: CollectPolicyEvidenceOptions): Promise<PolicyEvidenceRecord[]> {
  const records: PolicyEvidenceRecord[] = []
  for await (const session of scanSessions(opts)) {
    records.push(await buildPolicyEvidenceRecord(session.ref, session.spans, opts))
  }
  return records
}

export function serializePolicyEvidence(records: readonly PolicyEvidenceRecord[]): string {
  if (records.length === 0) return ''
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

export async function writePolicyEvidenceFile(records: readonly PolicyEvidenceRecord[], outPath?: string): Promise<string> {
  const path = outPath ?? join(await mkdtemp(join(tmpdir(), 'traces-evidence-')), 'policy-evidence.jsonl')
  await writeFile(path, serializePolicyEvidence(records), 'utf8')
  return path
}
