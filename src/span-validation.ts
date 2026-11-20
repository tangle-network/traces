import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { readsEveryZstdFrame } from './zstd.js'
import { spanKey } from './span-identity.js'
import { canonicalJson } from './adapters/tool-io.js'
import type { OtlpSpan, OtlpStatusCode } from './otlp.js'
import { parseIsoToEpochMs } from './time.js'

const COMPRESSED_JSONL = /\.(?:jsonl|ndjson)\.zst$/iu
export const isCompressedJsonlFile = (path: string): boolean => COMPRESSED_JSONL.test(path)

/** Decode only retained JSONL; Node versions that silently truncate later zstd frames cannot read it. */
export async function readCompressedJsonlText(path: string): Promise<string> {
  if (!isCompressedJsonlFile(path)) throw new TypeError(`not a .jsonl.zst or .ndjson.zst source: ${path}`)
  if (!readsEveryZstdFrame()) {
    throw new Error(`cannot decode compressed OTLP ${path}: Node ${process.version} reads only the first frame of a multi-frame zstd file`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(zstdDecompressSync(await readFile(path)))
  } catch (error) {
    throw new Error(`cannot decode compressed OTLP ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export interface TextJsonlRow {
  readonly line: number
  readonly value?: unknown
  readonly corruptionBytes?: number
}

export function* textJsonlRows(text: string): Generator<TextJsonlRow> {
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim().length === 0) continue
    try {
      yield { line: index + 1, value: JSON.parse(line) as unknown }
    } catch {
      yield { line: index + 1, corruptionBytes: Buffer.byteLength(raw) }
    }
  }
}

const STATUS_CODES = new Set<OtlpStatusCode>(['OK', 'ERROR', 'UNSET'])

/**
 * Validate one normalized span batch before any consumer trusts its identity
 * or timing. File imports opt into coalescing identical deliveries of one
 * identity; a different body at that identity is always contradictory and
 * fails instead of choosing a winner. The default remains strict for adapters.
 */
export function validateOtlpSpans(
  input: readonly unknown[],
  source = 'OTLP spans',
  repeatedIdentity: 'reject' | 'coalesce-identical' = 'reject',
): OtlpSpan[] {
  if (!Array.isArray(input)) throw new TypeError(`${source} must be an array`)

  const spans: OtlpSpan[] = []
  const identities = new Map<string, Record<string, unknown>>()
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

    const identity = spanKey(traceId, spanId)
    const prior = identities.get(identity)
    if (prior !== undefined) {
      if (repeatedIdentity === 'coalesce-identical' && (prior === record || canonicalJson(prior) === canonicalJson(record))) continue
      throw new Error(`${source} contains duplicate span identity (${traceId}, ${spanId})`)
    }
    identities.set(identity, record)
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
