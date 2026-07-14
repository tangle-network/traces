import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export interface JsonlCorruptionReceipt {
  receiptVersion: 1
  kind: 'jsonl_corruption'
  status: 'degraded_not_lossless'
  sourcePath: string
  /** Zero-based byte offset of the record, excluding prior line delimiters. */
  byteOffset: number
  /** Exact record byte length excluding LF, but including CR when present. */
  byteLength: number
  /** One-based physical line number. */
  lineNumber: number
  /** SHA-256 of the exact source bytes at byteOffset/byteLength. */
  sha256: string
  /** Traces retains only a fingerprint; exact bytes may be reread from the local source. */
  rawBytes: 'local_source_only'
}

export type JsonlReadOptions =
  | { mode?: 'strict' }
  | { mode: 'recover'; onCorruption: (receipt: JsonlCorruptionReceipt) => void }

export class JsonlParseError extends SyntaxError {
  readonly sourcePath: string
  readonly lineNumber: number
  readonly byteOffset: number
  readonly byteLength: number
  readonly sha256: string
  readonly receipt: JsonlCorruptionReceipt

  constructor(receipt: JsonlCorruptionReceipt) {
    super(`Invalid JSONL at ${receipt.sourcePath}:${receipt.lineNumber}`)
    this.name = 'JsonlParseError'
    this.sourcePath = receipt.sourcePath
    this.lineNumber = receipt.lineNumber
    this.byteOffset = receipt.byteOffset
    this.byteLength = receipt.byteLength
    this.sha256 = receipt.sha256
    this.receipt = receipt
  }
}

function corruptionReceipt(
  rawLine: Buffer,
  path: string,
  lineNumber: number,
  byteOffset: number,
): JsonlCorruptionReceipt {
  return {
    receiptVersion: 1,
    kind: 'jsonl_corruption',
    status: 'degraded_not_lossless',
    sourcePath: path,
    lineNumber,
    byteOffset,
    byteLength: rawLine.length,
    sha256: createHash('sha256').update(rawLine).digest('hex'),
    rawBytes: 'local_source_only',
  }
}

function parseLine<T>(
  rawLine: Buffer,
  path: string,
  lineNumber: number,
  byteOffset: number,
  options: JsonlReadOptions,
): T | undefined {
  const jsonBytes = rawLine.at(-1) === 0x0d ? rawLine.subarray(0, -1) : rawLine
  if (jsonBytes.length === 0) return undefined
  if (!isUtf8(jsonBytes)) return handleCorruption(rawLine, path, lineNumber, byteOffset, options)
  const json = jsonBytes.toString('utf8')
  if (json.trim().length === 0) return undefined
  try {
    return JSON.parse(json) as T
  } catch {
    return handleCorruption(rawLine, path, lineNumber, byteOffset, options)
  }
}

function handleCorruption(
  rawLine: Buffer,
  path: string,
  lineNumber: number,
  byteOffset: number,
  options: JsonlReadOptions,
): undefined {
  const receipt = corruptionReceipt(rawLine, path, lineNumber, byteOffset)
  if (options.mode === 'recover') {
    options.onCorruption(receipt)
    return undefined
  }
  throw new JsonlParseError(receipt)
}

/** Stream JSONL rows without retaining the source file. */
export async function* readJsonl<T>(
  path: string,
  options: JsonlReadOptions = { mode: 'strict' },
): AsyncGenerator<T> {
  if (
    options.mode === 'recover' &&
    typeof (options as { onCorruption?: unknown }).onCorruption !== 'function'
  ) {
    throw new TypeError('JSONL recover mode requires an onCorruption callback')
  }
  const input = createReadStream(path)
  let lineNumber = 0
  let byteOffset = 0
  let fragments: Buffer[] = []
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      let start = 0
      let newline = bytes.indexOf(0x0a)
      while (newline !== -1) {
        fragments.push(bytes.subarray(start, newline))
        const rawLine = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments)
        fragments = []
        lineNumber += 1
        const parsed = parseLine<T>(rawLine, path, lineNumber, byteOffset, options)
        if (parsed !== undefined) yield parsed
        byteOffset += rawLine.length + 1
        start = newline + 1
        newline = bytes.indexOf(0x0a, start)
      }
      if (start < bytes.length) fragments.push(bytes.subarray(start))
    }
    if (fragments.length > 0) {
      const rawLine = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments)
      lineNumber += 1
      const parsed = parseLine<T>(rawLine, path, lineNumber, byteOffset, options)
      if (parsed !== undefined) yield parsed
    }
  } finally {
    input.destroy()
  }
}

export async function takeJsonl<T>(
  path: string,
  limit: number,
  options: JsonlReadOptions = { mode: 'strict' },
): Promise<T[]> {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative integer')
  const rows: T[] = []
  if (limit === 0) return rows
  for await (const row of readJsonl<T>(path, options)) {
    rows.push(row)
    if (rows.length === limit) break
  }
  return rows
}
