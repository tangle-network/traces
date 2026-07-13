import { ATTR } from './attributes.js'
import type { JsonlCorruptionReceipt, JsonlReadOptions } from './jsonl.js'
import type { OtlpSpan } from './otlp.js'
import type { ParseOptions, SessionRef } from './types.js'

export const MAX_SESSION_CORRUPTION_RECEIPTS = 128
export const MAX_SESSION_CORRUPTION_ATTRIBUTE_BYTES = 64 * 1024

interface ReceiptState {
  corruptions: readonly JsonlCorruptionReceipt[]
  seen: Set<string>
  serializedBytes: number
}

const receiptStates = new WeakMap<SessionRef, ReceiptState>()

export class SessionCorruptionLimitError extends Error {
  readonly sourcePath: string
  readonly lineNumber: number
  readonly receiptCount: number
  readonly serializedBytes: number

  constructor(receipt: JsonlCorruptionReceipt, receiptCount: number, serializedBytes: number) {
    super(`Session corruption exceeds bounded recovery at ${receipt.sourcePath}:${receipt.lineNumber}`)
    this.name = 'SessionCorruptionLimitError'
    this.sourcePath = receipt.sourcePath
    this.lineNumber = receipt.lineNumber
    this.receiptCount = receiptCount
    this.serializedBytes = serializedBytes
  }
}

function receiptKey(receipt: JsonlCorruptionReceipt): string {
  return `${receipt.sourcePath}\0${receipt.lineNumber}\0${receipt.sha256}`
}

function stateFor(ref: SessionRef, current: readonly JsonlCorruptionReceipt[]): ReceiptState {
  let state = receiptStates.get(ref)
  if (!state || state.corruptions !== current) {
    state = {
      corruptions: current,
      seen: new Set(current.map(receiptKey)),
      serializedBytes: Buffer.byteLength(JSON.stringify(current)),
    }
    receiptStates.set(ref, state)
  }
  return state
}

export function recordSessionCorruption(ref: SessionRef, receipt: JsonlCorruptionReceipt): void {
  const current = ref.integrity?.corruptions ?? []
  const corruption = { ...receipt, harness: ref.harness, sessionId: ref.sessionId }
  const state = stateFor(ref, current)
  const key = receiptKey(receipt)
  if (state.seen.has(key)) return

  const receiptBytes = Buffer.byteLength(JSON.stringify(corruption))
  const receiptCount = current.length + 1
  const serializedBytes = state.serializedBytes + receiptBytes + (current.length === 0 ? 0 : 1)
  if (
    receiptCount > MAX_SESSION_CORRUPTION_RECEIPTS ||
    serializedBytes > MAX_SESSION_CORRUPTION_ATTRIBUTE_BYTES
  ) {
    throw new SessionCorruptionLimitError(receipt, receiptCount, serializedBytes)
  }

  if (ref.integrity) {
    ref.integrity.corruptions.push(corruption)
  } else {
    ref.integrity = { status: 'degraded_not_lossless', corruptions: [corruption] }
  }
  state.seen.add(key)
  state.corruptions = ref.integrity.corruptions
  state.serializedBytes = serializedBytes
}

export function sessionJsonlOptions(ref: SessionRef, options: ParseOptions = {}): JsonlReadOptions {
  if (options.corruptionMode === 'strict') return { mode: 'strict' }
  return {
    mode: 'recover',
    onCorruption: (receipt) => recordSessionCorruption(ref, receipt),
  }
}

export function sessionIntegrityAttributes(ref: SessionRef): Record<string, string | number> {
  if (!ref.integrity) return {}
  const corruptions = JSON.stringify(ref.integrity.corruptions)
  const serializedBytes = Buffer.byteLength(corruptions)
  if (serializedBytes > MAX_SESSION_CORRUPTION_ATTRIBUTE_BYTES) {
    const last = ref.integrity.corruptions.at(-1)!
    throw new SessionCorruptionLimitError(last, ref.integrity.corruptions.length, serializedBytes)
  }
  return {
    [ATTR.SESSION_INTEGRITY]: ref.integrity.status,
    [ATTR.CORRUPTION_COUNT]: ref.integrity.corruptions.length,
    [ATTR.CORRUPTION_RECEIPTS]: corruptions,
    [ATTR.RAW_SOURCE_RETENTION]: 'local_source_only',
  }
}

export function stampSessionIntegrity(ref: SessionRef, spans: readonly OtlpSpan[]): void {
  if (!ref.integrity) return
  const root = spans.find((item) => item.parent_span_id === null)
  const sessionId = root?.trace_id ?? ref.sessionId
  ref.integrity.corruptions = ref.integrity.corruptions.map((item) => ({
    ...item,
    harness: ref.harness,
    sessionId,
  }))
  const attributes = sessionIntegrityAttributes(ref)
  for (const item of spans) {
    if (item.parent_span_id === null) Object.assign(item.attributes, attributes)
  }
}
