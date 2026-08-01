import type { OtlpSpan, OtlpStatusCode } from './otlp.js'
import { parseIsoToEpochMs } from './time.js'

const STATUS_CODES = new Set<OtlpStatusCode>(['OK', 'ERROR', 'UNSET'])

/**
 * Validate one normalized span batch before any consumer trusts its identity
 * or timing. The returned array contains the original span objects.
 */
export function validateOtlpSpans(
  input: readonly unknown[],
  source = 'OTLP spans',
): OtlpSpan[] {
  if (!Array.isArray(input)) throw new TypeError(`${source} must be an array`)

  const spans: OtlpSpan[] = []
  const identities = new Set<string>()
  for (const [index, value] of input.entries()) {
    const path = `${source}[${index}]`
    const record = requireObject(value, path)
    const traceId = requireNonEmptyString(record.trace_id, `${path}.trace_id`)
    const spanId = requireNonEmptyString(record.span_id, `${path}.span_id`)
    const parentSpanId = record.parent_span_id
    if (parentSpanId !== null) {
      requireNonEmptyString(parentSpanId, `${path}.parent_span_id`)
    }
    requireNonEmptyString(record.name, `${path}.name`)
    const startTime = requireNonEmptyString(record.start_time, `${path}.start_time`)
    const endTime = requireNonEmptyString(record.end_time, `${path}.end_time`)
    const startMs = parseTimestamp(startTime, `${path}.start_time`)
    const endMs = parseTimestamp(endTime, `${path}.end_time`)
    if (endMs < startMs) {
      throw new RangeError(
        `${path}.end_time must not precede start_time (${endTime} < ${startTime})`,
      )
    }

    const status = requireObject(record.status, `${path}.status`)
    if (!STATUS_CODES.has(status.code as OtlpStatusCode)) {
      throw new TypeError(`${path}.status.code must be OK, ERROR, or UNSET`)
    }
    if (status.message !== undefined && typeof status.message !== 'string') {
      throw new TypeError(`${path}.status.message must be a string when present`)
    }
    requireObject(record.attributes, `${path}.attributes`)
    requireLinks(record.links, `${path}.links`)

    const identity = JSON.stringify([traceId, spanId])
    if (identities.has(identity)) {
      throw new Error(`${source} contains duplicate span identity (${traceId}, ${spanId})`)
    }
    identities.add(identity)
    spans.push(value as OtlpSpan)
  }
  return spans
}

/**
 * Links are the causal edges (steered-by / retry-of). A link missing either id
 * points at nothing, so it would serialize as an edge a reader cannot follow —
 * reject it here rather than emit a broken chain. Ingest of FOREIGN traces
 * never reaches this: `readOtlpInput` repairs or drops such links and reports
 * them as findings, because a foreign file must never crash the tool.
 */
function requireLinks(value: unknown, path: string): void {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array when present`)
  for (const [index, entry] of value.entries()) {
    const link = requireObject(entry, `${path}[${index}]`)
    requireNonEmptyString(link.trace_id, `${path}[${index}].trace_id`)
    requireNonEmptyString(link.span_id, `${path}[${index}].span_id`)
    if (link.attributes !== undefined) requireObject(link.attributes, `${path}[${index}].attributes`)
  }
}

function parseTimestamp(value: string, path: string): number {
  try {
    return parseIsoToEpochMs(value)
  } catch {
    throw new TypeError(`${path} must be a finite ISO-8601 or epoch-millis timestamp`)
  }
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string`)
  }
  return value
}
