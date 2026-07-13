import { createHash } from 'node:crypto'
import { ATTR } from './attributes.js'
import type { JsonlCorruptionReceipt, JsonlReadOptions } from './jsonl.js'
import { span, type OtlpSpan } from './otlp.js'
import type { ParseOptions, SessionRef } from './types.js'

interface ReceiptState {
  corruptions: readonly JsonlCorruptionReceipt[]
  seen: Set<string>
}

const receiptStates = new WeakMap<SessionRef, ReceiptState>()

function receiptIdentity(receipt: JsonlCorruptionReceipt): readonly [string, number, number, number, string] {
  return [
    receipt.sourcePath,
    receipt.lineNumber,
    receipt.byteOffset,
    receipt.byteLength,
    receipt.sha256,
  ]
}

function receiptKey(receipt: JsonlCorruptionReceipt): string {
  return JSON.stringify(receiptIdentity(receipt))
}

function stateFor(ref: SessionRef, current: readonly JsonlCorruptionReceipt[]): ReceiptState {
  let state = receiptStates.get(ref)
  if (!state || state.corruptions !== current) {
    state = {
      corruptions: current,
      seen: new Set(current.map(receiptKey)),
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

  if (ref.integrity) {
    ref.integrity.corruptions.push(corruption)
  } else {
    ref.integrity = { status: 'degraded_not_lossless', corruptions: [corruption] }
  }
  state.seen.add(key)
  state.corruptions = ref.integrity.corruptions
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
  return {
    [ATTR.SESSION_INTEGRITY]: ref.integrity.status,
    [ATTR.CORRUPTION_COUNT]: ref.integrity.corruptions.length,
    [ATTR.CORRUPTION_DIGEST]: corruptionDigest(ref.integrity.corruptions),
    [ATTR.RAW_SOURCE_RETENTION]: 'local_source_only',
  }
}

function corruptionDigest(receipts: readonly JsonlCorruptionReceipt[]): string {
  const hash = createHash('sha256')
  for (const receipt of receipts) {
    hash.update(JSON.stringify(receiptIdentity(receipt)))
    hash.update('\n')
  }
  return `sha256:${hash.digest('hex')}`
}

function receiptSpanId(parentSpanId: string, receipt: JsonlCorruptionReceipt): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(receiptIdentity(receipt)))
    .digest('hex')
  return `${parentSpanId}:corruption:${digest}`
}

export function stampSessionIntegrity(ref: SessionRef, spans: OtlpSpan[]): void {
  if (!ref.integrity) return
  const parent = spans.find((item) => item.parent_span_id === null) ?? spans[0]
  if (!parent) return
  const sessionId = parent.trace_id
  for (const receipt of ref.integrity.corruptions) {
    receipt.harness = ref.harness
    receipt.sessionId = sessionId
  }
  const attributes = sessionIntegrityAttributes(ref)
  Object.assign(parent.attributes, attributes)

  const existingSpanIds = new Set(spans.map((item) => item.span_id))
  for (const receipt of ref.integrity.corruptions) {
    const spanId = receiptSpanId(parent.span_id, receipt)
    if (existingSpanIds.has(spanId)) continue
    spans.push(span({
      traceId: parent.trace_id,
      spanId,
      parentSpanId: parent.span_id,
      name: 'source.corruption.receipt',
      kind: 'CHAIN',
      startTime: parent.start_time,
      endTime: parent.start_time,
      status: 'ERROR',
      service: typeof parent.attributes['service.name'] === 'string'
        ? parent.attributes['service.name']
        : ref.harness,
      extra: {
        [ATTR.SESSION_INTEGRITY]: ref.integrity.status,
        [ATTR.CORRUPTION_RECEIPT_VERSION]: receipt.receiptVersion,
        [ATTR.CORRUPTION_RECEIPT_KIND]: receipt.kind,
        [ATTR.CORRUPTION_SOURCE_PATH]: receipt.sourcePath,
        [ATTR.CORRUPTION_LINE_NUMBER]: receipt.lineNumber,
        [ATTR.CORRUPTION_BYTE_OFFSET]: receipt.byteOffset,
        [ATTR.CORRUPTION_BYTE_LENGTH]: receipt.byteLength,
        [ATTR.CORRUPTION_SHA256]: receipt.sha256,
        [ATTR.RAW_SOURCE_RETENTION]: 'local_source_only',
      },
    }))
    existingSpanIds.add(spanId)
  }
}
