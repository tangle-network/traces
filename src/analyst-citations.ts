/**
 * Citation normalization for model-backed trace analysts.
 *
 * agent-eval's evidence gate accepts a finding only when every citation
 * resolves to a stored span and every excerpt is an exact substring of that
 * span's decoded content. Two artifacts of how `traces` exports spans make the
 * engine's own honest citations fail that check:
 *
 *   - `searchTrace` returns raw OTLP-JSONL text, so an excerpt copied from a hit
 *     carries JSON escapes (`\"`, `\n`) that the decoded attribute does not.
 *   - Adapters rewrite readable harness IDs (`tool:<call_id>`, a session UUID)
 *     to fixed-width hex OTLP IDs and keep the readable form only in
 *     `traces.<harness>.source_trace_id` / `source_span_id` attributes, so a
 *     citation of the readable ID names no stored span.
 *
 * A third rejection is a subject from another kind's vocabulary (for example a
 * `tool-doc:` locus on the cluster-only failure-mode kind). The subject is an
 * optional label, and the finding schema tells the model to omit it rather
 * than guess, so a subject the kind cannot hold is removed.
 *
 * Protected invariant: normalization never lets absent evidence pass. A
 * citation is rewritten only to a form proven present in the span it cites: a
 * readable ID must name exactly one span, and a decoded excerpt must be a
 * substring of that span's own attributes or status message. Anything else is
 * left untouched, and agent-eval's gate re-checks every rewritten row
 * unchanged. Normalization never adds a citation, so it cannot satisfy a
 * kind's minimum citation count on its own.
 *
 * Temporary: the agent-eval gate issue (agent-eval#TBD) makes this module
 * unnecessary. Delete it when traces adopts a release whose gate accepts
 * JSON-escaped excerpts, resolves the readable source-ID aliases above, and
 * treats an out-of-kind optional subject as omitted.
 */

import {
  KIND_EXPECTED_SUBJECTS,
  parseFindingSubject,
  type AnalystContext,
  type RawAnalystFinding,
  type TraceAnalystDefinition,
} from '@tangle-network/agent-eval/analyst'
import { spanEvidenceUri } from './external-analysis-validation.js'
import type { OtlpSpan } from './otlp.js'

/**
 * Appended to each wrapped definition's version. agent-eval records a
 * `postProcess` hook as `version-bound`, so the version names this behavior.
 * Bump it whenever the normalization rules change.
 */
export const CITATION_NORMALIZATION_VERSION = 'traces-citations-1'

const SOURCE_TRACE_ID = /^traces\.([a-z0-9_-]+)\.source_trace_id$/
const SPAN_URI_PREFIX = 'trace://'
const SPAN_URI_SEPARATOR = '/span/'
// JSON string escapes only. Anything else stays literal, so a truncated or
// already-decoded excerpt cannot turn into a different string.
const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

interface IndexedSpan {
  readonly traceId: string
  readonly spanId: string
  /** The values the gate searches for an excerpt: attributes and status message. */
  readonly content: readonly unknown[]
}

interface CitationIndex {
  readonly traces: ReadonlyMap<string, ReadonlyMap<string, IndexedSpan>>
  /** Readable trace ID → hex trace IDs. */
  readonly readableTraces: ReadonlyMap<string, ReadonlySet<string>>
  /** Hex trace ID → readable span ID → spans carrying that alias. */
  readonly readableSpans: ReadonlyMap<string, ReadonlyMap<string, readonly IndexedSpan[]>>
}

/**
 * Wrap trace-analyst definitions so each submitted finding is normalized
 * against `spans` before agent-eval's evidence gate runs.
 *
 * Pass the same spans the analysts' trace store was written from. A
 * definition's own `postProcess` runs after normalization and keeps the final
 * say over the row.
 */
export function normalizeAnalystCitations(
  definitions: readonly TraceAnalystDefinition[],
  spans: readonly OtlpSpan[],
): TraceAnalystDefinition[] {
  const index = indexSpans(spans)
  return definitions.map((definition) => {
    const own = definition.postProcess
    return {
      ...definition,
      version: `${definition.version}+${CITATION_NORMALIZATION_VERSION}`,
      postProcess: (row: RawAnalystFinding, context: AnalystContext) => {
        const normalized = normalizeFinding(row, definition.id, index, context)
        return own ? own(normalized, context) : normalized
      },
    }
  })
}

