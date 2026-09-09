import { canonicalJson } from './adapters/tool-io.js'
import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ReadSpanSourceResult, SpanSourceReader } from '@tangle-network/agent-eval/traces'
import { readSessionBundleManifest, type SessionBundleFile } from './bundle.js'
import { readOtlpInput } from './otlp-input.js'
import type { OtlpSpan } from './otlp.js'
import { SOURCE_ATTRIBUTE_PREFIX, type SourceRecordReference } from './source-location.js'

const SHA256 = /^[a-f0-9]{64}$/
const TRACE_FILE = 'derived/trace.otlp.jsonl'

function containedPath(root: string, path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === '..' || part === '' || part === '.')) {
    throw new Error('bundle contains an unsafe file path')
  }
  const resolved = resolve(root, path)
  if (relative(root, resolved).startsWith(`..${sep}`) || resolved === root) {
    throw new Error('bundle file is outside the authorized directory')
  }
  return resolved
}

async function openBundleFile(root: string, file: SessionBundleFile): Promise<FileHandle> {
  const path = containedPath(root, file.path)
  let current = root
  for (const part of relative(root, path).split(sep)) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('bundle source symlinks are not permitted')
  }
  if (await realpath(path) !== path) throw new Error('bundle source resolved outside its declared path')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const info = await handle.stat()
  if (!info.isFile() || info.size !== file.bytes) {
    await handle.close()
    throw new Error('bundle source size or type does not match its manifest')
  }
  return handle
}

async function fileDigest(handle: FileHandle, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of handle.createReadStream({ start: 0, autoClose: false, signal })) hash.update(bytes)
  return hash.digest('hex')
}

async function validateFile(root: string, file: SessionBundleFile, signal?: AbortSignal): Promise<void> {
  const handle = await openBundleFile(root, file)
  try {
    if (await fileDigest(handle, signal) !== file.sha256) throw new Error('bundle file digest does not match its manifest')
  } finally {
    await handle.close()
  }
}

function reference(value: unknown): value is SourceRecordReference {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<SourceRecordReference>
  return typeof item.sourceId === 'string' && SHA256.test(item.sourceId)
    && typeof item.sourceSha256 === 'string' && SHA256.test(item.sourceSha256)
    && typeof item.recordSha256 === 'string' && SHA256.test(item.recordSha256)
    && Number.isSafeInteger(item.recordOffset) && item.recordOffset! >= 0
    && Number.isSafeInteger(item.recordBytes) && item.recordBytes! > 0
    && typeof item.fieldLocator === 'string' && item.fieldLocator.length <= 4096 && item.fieldLocator.startsWith('#')
}

function identity(span: Pick<OtlpSpan, 'trace_id' | 'span_id'>): string {
  return JSON.stringify([span.trace_id, span.span_id])
}

