import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionReport } from '@tangle-network/agent-eval/contract'
import {
  OPENINFERENCE_SPAN_KIND,
  TOOL_NAME,
} from '@tangle-network/agent-eval/trace-attributes'
import { ATTR } from './attributes.js'
import { summarizeSpanExecution } from './execution.js'
import type { OtlpSpan } from './otlp.js'
import { runPipelines } from './pipelines.js'
import { type ScanOptions, scanSessions } from './session-source.js'
import { describeSessionRelationship, type SessionRole } from './session-relationship.js'
import type { SessionRef } from './types.js'

/**
 * The one sentence of prose every policy-evidence record carries. It is the
 * same for every session, so a content check that compares an evidence file
 * against a transcript must subtract it: a session that reads or writes this
 * package's source would otherwise look like it leaked its own text.
 */
export const POLICY_EVIDENCE_NOTE =
  'This is normalized coding-agent session evidence for downstream policy mining; it is not an eval campaign cell.'

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
  readonly execution: ExecutionReport
  readonly session: {
    readonly harness: string
    readonly sessionId: string
    readonly path: string
    readonly cwd: string | null
    readonly mtimeMs: number
    readonly role?: SessionRole
    readonly parentSessionId?: string
    readonly childSessionIds?: readonly string[]
    readonly depth?: number
    readonly agentNickname?: string
    readonly agentRole?: string
    readonly agentPath?: string
    readonly taskScope?: 'all' | 'latest' | 'turn' | 'fork-current'
    readonly turnId?: string
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
    /** SHA-256 of the stable explicit session file consumed by the CLI. */
    readonly sourceSha256?: string
    readonly notCampaignCell: true
    readonly note: string
  }
}

export interface BuildPolicyEvidenceOptions {
  readonly generatedAt?: string
  readonly minLoopOccurrences?: number
  readonly maxLoopExamples?: number
  readonly otlpPath?: string
  /** SHA-256 of the exact stable source bytes used to produce this record. */
  readonly sourceSha256?: string
}

export interface CollectPolicyEvidenceOptions extends ScanOptions, BuildPolicyEvidenceOptions {}

function stringAttr(span: OtlpSpan, key: string): string | undefined {
  const value = span.attributes[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function spanKind(span: OtlpSpan): string | undefined {
  return stringAttr(span, OPENINFERENCE_SPAN_KIND)
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
    const name = stringAttr(span, TOOL_NAME) ?? span.name.replace(/^tool\./, '')
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
  if (opts.sourceSha256 && !/^[a-f0-9]{64}$/.test(opts.sourceSha256)) {
    throw new Error('sourceSha256 must be a lowercase SHA-256 hex digest')
  }
  const toolSpans = spans.filter((span) => spanKind(span) === 'TOOL')
  const erroredToolCallCount = toolSpans.filter((span) => span.status.code === 'ERROR').length
  const pipelines = await runPipelines(spans, { minLoopOccurrences: opts.minLoopOccurrences })
  const loopLimit = opts.maxLoopExamples ?? 25
  const loopFindings = pipelines.stuckLoops.findings
  const { firstSpanAt, lastSpanAt } = timeBounds(spans)
  const repo = repoFromSpans(spans)
  const relationship = describeSessionRelationship(ref, spans)
  const execution = summarizeSpanExecution(spans, {
    experimentId: `traces-policy-evidence:${ref.sessionId}`,
  })
  return {
    schemaVersion: 1,
    kind: 'traces.policy_evidence.session',
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    execution,
    session: {
      harness: ref.harness,
      sessionId: ref.sessionId,
      path: ref.path,
      cwd: repo.cwd ?? ref.cwd,
      mtimeMs: ref.mtimeMs,
      role: relationship.role,
      childSessionIds: relationship.childSessionIds,
      ...(relationship.parentSessionId ? { parentSessionId: relationship.parentSessionId } : {}),
      ...(relationship.depth !== undefined ? { depth: relationship.depth } : {}),
      ...(relationship.agentNickname ? { agentNickname: relationship.agentNickname } : {}),
      ...(relationship.agentRole ? { agentRole: relationship.agentRole } : {}),
      ...(relationship.agentPath ? { agentPath: relationship.agentPath } : {}),
      ...(relationship.taskScope ? { taskScope: relationship.taskScope } : {}),
      ...(relationship.turnId ? { turnId: relationship.turnId } : {}),
    },
    repo,
    metrics: {
      spanCount: spans.length,
      llmTurnCount: execution.execution.modelCalls.events,
      toolCallCount: toolSpans.length,
      erroredToolCallCount,
      inputTokens: execution.execution.tokenUsage.totals.input,
      outputTokens: execution.execution.tokenUsage.totals.output,
      models: execution.execution.models.map(({ model }) => model),
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
      ...(opts.sourceSha256 ? { sourceSha256: opts.sourceSha256 } : {}),
      notCampaignCell: true,
      note: POLICY_EVIDENCE_NOTE,
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
