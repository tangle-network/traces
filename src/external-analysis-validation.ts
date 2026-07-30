import type { AnalystFinding } from '@tangle-network/agent-eval/analyst'
import type {
  ExternalAnalysisPayload,
  ExternalAnalysisResult,
  ExternalDiscoveryCandidate,
} from './external.js'

type UnknownRecord = Record<string, unknown>

const FINDING_KEYS = new Set([
  'schema_version',
  'finding_id',
  'analyst_id',
  'produced_at',
  'severity',
  'area',
  'claim',
  'rationale',
  'evidence_refs',
  'recommended_action',
  'validation_plan',
  'confidence',
  'subject',
  'derived_from_judge',
  'metadata',
])
const EVIDENCE_KEYS = new Set(['kind', 'uri', 'excerpt'])
const CANDIDATE_KEYS = new Set([
  'engine',
  'engineVersion',
  'status',
  'group',
  'rank',
  'groupSize',
  'traceId',
  'spanId',
  'evidenceUri',
  'summary',
  'actionText',
  'metadata',
])
const PAYLOAD_REPORT_KEYS = new Set(['kind'])
const PAYLOAD_FINDING_KEYS = new Set(['kind', 'findings'])
const PAYLOAD_DISCOVERY_KEYS = new Set(['kind', 'candidates'])
const RESULT_FAILURE_KEYS = new Set(['analyzer', 'kind', 'ok', 'output', 'error'])
const RESULT_REPORT_KEYS = new Set(['analyzer', 'kind', 'ok', 'output'])
const RESULT_FINDING_KEYS = new Set(['analyzer', 'kind', 'ok', 'output', 'findings'])
const RESULT_DISCOVERY_KEYS = new Set(['analyzer', 'kind', 'ok', 'output', 'candidates'])

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as UnknownRecord
}

function assertOnlyKeys(value: UnknownRecord, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unexpected field '${key}'`)
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  return value
}

function nonEmptyString(value: unknown, label: string): string {
  const decoded = text(value, label)
  if (decoded.length === 0) throw new TypeError(`${label} must be a non-empty string`)
  return decoded
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label)
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`)
  }
  return value as number
}

function optionalRecord(
  value: unknown,
  label: string,
): Record<string, unknown> | undefined {
  return value === undefined ? undefined : record(value, label)
}

export function spanEvidenceUri(traceId: string, spanId: string): string {
  return `trace://${encodeURIComponent(traceId)}/span/${encodeURIComponent(spanId)}`
}

function validateSpanEvidence(
  uri: string,
  knownSpanUris: ReadonlySet<string> | undefined,
  label: string,
): void {
  if (knownSpanUris && !knownSpanUris.has(uri)) {
    throw new TypeError(`${label} references unknown span evidence URI '${uri}'`)
  }
}

function decodeEvidenceRef(
  value: unknown,
  label: string,
  knownSpanUris?: ReadonlySet<string>,
): AnalystFinding['evidence_refs'][number] {
  const ref = record(value, label)
  assertOnlyKeys(ref, EVIDENCE_KEYS, label)
  const kind = nonEmptyString(ref.kind, `${label}.kind`)
  if (!['span', 'event', 'artifact', 'finding', 'metric'].includes(kind)) {
    throw new TypeError(`${label}.kind is unsupported`)
  }
  const uri = nonEmptyString(ref.uri, `${label}.uri`)
  if (kind === 'span') validateSpanEvidence(uri, knownSpanUris, label)
  const excerpt = optionalString(ref.excerpt, `${label}.excerpt`)
  return {
    kind: kind as AnalystFinding['evidence_refs'][number]['kind'],
    uri,
    ...(excerpt === undefined ? {} : { excerpt }),
  }
}

