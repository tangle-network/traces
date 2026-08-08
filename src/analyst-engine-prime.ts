/**
 * Prime analyst engine — a bundled {@link ExternalAnalyzer} that runs a
 * one-shot RLM over the OTLP-JSONL artifact through an OpenAI-compatible
 * bridge (cli-bridge's prime backend, or any `/v1/chat/completions` endpoint).
 *
 * Protocol, in one pass with no tools:
 *   1. The FULL span projection is inlined into the prompt as JSON — prime has
 *      no REPL and no trace tools, so unlike the dspy-rlm analysts (which
 *      drill via viewSpans/searchTrace) every fact must travel in the prompt.
 *   2. The reply contract is one fenced ```json block of SHORT strings
 *      (long strings get corrupted in transport), citing span ids verbatim.
 *   3. A structurally malformed reply gets ONE bounded stateless repair turn
 *      carrying the malformed reply plus the contract — never the trajectory —
 *      mirroring the typed-adapter repair the dspy arm gets, so both arms face
 *      the same structured-output affordance.
 *   4. Cited span ids are resolved against the artifact; rows citing unknown
 *      or ambiguous ids are rejected with a recorded reason, never guessed.
 *      Zero findings from a well-formed reply is an honest null, not an error.
 *
 * Oversized traces: when the rendered projection exceeds the inline budget it
 * is re-rendered with a per-attribute character cap (the prompt-side analog of
 * the trace store's per-attribute byte cap); if still oversized the run fails
 * loud — inline delivery is the only delivery, so silently dropping spans
 * would understate the trajectory. The delivery decision is recorded in the
 * result output.
 *
 * Usage (bridge-reported token counts and call count) is recorded in the
 * result output; cost stays uncaptured because the bridge reports no priced
 * cost and this adapter carries no pricing table.
 */

import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AnalystFinding } from '@tangle-network/agent-eval/analyst'
import { spanEvidenceUri } from './external-analysis-validation.js'
import type { ExternalAnalysisResult, ExternalAnalyzer, ExternalAnalyzerOptions } from './external.js'
import { readJsonl } from './jsonl.js'

const DEFAULT_BRIDGE_URL = 'http://localhost:4181'
const DEFAULT_MODEL = 'prime/zai/glm-5.2'
const DEFAULT_TIMEOUT_MS = 1_200_000
const DEFAULT_MAX_INLINE_CHARS = 360_000
const DEFAULT_PER_ATTRIBUTE_CHAR_CAP = 1_200
const DEFAULT_QUESTION =
  'Diagnose this trajectory: identify concrete agent failures, wasted work, and unsupported claims.'
const MAX_FINDINGS = 10
const MAX_SPAN_IDS_PER_FINDING = 8
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info'])
const ANALYST_ID = 'prime'

export interface PrimeTransportRequest {
  url: string
  body: { model: string; messages: Array<{ role: 'user'; content: string }> }
  /** Aborts on the analyzer's deadline AND the caller's signal. */
  signal: AbortSignal
}

export interface PrimeTransportResponse {
  status: number
  text: string
}

/** POSTs one JSON chat completion; injectable so tests run on a fake bridge. */
export type PrimeTransport = (req: PrimeTransportRequest) => Promise<PrimeTransportResponse>

export interface PrimeAnalyzerOptions {
  /** Bridge ROOT url; the adapter calls `<root>/v1/chat/completions`.
   *  Default: TRACES_PRIME_BRIDGE_URL, then http://localhost:4181. */
  bridgeUrl?: string
  /** Model id the bridge routes on. Default: TRACES_PRIME_MODEL, then prime/zai/glm-5.2. */
  model?: string
  /** Per-call deadline. Default: TRACES_PRIME_TIMEOUT_MS, then 1200000 (20 min —
   *  prime runs legitimately exceed 5 minutes). */
  timeoutMs?: number
  /** Question asked when the caller passes no prompt. */
  defaultPrompt?: string
  /** Rendered-projection budget before the per-attribute cap kicks in. */
  maxInlineChars?: number
  /** Character cap applied to each attribute on the oversized re-render. */
  perAttributeCharCap?: number
  /** Disable the bounded repair turn (one extra call on a malformed reply). */
  repair?: boolean
  transport?: PrimeTransport
}

interface PrimeUsage {
  calls: number | null
  tokens: { input: number | null; output: number | null } | null
  estimated: boolean
}

interface ProjectionDelivery {
  mode: 'inline-json'
  perAttributeCharCap: number | null
  renderedChars: number
}

