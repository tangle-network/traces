import { createHash } from 'node:crypto'
import type { OtlpSpan } from '../otlp.js'

export const TOOL_IO_VALUE_MAX_BYTES = 16 * 1024
export const TOOL_IO_VALUE_KEYS = ['input.value', 'output.value'] as const

interface ToolIoInput {
  input?: unknown
  output?: unknown
}

const TOOL_IO_SIDES = ['input', 'output'] as const
const LEGACY_TRUNCATION_MARKER = /\n\[truncated (\d+) bytes; sha256=[a-f0-9]{64}\]$/
const COUNTED_TRUNCATION_MARKER = /\n\[truncated \d+ bytes\]$/
const TRUNCATION_MARKER = /\n\[truncated\]$/

// Sort structurally, then stringify once. Recursive string concatenation
// exceeds the bounded-heap adapter contract for large structured values.
function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(
      Object.entries(item)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sort(entry)]),
    )
  }
  const json = JSON.stringify(sort(value))
  if (json === undefined) throw new TypeError('tool I/O value is not JSON-serializable')
  return json
}

function serialize(value: unknown): { value: string; mimeType: string } | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return { value: canonicalJson(JSON.parse(trimmed)), mimeType: 'application/json' }
      } catch {
        // Tool arguments may be arbitrary text that only resembles JSON.
      }
    }
    return { value, mimeType: 'text/plain' }
  }
  return { value: canonicalJson(value), mimeType: 'application/json' }
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const char of value) {
    const charBytes = Buffer.byteLength(char)
    if (bytes + charBytes > maxBytes) break
    bytes += charBytes
    end += char.length
  }
  return Buffer.from(value.slice(0, end), 'utf8').toString('utf8')
}

function truncatedValue(value: string, bytes: number): string {
  const longestMarker = `\n[truncated ${bytes} bytes]`
  const prefix = utf8Prefix(value, TOOL_IO_VALUE_MAX_BYTES - Buffer.byteLength(longestMarker))
  const omittedBytes = bytes - Buffer.byteLength(prefix)
  return `${prefix}\n[truncated ${omittedBytes} bytes]`
}

function valueAttributes(side: 'input' | 'output', raw: unknown): Record<string, unknown> {
  const serialized = serialize(raw)
  if (!serialized) return {}

  const bytes = Buffer.byteLength(serialized.value)
  const sha256 = createHash('sha256').update(serialized.value).digest('hex')
  const truncated = bytes > TOOL_IO_VALUE_MAX_BYTES
  const value = truncated ? truncatedValue(serialized.value, bytes) : serialized.value

  return {
    [`${side}.value`]: value,
    [`${side}.mime_type`]: serialized.mimeType,
    [`traces.${side}.bytes`]: bytes,
    [`traces.${side}.sha256`]: sha256,
    [`traces.${side}.truncated`]: truncated,
  }
}

export function toolIoAttributes(io: ToolIoInput): Record<string, unknown> {
  return { ...valueAttributes('input', io.input), ...valueAttributes('output', io.output) }
}

/** Make all tool metadata describe only the value that remains after redaction. */
export function normalizeToolIoAttributes(attributes: Record<string, unknown>): void {
  for (const side of TOOL_IO_SIDES) {
    const valueKey = `${side}.value`
    const mimeKey = `${side}.mime_type`
    const bytesKey = `traces.${side}.bytes`
    const digestKey = `traces.${side}.sha256`
    const truncatedKey = `traces.${side}.truncated`
    const rawValue = attributes[valueKey]
    if (typeof rawValue !== 'string') {
      delete attributes[mimeKey]
      delete attributes[bytesKey]
      delete attributes[digestKey]
      delete attributes[truncatedKey]
      continue
    }

    let value = rawValue
      .replace(LEGACY_TRUNCATION_MARKER, '\n[truncated]')
      .replace(COUNTED_TRUNCATION_MARKER, '\n[truncated]')
    let truncated = TRUNCATION_MARKER.test(value)
    const unboundedBytes = Buffer.byteLength(value)
    if (unboundedBytes > TOOL_IO_VALUE_MAX_BYTES) {
      value = truncatedValue(value, unboundedBytes)
      truncated = true
    }
    attributes[valueKey] = value
    attributes[bytesKey] = Buffer.byteLength(value)
    attributes[digestKey] = createHash('sha256').update(value).digest('hex')
    attributes[truncatedKey] = truncated
  }
}

export function recordToolOutput(toolSpan: OtlpSpan | undefined, output: unknown): void {
  if (!toolSpan) return
  Object.assign(toolSpan.attributes, valueAttributes('output', output))
}