function decodeFinding(
  value: unknown,
  label: string,
  knownSpanUris?: ReadonlySet<string>,
): AnalystFinding {
  const finding = record(value, label)
  assertOnlyKeys(finding, FINDING_KEYS, label)
  if (finding.schema_version !== '1.0.0') {
    throw new TypeError(`${label}.schema_version must be '1.0.0'`)
  }
  const findingId = nonEmptyString(finding.finding_id, `${label}.finding_id`)
  const analystId = nonEmptyString(finding.analyst_id, `${label}.analyst_id`)
  const producedAt = nonEmptyString(finding.produced_at, `${label}.produced_at`)
  if (!Number.isFinite(Date.parse(producedAt))) {
    throw new TypeError(`${label}.produced_at must be a valid timestamp`)
  }
  const severity = nonEmptyString(finding.severity, `${label}.severity`)
  if (!['critical', 'high', 'medium', 'low', 'info'].includes(severity)) {
    throw new TypeError(`${label}.severity is unsupported`)
  }
  if (!Array.isArray(finding.evidence_refs)) {
    throw new TypeError(`${label}.evidence_refs must be an array`)
  }
  if (
    typeof finding.confidence !== 'number' ||
    !Number.isFinite(finding.confidence) ||
    finding.confidence < 0 ||
    finding.confidence > 1
  ) {
    throw new TypeError(`${label}.confidence must be a finite number from 0 to 1`)
  }
  const rationale = optionalString(finding.rationale, `${label}.rationale`)
  const recommendedAction = optionalString(
    finding.recommended_action,
    `${label}.recommended_action`,
  )
  const validationPlan = optionalString(finding.validation_plan, `${label}.validation_plan`)
  const subject = optionalString(finding.subject, `${label}.subject`)
  const derivedFromJudge = finding.derived_from_judge === undefined
    ? undefined
    : boolean(finding.derived_from_judge, `${label}.derived_from_judge`)
  const metadata = optionalRecord(finding.metadata, `${label}.metadata`)
  return {
    schema_version: '1.0.0',
    finding_id: findingId,
    analyst_id: analystId,
    produced_at: producedAt,
    severity: severity as AnalystFinding['severity'],
    area: nonEmptyString(finding.area, `${label}.area`),
    claim: nonEmptyString(finding.claim, `${label}.claim`),
    evidence_refs: finding.evidence_refs.map((ref, index) =>
      decodeEvidenceRef(ref, `${label}.evidence_refs[${index}]`, knownSpanUris)),
    confidence: finding.confidence,
    ...(rationale === undefined ? {} : { rationale }),
    ...(recommendedAction === undefined ? {} : { recommended_action: recommendedAction }),
    ...(validationPlan === undefined ? {} : { validation_plan: validationPlan }),
    ...(subject === undefined ? {} : { subject }),
    ...(derivedFromJudge === undefined ? {} : { derived_from_judge: derivedFromJudge }),
    ...(metadata === undefined ? {} : { metadata }),
  }
}

function decodeCandidate(
  value: unknown,
  label: string,
  knownSpanUris?: ReadonlySet<string>,
): ExternalDiscoveryCandidate {
  const candidate = record(value, label)
  assertOnlyKeys(candidate, CANDIDATE_KEYS, label)
  if (candidate.status !== 'needs_review') {
    throw new TypeError(`${label}.status must be 'needs_review'`)
  }
  const traceId = nonEmptyString(candidate.traceId, `${label}.traceId`)
  const spanId = nonEmptyString(candidate.spanId, `${label}.spanId`)
  const evidenceUri = nonEmptyString(candidate.evidenceUri, `${label}.evidenceUri`)
  if (evidenceUri !== spanEvidenceUri(traceId, spanId)) {
    throw new TypeError(`${label}.evidenceUri does not match its traceId and spanId`)
  }
  validateSpanEvidence(evidenceUri, knownSpanUris, label)
  const metadata = optionalRecord(candidate.metadata, `${label}.metadata`)
  return {
    engine: nonEmptyString(candidate.engine, `${label}.engine`),
    engineVersion: nonEmptyString(candidate.engineVersion, `${label}.engineVersion`),
    status: 'needs_review',
    group: nonEmptyString(candidate.group, `${label}.group`),
    rank: integer(candidate.rank, `${label}.rank`, 0),
    groupSize: integer(candidate.groupSize, `${label}.groupSize`, 1),
    traceId,
    spanId,
    evidenceUri,
    summary: nonEmptyString(candidate.summary, `${label}.summary`),
    actionText: nonEmptyString(candidate.actionText, `${label}.actionText`),
    ...(metadata === undefined ? {} : { metadata }),
  }
}