interface ArtifactProjection {
  rows: Array<Record<string, unknown>>
  rendered: string
  delivery: ProjectionDelivery
  traceCount: number
  /** span_id → every trace_id it appears under; >1 entry marks an ambiguous id. */
  spanTraces: Map<string, Set<string>>
}

interface FindingRow {
  spanIds: string[]
  severity: AnalystFinding['severity']
  area: string
  claim: string
  action?: string
  confidence: number
}

function positiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer, got '${raw}'`)
  }
  return value
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeUsage(raw: unknown): PrimeUsage {
  if (!raw || typeof raw !== 'object') return { calls: null, tokens: null, estimated: false }
  const usage = raw as Record<string, unknown>
  const input = finiteOrNull(usage.prompt_tokens)
  const output = finiteOrNull(usage.completion_tokens)
  return {
    calls: finiteOrNull(usage.model_requests),
    tokens: input === null && output === null ? null : { input, output },
    estimated: usage.estimated === true,
  }
}

/** Sum two usage receipts; a side with uncaptured counts poisons the sum to
 *  uncaptured rather than silently under-reporting. */
function mergeUsage(a: PrimeUsage, b: PrimeUsage): PrimeUsage {
  const calls = a.calls !== null && b.calls !== null ? a.calls + b.calls : null
  const tokens =
    a.tokens !== null && b.tokens !== null &&
    a.tokens.input !== null && b.tokens.input !== null &&
    a.tokens.output !== null && b.tokens.output !== null
      ? { input: a.tokens.input + b.tokens.input, output: a.tokens.output + b.tokens.output }
      : null
  return { calls, tokens, estimated: a.estimated || b.estimated }
}

function renderUsage(usage: PrimeUsage): string {
  const calls = usage.calls === null ? 'uncaptured' : String(usage.calls)
  const input = usage.tokens?.input ?? 'uncaptured'
  const output = usage.tokens?.output ?? 'uncaptured'
  const estimated = usage.estimated ? ' (bridge-estimated)' : ''
  return `usage: calls=${calls} input_tokens=${input} output_tokens=${output}${estimated}; cost=uncaptured (no pricing table)`
}

function capAttributeValue(value: unknown, cap: number): unknown {
  const rendered = JSON.stringify(value)
  if (rendered === undefined || rendered.length <= cap) return value
  if (typeof value === 'string') return `${value.slice(0, cap)}…[truncated ${value.length - cap} chars]`
  return `[omitted non-string attribute: ${rendered.length} JSON chars]`
}

function capRowAttributes(row: Record<string, unknown>, cap: number): Record<string, unknown> {
  const attributes = row.attributes
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return row
  const capped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attributes as Record<string, unknown>)) {
    capped[key] = capAttributeValue(value, cap)
  }
  return { ...row, attributes: capped }
}

async function projectArtifact(
  otlpPath: string,
  maxInlineChars: number,
  perAttributeCharCap: number,
  signal?: AbortSignal,
): Promise<ArtifactProjection> {
  const rows: Array<Record<string, unknown>> = []
  const spanTraces = new Map<string, Set<string>>()
  let index = 0
  for await (const value of readJsonl<unknown>(otlpPath, { signal })) {
    const label = `${otlpPath}:${index + 1}`
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`${label} must contain an object`)
    }
    const row = value as Record<string, unknown>
    if (typeof row.trace_id !== 'string' || row.trace_id.length === 0) {
      throw new TypeError(`${label}.trace_id must be a non-empty string`)
    }
    if (typeof row.span_id !== 'string' || row.span_id.length === 0) {
      throw new TypeError(`${label}.span_id must be a non-empty string`)
    }
    rows.push(row)
    const traces = spanTraces.get(row.span_id) ?? new Set<string>()
    traces.add(row.trace_id)
    spanTraces.set(row.span_id, traces)
    index += 1
  }
  if (rows.length === 0) throw new Error(`${otlpPath} contains no spans`)
  const traceCount = new Set(rows.map((row) => row.trace_id as string)).size

  let projected = rows
  let rendered = JSON.stringify(projected)
  const delivery: ProjectionDelivery = {
    mode: 'inline-json',
    perAttributeCharCap: null,
    renderedChars: rendered.length,
  }
  if (rendered.length > maxInlineChars) {
    projected = rows.map((row) => capRowAttributes(row, perAttributeCharCap))
    rendered = JSON.stringify(projected)
    delivery.perAttributeCharCap = perAttributeCharCap
    delivery.renderedChars = rendered.length
  }
  if (rendered.length > maxInlineChars) {
    throw new Error(
      `trajectory renders to ${rendered.length} chars even at per-attribute cap ` +
        `${perAttributeCharCap} (budget ${maxInlineChars}); inline delivery impossible`,
    )
  }
  return { rows: projected, rendered, delivery, traceCount, spanTraces }
}

const OUTPUT_CONTRACT_LINES = [
  'OUTPUT CONTRACT (you have no trace tools and no REPL):',
  'You are a one-shot analyst. Every fact you need is in the TRAJECTORY JSON below.',
  'Do not run shell commands, do not read or write files, do not use any tools.',
  'Reply with EXACTLY one fenced ```json code block and no other fenced block. The JSON object has exactly two fields:',
  '  "answer": string — ONE short sentence (max 300 chars) summarizing your verdict.',
  '  "findings": array (possibly empty) of finding rows, each exactly:',
  '    {"span_ids": [string, ...],',
  '     "severity": "critical"|"high"|"medium"|"low"|"info",',
  '     "area": string (short kebab-case topic, max 40 chars),',
  '     "claim": string (ONE short sentence, max 200 chars),',
  '     "action": string (optional, ONE short imperative sentence, max 200 chars),',
  '     "confidence": number 0..1}',
  'Do NOT include a rationale field. Keep every string SHORT — long strings get corrupted in transport and void your work.',
  `Report at most ${MAX_FINDINGS} findings; a finding cites 1..${MAX_SPAN_IDS_PER_FINDING} span_ids, each copied VERBATIM from a span in the trajectory below.`,
  '"findings" is [] only for a clean trajectory.',
]

