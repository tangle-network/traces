import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export const SOURCE_ATTRIBUTE_PREFIX = 'traces.source_record.'

/** Location of original bytes, never a copy of their content. */
export interface SourceRecordReference {
  sourceId: string
  sourceSha256?: string
  recordOffset: number
  recordBytes: number
  recordSha256: string
  fieldLocator: string
}

export type SourceReferences = SourceRecordReference | readonly SourceRecordReference[] | undefined

const locations = new WeakMap<object, SourceRecordReference>()

export function sourceFileId(path: string): string {
  return createHash('sha256').update(resolve(path)).digest('hex')
}

function pointerPart(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

/** Object metadata expires with parsed records and does not alter source projections. */
export function locateSourceObjects(value: unknown, path: string, bytes: Buffer, offset = 0): void {
  if (!value || typeof value !== 'object') return
  const record = {
    sourceId: sourceFileId(path),
    recordOffset: offset,
    recordBytes: bytes.length,
    recordSha256: createHash('sha256').update(bytes).digest('hex'),
  }
  const pending: Array<{ value: object; pointer: string }> = [{ value, pointer: '#' }]
  while (pending.length > 0) {
    const current = pending.pop()!
    locations.set(current.value, { ...record, fieldLocator: current.pointer })
    for (const [key, child] of Object.entries(current.value)) {
      if (child && typeof child === 'object') {
        pending.push({ value: child, pointer: `${current.pointer}/${pointerPart(key)}` })
      }
    }
  }
}

export function sourceOf(value: unknown, ...fields: string[]): SourceRecordReference | undefined {
  if (!value || typeof value !== 'object') return undefined
  const location = locations.get(value)
  return location ? {
    ...location,
    fieldLocator: `${location.fieldLocator}${fields.map((field) => `/${pointerPart(field)}`).join('')}`,
  } : undefined
}

/** Conversation citations can read text leaves, never adjacent tool blocks. */
export function textSources(value: unknown, field: string): SourceReferences {
  if (!value || typeof value !== 'object') return undefined
  const content = (value as Record<string, unknown>)[field]
  if (typeof content === 'string') return sourceOf(value, field)
  if (!Array.isArray(content)) return undefined
  return content.flatMap((block, index) => {
    if (typeof block === 'string') {
      const ref = sourceOf(value, field, String(index))
      return ref ? [ref] : []
    }
    if (!block || typeof block !== 'object' || typeof block.text !== 'string') return []
    if (block.type !== undefined && !['text', 'input_text', 'output_text'].includes(block.type)) return []
    const ref = sourceOf(block, 'text')
    return ref ? [ref] : []
  })
}

export function sourceAttributes(attribute: string, sources: SourceReferences): Record<string, unknown> {
  const refs = sources === undefined ? [] : Array.isArray(sources) ? sources : [sources]
  return refs.length === 0 ? {} : { [`${SOURCE_ATTRIBUTE_PREFIX}${attribute}`]: JSON.stringify(refs) }
}

export function appendSourceAttributes(attributes: Record<string, unknown>, attribute: string, sources: SourceReferences): void {
  const key = `${SOURCE_ATTRIBUTE_PREFIX}${attribute}`
  const added = sourceAttributes(attribute, sources)[key]
  if (typeof added !== 'string') return
  const prior = attributes[key]
  const refs = typeof prior === 'string' ? JSON.parse(prior) as SourceRecordReference[] : []
  const known = new Set(refs.map((ref) => JSON.stringify(ref)))
  for (const ref of JSON.parse(added) as SourceRecordReference[]) {
    if (!known.has(JSON.stringify(ref))) {
      refs.push(ref)
      known.add(JSON.stringify(ref))
    }
  }
  attributes[key] = JSON.stringify(refs)
}

export function stripSourceAttributes(attributes: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => !key.startsWith(SOURCE_ATTRIBUTE_PREFIX)))
}