export function decodeExternalAnalysisPayload(value: unknown): ExternalAnalysisPayload {
  const payload = record(value, 'external analyzer payload')
  const kind = nonEmptyString(payload.kind, 'external analyzer payload.kind')
  if (kind === 'report') {
    assertOnlyKeys(payload, PAYLOAD_REPORT_KEYS, 'external analyzer payload')
    return { kind }
  }
  if (kind === 'findings') {
    assertOnlyKeys(payload, PAYLOAD_FINDING_KEYS, 'external analyzer payload')
    if (!Array.isArray(payload.findings)) {
      throw new TypeError('external analyzer payload.findings must be an array')
    }
    return {
      kind,
      findings: payload.findings.map((finding, index) =>
        decodeFinding(finding, `external analyzer payload.findings[${index}]`)),
    }
  }
  if (kind === 'discovery') {
    assertOnlyKeys(payload, PAYLOAD_DISCOVERY_KEYS, 'external analyzer payload')
    if (!Array.isArray(payload.candidates)) {
      throw new TypeError('external analyzer payload.candidates must be an array')
    }
    return {
      kind,
      candidates: payload.candidates.map((candidate, index) =>
        decodeCandidate(candidate, `external analyzer payload.candidates[${index}]`)),
    }
  }
  throw new TypeError(`external analyzer payload.kind '${kind}' is unsupported`)
}

export function decodeExternalAnalysisResult(
  value: unknown,
  analyzerName: string,
  knownSpanUris?: ReadonlySet<string>,
): ExternalAnalysisResult {
  const label = `external analyzer '${analyzerName}' result`
  const result = record(value, label)
  const reportedAnalyzer = nonEmptyString(result.analyzer, `${label}.analyzer`)
  if (reportedAnalyzer !== analyzerName) {
    throw new TypeError(
      `external analyzer '${analyzerName}' reported analyzer '${reportedAnalyzer}'`,
    )
  }
  const kind = nonEmptyString(result.kind, `${label}.kind`)
  if (!['report', 'findings', 'discovery'].includes(kind)) {
    throw new TypeError(`${label}.kind '${kind}' is unsupported`)
  }
  const ok = boolean(result.ok, `${label}.ok`)
  const output = text(result.output, `${label}.output`)
  if (!ok) {
    assertOnlyKeys(result, RESULT_FAILURE_KEYS, label)
    return {
      analyzer: analyzerName,
      kind: kind as ExternalAnalysisResult['kind'],
      ok: false,
      output,
      error: nonEmptyString(result.error, `${label}.error`),
    }
  }
  if (kind === 'report') {
    assertOnlyKeys(result, RESULT_REPORT_KEYS, label)
    return { analyzer: analyzerName, kind, ok: true, output }
  }
  if (kind === 'findings') {
    assertOnlyKeys(result, RESULT_FINDING_KEYS, label)
    if (!Array.isArray(result.findings)) {
      throw new TypeError(`${label}.findings must be an array`)
    }
    return {
      analyzer: analyzerName,
      kind,
      ok: true,
      output,
      findings: result.findings.map((finding, index) =>
        decodeFinding(finding, `${label}.findings[${index}]`, knownSpanUris)),
    }
  }
  assertOnlyKeys(result, RESULT_DISCOVERY_KEYS, label)
  if (!Array.isArray(result.candidates)) {
    throw new TypeError(`${label}.candidates must be an array`)
  }
  return {
    analyzer: analyzerName,
    kind: 'discovery',
    ok: true,
    output,
    candidates: result.candidates.map((candidate, index) =>
      decodeCandidate(candidate, `${label}.candidates[${index}]`, knownSpanUris)),
  }
}