function buildPrompt(question: string, projection: ArtifactProjection): string {
  return [
    `QUESTION: ${question}`,
    '',
    ...OUTPUT_CONTRACT_LINES,
    '',
    `TRAJECTORY (${projection.traceCount} trace(s); ${projection.rows.length} spans; full OpenInference span projection as JSON):`,
    projection.rendered,
  ].join('\n')
}

function buildRepairPrompt(parseDefect: string, previousReply: string): string {
  return [
    'Your previous reply to a trace-analysis task was structurally malformed and could not be parsed',
    `(${parseDefect}). Below is your previous reply verbatim. Re-emit ONLY the corrected JSON — one`,
    'fenced ```json block, no other text, no tools. The JSON object has exactly two fields:',
    '  "answer": string (ONE short sentence, max 300 chars)',
    '  "findings": array (possibly empty) of {"span_ids": [string, ...],',
    '   "severity": "critical"|"high"|"medium"|"low"|"info", "area": string (max 40 chars),',
    '   "claim": string (max 200 chars), "action": string (optional, max 200 chars), "confidence": number 0..1}',
    'No rationale field. Keep every string SHORT. Preserve the span ids and verdicts of your previous reply exactly; shorten prose freely.',
    '',
    'PREVIOUS REPLY:',
    previousReply,
  ].join('\n')
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text.trim())
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const direct = tryParseObject(text)
  if (direct) return direct
  const fenced = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)]
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    const candidate = tryParseObject(fenced[i]![1]!)
    if (candidate) return candidate
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const candidate = tryParseObject(text.slice(start, end + 1))
    if (candidate) return candidate
  }
  return null
}

function parseDefectOf(parsed: Record<string, unknown> | null): string | null {
  if (parsed === null) return 'no parseable JSON object'
  if (!Array.isArray(parsed.findings)) return 'JSON has no "findings" array'
  return null
}

function findingRowDefect(row: unknown, spanTraces: ReadonlyMap<string, Set<string>>): string | FindingRow {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'row is not an object'
  const record = row as Record<string, unknown>
  if (!Array.isArray(record.span_ids) || record.span_ids.length === 0) {
    return 'span_ids must be a non-empty array'
  }
  const spanIds: string[] = []
  for (const id of record.span_ids) {
    if (typeof id !== 'string' || id.length === 0) return 'span_ids must contain non-empty strings'
    const traces = spanTraces.get(id)
    if (!traces) return `span_id '${id}' is not in the trajectory`
    if (traces.size > 1) return `span_id '${id}' is ambiguous across ${traces.size} traces`
    if (!spanIds.includes(id)) spanIds.push(id)
  }
  // The contract says 1..MAX; enforce it on the deduplicated list so repeated
  // ids neither dodge the cap nor trip it spuriously.
  if (spanIds.length > MAX_SPAN_IDS_PER_FINDING) {
    return `span_ids cites ${spanIds.length} distinct spans (cap ${MAX_SPAN_IDS_PER_FINDING})`
  }
  if (typeof record.severity !== 'string' || !SEVERITIES.has(record.severity)) {
    return 'severity outside the analyst severity enum'
  }
  if (typeof record.area !== 'string' || record.area.trim().length === 0 || record.area.length > 200) {
    return 'area must be a 1-200 char string'
  }
  if (typeof record.claim !== 'string' || record.claim.trim().length === 0 || record.claim.length > 2000) {
    return 'claim must be a 1-2000 char string'
  }
  if (
    record.action !== undefined &&
    (typeof record.action !== 'string' || record.action.trim().length === 0 || record.action.length > 2000)
  ) {
    return 'action must be a 1-2000 char string when present'
  }
  if (
    typeof record.confidence !== 'number' ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  ) {
    return 'confidence must be 0..1'
  }
  return {
    spanIds,
    severity: record.severity as AnalystFinding['severity'],
    area: record.area.trim(),
    claim: record.claim.trim(),
    ...(typeof record.action === 'string' ? { action: record.action.trim() } : {}),
    confidence: record.confidence,
  }
}