function normalizeFinding(
  row: RawAnalystFinding,
  analystId: string,
  index: CitationIndex,
  context: AnalystContext,
): RawAnalystFinding {
  const evidence = row.evidence.map((citation) => {
    const span = resolveCitation(citation.uri, index)
    if (!span) return citation
    const uri = spanEvidenceUri(span.traceId, span.spanId)
    if (uri !== citation.uri) {
      context.log?.('finding citation normalized: readable id', {
        analyst_id: analystId,
        from: citation.uri,
        to: uri,
      })
    }
    const excerpt = citation.excerpt === undefined
      ? undefined
      : normalizeExcerpt(citation.excerpt, span)
    if (excerpt !== citation.excerpt) {
      context.log?.('finding citation normalized: json-escaped excerpt', {
        analyst_id: analystId,
        uri,
      })
    }
    return excerpt === undefined ? { uri } : { uri, excerpt }
  })
  const normalized: RawAnalystFinding = { ...row, evidence }
  const allowed = KIND_EXPECTED_SUBJECTS[analystId]
  if (row.subject === undefined || !allowed) return normalized
  const subject = parseFindingSubject(row.subject)
  // A grammar-invalid subject never reaches postProcess: the schema rejects
  // the row first. Only a valid subject from another kind's vocabulary lands here.
  if (!subject || allowed.includes(subject.kind)) return normalized
  context.log?.('finding subject omitted: not valid for analyst', {
    analyst_id: analystId,
    subject: row.subject,
    allowed,
  })
  const { subject: _omitted, ...withoutSubject } = normalized
  return withoutSubject
}

/** The one span a citation names, by hex or readable ID, or null when absent or ambiguous. */
function resolveCitation(uri: string, index: CitationIndex): IndexedSpan | null {
  const parsed = parseCitation(uri)
  if (!parsed) return null
  const traceIds = parsed.traceId === undefined
    ? [...index.traces.keys()]
    : index.traces.has(parsed.traceId)
      ? [parsed.traceId]
      : [...(index.readableTraces.get(parsed.traceId) ?? [])]
  const matches = new Set<IndexedSpan>()
  for (const traceId of traceIds) {
    const direct = index.traces.get(traceId)?.get(parsed.spanId)
    if (direct) matches.add(direct)
    for (const span of index.readableSpans.get(traceId)?.get(parsed.spanId) ?? []) matches.add(span)
  }
  if (matches.size !== 1) return null
  const [span] = matches
  return span ?? null
}

/**
 * Split a span citation at its first `/span/`, so a readable span ID that
 * contains `/` still resolves. A bare ID without a scheme names a span in any
 * trace, and resolves only when exactly one span carries it.
 */
function parseCitation(uri: string): { traceId?: string; spanId: string } | null {
  const trimmed = uri.trim()
  if (trimmed.startsWith(SPAN_URI_PREFIX)) {
    const rest = trimmed.slice(SPAN_URI_PREFIX.length)
    const separator = rest.indexOf(SPAN_URI_SEPARATOR)
    if (separator <= 0) return null
    const traceId = decodeComponent(rest.slice(0, separator))
    const spanId = decodeComponent(rest.slice(separator + SPAN_URI_SEPARATOR.length))
    return traceId && spanId ? { traceId, spanId } : null
  }
  if (trimmed.includes('://')) return null
  return trimmed ? { spanId: trimmed } : null
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Keep an excerpt the span already contains; otherwise decode it only when the decoded text is in the span. */
function normalizeExcerpt(excerpt: string, span: IndexedSpan): string {
  if (containsText(span.content, excerpt)) return excerpt
  const decoded = decodeJsonEscapes(excerpt)
  return decoded !== excerpt && containsText(span.content, decoded) ? decoded : excerpt
}

function decodeJsonEscapes(text: string): string {
  return text.replace(JSON_ESCAPE, (_match, unicode: string | undefined, simple: string | undefined) =>
    unicode !== undefined ? String.fromCharCode(Number.parseInt(unicode, 16)) : SIMPLE_ESCAPES[simple!]!,
  )
}

/** Mirrors the gate's search: string values at any depth, never keys. */
function containsText(value: unknown, expected: string, depth = 0): boolean {
  if (!expected || depth > 20) return false
  if (typeof value === 'string') return value.includes(expected)
  if (Array.isArray(value)) return value.some((entry) => containsText(entry, expected, depth + 1))
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some((entry) => containsText(entry, expected, depth + 1))
  }
  return false
}

function indexSpans(spans: readonly OtlpSpan[]): CitationIndex {
  const traces = new Map<string, Map<string, IndexedSpan>>()
  const readableTraces = new Map<string, Set<string>>()
  const readableSpans = new Map<string, Map<string, IndexedSpan[]>>()
  for (const item of spans) {
    const span: IndexedSpan = {
      traceId: item.trace_id,
      spanId: item.span_id,
      content: [item.attributes, item.status.message],
    }
    let byId = traces.get(item.trace_id)
    if (!byId) traces.set(item.trace_id, byId = new Map())
    byId.set(item.span_id, span)
    for (const [key, value] of Object.entries(item.attributes)) {
      const harness = SOURCE_TRACE_ID.exec(key)?.[1]
      if (!harness || typeof value !== 'string') continue
      let hexTraces = readableTraces.get(value)
      if (!hexTraces) readableTraces.set(value, hexTraces = new Set())
      hexTraces.add(item.trace_id)
      const readableSpanId = item.attributes[`traces.${harness}.source_span_id`]
      if (typeof readableSpanId !== 'string') continue
      let aliases = readableSpans.get(item.trace_id)
      if (!aliases) readableSpans.set(item.trace_id, aliases = new Map())
      const existing = aliases.get(readableSpanId)
      if (existing) existing.push(span)
      else aliases.set(readableSpanId, [span])
    }
  }
  return { traces, readableTraces, readableSpans }
}