/** Grant only the original records associated with unchanged attributes in these selected spans. */
export async function createBundleSourceReader(
  directory: string,
  spans: readonly OtlpSpan[],
  options: { signal?: AbortSignal; maxRecordBytes?: number } = {},
): Promise<SpanSourceReader | undefined> {
  const maxRecordBytes = options.maxRecordBytes ?? 16 * 1024 * 1024
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) throw new Error('maxRecordBytes must be a positive safe integer')
  options.signal?.throwIfAborted()
  if ((await lstat(resolve(directory))).isSymbolicLink()) throw new Error('bundle directory must not be a symlink')
  const root = await realpath(resolve(directory))
  if ((await lstat(join(root, 'manifest.json'))).isSymbolicLink()) throw new Error('bundle manifest must not be a symlink')
  const manifest = await readSessionBundleManifest(root)
  if (manifest.view !== 'full') throw new Error('original source reads require an explicitly authorized full bundle')
  if (!Array.isArray(manifest.files)) throw new Error('bundle manifest has no file receipts')
  const paths = new Set<string>()
  const sources = new Map<string, SessionBundleFile>()
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !SHA256.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || paths.has(file.path)) {
      throw new Error('bundle manifest has an invalid or duplicate file receipt')
    }
    containedPath(root, file.path)
    paths.add(file.path)
    if (file.sourceId !== undefined) {
      if (!SHA256.test(file.sourceId) || sources.has(file.sourceId) || !file.path.startsWith('session/')) {
        throw new Error('bundle manifest has an invalid source identity')
      }
      sources.set(file.sourceId, { ...file })
    }
  }
  const traceFile = manifest.files.find((file) => file.path === TRACE_FILE)
  if (!traceFile) throw new Error('bundle has no derived trace receipt')
  await validateFile(root, traceFile, options.signal)
  const recorded = await readOtlpInput(join(root, TRACE_FILE))
  await validateFile(root, traceFile, options.signal)
  const original = new Map(recorded.spans.map((span) => [identity(span), span]))
  const allowed = new Map<string, Map<string, SourceRecordReference[]>>()
  for (const span of spans) {
    const prior = original.get(identity(span))
    if (!prior) continue
    const attributes = new Map<string, SourceRecordReference[]>()
    for (const [key, encoded] of Object.entries(span.attributes)) {
      if (!key.startsWith(SOURCE_ATTRIBUTE_PREFIX) || typeof encoded !== 'string') continue
      const attribute = key.slice(SOURCE_ATTRIBUTE_PREFIX.length)
      if (encoded !== prior.attributes[key] || span.attributes[attribute] === undefined
        || JSON.stringify(span.attributes[attribute]) !== JSON.stringify(prior.attributes[attribute])) continue
      let refs: unknown
      try { refs = JSON.parse(encoded) } catch { continue }
      if (Array.isArray(refs) && refs.length > 0 && refs.every(reference)) attributes.set(attribute, refs)
    }
    if (allowed.has(identity(span))) throw new Error('duplicate selected span identity')
    allowed.set(identity(span), attributes)
  }
  if (![...allowed.values()].some((attributes) => attributes.size > 0)) return undefined

  return async (input, context): Promise<ReadSpanSourceResult> => {
    const sourceIndex = input.source_index ?? 0
    const unavailable = (reason: string): ReadSpanSourceResult => ({
      status: 'unavailable', trace_id: input.trace_id, span_id: input.span_id,
      attribute: input.attribute, source_index: sourceIndex, reason,
    })
    const signals = [options.signal, context?.signal].filter((signal): signal is AbortSignal => signal !== undefined)
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
    signal?.throwIfAborted()
    if (![input.offset, input.limit, sourceIndex].every(Number.isSafeInteger)
      || input.offset < 0 || input.limit < 1 || sourceIndex < 0) {
      return unavailable('invalid source window')
    }
    const ref = allowed.get(identity(input))?.get(input.attribute)?.[sourceIndex]
    if (!ref) return unavailable('attribute source was not captured or authorized for these spans')
    const file = sources.get(ref.sourceId)
    if (!file || file.sha256 !== ref.sourceSha256) return unavailable('retained source receipt is missing or mismatched')
    if (ref.recordOffset > file.bytes - ref.recordBytes) {
      return unavailable('source window is outside the recorded bytes')
    }
    if (ref.recordBytes > maxRecordBytes) return unavailable('source record exceeds the configured parsing limit')
    let handle: FileHandle | undefined
    try {
      handle = await openBundleFile(root, file)
      const before = await handle.stat()
      if (await fileDigest(handle, signal) !== file.sha256) return unavailable('retained source digest mismatch')
      const hash = createHash('sha256')
      const record = Buffer.alloc(ref.recordBytes)
      let position = 0
      for await (const raw of handle.createReadStream({
        start: ref.recordOffset, end: ref.recordOffset + ref.recordBytes - 1, autoClose: false, signal,
      })) {
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        hash.update(bytes)
        bytes.copy(record, position)
        position += bytes.length
      }
      const after = await handle.stat()
      if (position !== ref.recordBytes || hash.digest('hex') !== ref.recordSha256
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        return unavailable('retained record digest mismatch or source changed during read')
      }
      if (!isUtf8(record)) return unavailable('source record is not valid UTF-8')
      let value: unknown = JSON.parse(record.toString('utf8'))
      if (ref.fieldLocator !== '#') {
        if (!ref.fieldLocator.startsWith('#/')) return unavailable('invalid source field locator')
        for (const part of ref.fieldLocator.slice(2).split('/')) {
          if (/~(?:[^01]|$)/.test(part)) return unavailable('invalid source field locator')
          const key = part.replaceAll('~1', '/').replaceAll('~0', '~')
          if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return unavailable('source field is missing')
          value = (value as Record<string, unknown>)[key]
        }
      }
      const valueEncoding = typeof value === 'string' ? 'utf8-string' as const : 'json' as const
      const field = Buffer.from(typeof value === 'string' ? value : canonicalJson(value), 'utf8')
      if (field.length === 0) return unavailable('source field is empty')
      if (input.offset > field.length) return unavailable('source offset is outside the selected field')
      const window = field.subarray(input.offset, Math.min(field.length, input.offset + input.limit))
      if (window.length > 0 && (window[0]! & 0xc0) === 0x80) return unavailable('offset splits a UTF-8 character')
      let bytes = window
      for (let omitted = 0; omitted <= 3; omitted += 1) {
        bytes = window.subarray(0, Math.max(0, window.length - omitted))
        if (isUtf8(bytes)) break
      }
      if (!isUtf8(bytes) || bytes.length === 0 && input.offset < field.length) {
        return unavailable('window cannot contain a complete UTF-8 character')
      }
      const next = input.offset + bytes.length
      return {
        status: 'available', trace_id: input.trace_id, span_id: input.span_id,
        attribute: input.attribute, source_index: sourceIndex, text: bytes.toString('utf8'),
        offset: input.offset, total_bytes: field.length, next_offset: next < field.length ? next : null,
        source: {
          source_id: ref.sourceId, source_sha256: file.sha256,
          record_sha256: ref.recordSha256, field_locator: ref.fieldLocator, value_encoding: valueEncoding,
        },
      }
    } catch {
      signal?.throwIfAborted()
      return unavailable('retained source is missing, inaccessible, or unsafe')
    } finally {
      await handle?.close()
    }
  }
}

/** Keep analysis artifacts from changing an authorized retained archive. */
export async function assertOutsideSourceBundle(directory: string, outputPath: string): Promise<void> {
  const root = await realpath(directory)
  let ancestor = resolve(outputPath)
  while (true) {
    try {
      ancestor = await realpath(ancestor)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
  const within = (path: string): boolean => {
    const location = relative(root, path)
    return location === '' || location !== '..' && !location.startsWith(`..${sep}`) && !location.startsWith(sep)
  }
  if (within(resolve(outputPath)) || within(ancestor)) throw new Error('analysis output must be outside the retained source bundle')
}