function toAnalystFinding(
  row: FindingRow,
  index: number,
  spanTraces: ReadonlyMap<string, Set<string>>,
  model: string,
  producedAt: string,
): AnalystFinding {
  const uris = row.spanIds.map((spanId) => {
    const traces = spanTraces.get(spanId)!
    return spanEvidenceUri([...traces][0]!, spanId)
  })
  const findingId = `prime-${createHash('sha256')
    .update(`${index}\n${row.claim}\n${uris.join('\n')}`)
    .digest('hex')
    .slice(0, 12)}`
  return {
    schema_version: '1.0.0',
    finding_id: findingId,
    analyst_id: ANALYST_ID,
    produced_at: producedAt,
    severity: row.severity,
    area: row.area,
    claim: row.claim,
    evidence_refs: uris.map((uri) => ({ kind: 'span', uri })),
    confidence: row.confidence,
    ...(row.action ? { recommended_action: row.action } : {}),
    metadata: { engine: ANALYST_ID, model },
  }
}

/** Default transport: plain node:http/https, NOT fetch — undici's fixed 300s
 *  headers timeout kills prime calls that legitimately run longer; the
 *  analyzer's AbortSignal is the only deadline. */
export const httpJsonTransport: PrimeTransport = ({ url, body, signal }) => {
  const target = new URL(url)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new TypeError(`bridge URL must be http: or https:, got ${target.protocol}`)
  }
  const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = requestFn(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        signal,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

interface BridgeReply {
  content: string
  usage: PrimeUsage
}

class PrimeBridgeError extends Error {}

async function callBridge(
  transport: PrimeTransport,
  url: string,
  model: string,
  content: string,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  turn: string,
): Promise<BridgeReply> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`${turn}bridge call exceeded ${timeoutMs}ms`)),
    timeoutMs,
  )
  const onCallerAbort = (): void => controller.abort(callerSignal!.reason)
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  if (callerSignal?.aborted) onCallerAbort()
  let response: PrimeTransportResponse
  try {
    response = await transport({
      url,
      body: { model, messages: [{ role: 'user', content }] },
      signal: controller.signal,
    })
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error
    throw new PrimeBridgeError(
      `${turn}bridge transport failure: ${reason instanceof Error ? reason.message : String(reason)}`,
    )
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
  if (response.status !== 200) {
    throw new PrimeBridgeError(`${turn}bridge HTTP ${response.status}: ${response.text.slice(0, 500)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(response.text)
  } catch {
    throw new PrimeBridgeError(`${turn}bridge returned unparseable JSON (${response.text.length} bytes)`)
  }
  const record = parsed as { choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown }
  const replyContent = record.choices?.[0]?.message?.content
  if (typeof replyContent !== 'string' || replyContent.length === 0) {
    throw new PrimeBridgeError(`${turn}bridge reply carries no message content`)
  }
  return { content: replyContent, usage: normalizeUsage(record.usage) }
}

function failure(output: string, error: string): ExternalAnalysisResult {
  return { analyzer: ANALYST_ID, kind: 'report', ok: false, output, error }
}

/** One-shot prime-RLM analysis over the emitted OTLP artifact, as a peer of
 *  `haloAnalyzer` / `hodoscopeAnalyzer` on the `--analyzer` registry. Requires
 *  a running OpenAI-compatible bridge with the prime backend; deterministic
 *  analysis and every other engine are unaffected when it is down (`ok:false`
 *  result, never a thrown run). */
export function primeAnalyzer(opts: PrimeAnalyzerOptions = {}): ExternalAnalyzer {
  const bridgeUrl = (opts.bridgeUrl ?? process.env.TRACES_PRIME_BRIDGE_URL ?? DEFAULT_BRIDGE_URL)
    .replace(/\/+$/, '')
  const model = opts.model ?? process.env.TRACES_PRIME_MODEL ?? DEFAULT_MODEL
  const timeoutMs = opts.timeoutMs ?? positiveIntegerEnv('TRACES_PRIME_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('timeoutMs must be a positive safe integer')
  }
  const maxInlineChars = opts.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS
  const perAttributeCharCap = opts.perAttributeCharCap ?? DEFAULT_PER_ATTRIBUTE_CHAR_CAP
  if (!Number.isSafeInteger(maxInlineChars) || maxInlineChars < 1) {
    throw new RangeError('maxInlineChars must be a positive safe integer')
  }
  if (!Number.isSafeInteger(perAttributeCharCap) || perAttributeCharCap < 1) {
    throw new RangeError('perAttributeCharCap must be a positive safe integer')
  }
  const repairEnabled = opts.repair ?? true
  const transport = opts.transport ?? httpJsonTransport
  const url = `${bridgeUrl}/v1/chat/completions`

  return {
    name: ANALYST_ID,
    async analyze(otlpPath, analyzeOpts: ExternalAnalyzerOptions = {}) {
      let projection: ArtifactProjection
      try {
        projection = await projectArtifact(otlpPath, maxInlineChars, perAttributeCharCap, analyzeOpts.signal)
      } catch (error) {
        return failure('', error instanceof Error ? error.message : String(error))
      }
      const question = analyzeOpts.prompt ?? opts.defaultPrompt ?? DEFAULT_QUESTION
      const deliveryLine =
        `delivery: ${projection.delivery.mode} (${projection.delivery.renderedChars} chars, ` +
        `per-attribute cap ${projection.delivery.perAttributeCharCap ?? 'none'})`

      let reply: BridgeReply
      try {
        reply = await callBridge(
          transport, url, model, buildPrompt(question, projection), timeoutMs, analyzeOpts.signal, '')
      } catch (error) {
        if (!(error instanceof PrimeBridgeError)) throw error
        return failure('', `${error.message}; ${deliveryLine}`)
      }
      let usage = reply.usage
      let parsed = extractJsonObject(reply.content)
      let parseDefect = parseDefectOf(parsed)
      let repairAttempted = false

      if (parseDefect !== null && repairEnabled) {
        repairAttempted = true
        let repairReply: BridgeReply
        try {
          repairReply = await callBridge(
            transport, url, model, buildRepairPrompt(parseDefect, reply.content),
            timeoutMs, analyzeOpts.signal, 'repair-turn ')
        } catch (error) {
          if (!(error instanceof PrimeBridgeError)) throw error
          return failure(reply.content, `${error.message}; ${renderUsage(usage)}`)
        }
        usage = mergeUsage(usage, repairReply.usage)
        parsed = extractJsonObject(repairReply.content)
        parseDefect = parseDefectOf(parsed)
      }
      if (parseDefect !== null) {
        return failure(
          reply.content,
          `${parseDefect} in prime reply${repairAttempted ? ' even after the bounded repair turn' : ''}; ` +
            renderUsage(usage),
        )
      }

      const rows = (parsed!.findings as unknown[]).slice(0, MAX_FINDINGS)
      const overflow = (parsed!.findings as unknown[]).length - rows.length
      const producedAt = new Date().toISOString()
      const rejected: string[] = []
      const findings: AnalystFinding[] = []
      rows.forEach((row, index) => {
        const decoded = findingRowDefect(row, projection.spanTraces)
        if (typeof decoded === 'string') {
          rejected.push(`rejected[${index}]: ${decoded}`)
          return
        }
        findings.push(toAnalystFinding(decoded, index, projection.spanTraces, model, producedAt))
      })

      const answer = typeof parsed!.answer === 'string' ? parsed!.answer : null
      const output = [
        ...(answer ? [`answer: ${answer}`] : []),
        `findings: ${findings.length} mapped, ${rejected.length} rejected` +
          (overflow > 0 ? `, ${overflow} over the ${MAX_FINDINGS}-finding cap dropped` : ''),
        ...rejected,
        deliveryLine,
        `repair: ${repairAttempted ? 'attempted (succeeded)' : 'not needed'}`,
        renderUsage(usage),
        ...(findings.length === 0 ? ['zero findings — an honest null, not a failure'] : []),
      ].join('\n')
      return { analyzer: ANALYST_ID, kind: 'findings', ok: true, output, findings }
    },
  }
}
