import type { Stats } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { CODEX_HOME_RULE, isCodexHome, listReaders } from '@tangle-network/harness-sessions'
import { nativePresentation } from './adapters/native-stores.js'
import type { SessionRef } from './types.js'
import { isCodexExecRecord } from './adapters/codex-exec.js'
import { detectEvidenceFormat, type TraceEvidenceInputFormat } from './file-export.js'
import { readJsonl } from './jsonl.js'
import { isObject, isOtlpJsonFile, isStandardOtlpRow } from './otlp-input.js'
import { isCompressedJsonlFile } from './span-validation.js'

/** Harness stores a session file can sit in, by the path segment that names the store. */
export const STORE_PATHS: ReadonlyArray<{ readonly harness: string; readonly root: string }> = listReaders().flatMap(reader =>
  reader.stores.map(store => ({ harness: nativePresentation(reader).display, root: store.root })),
)

/** The harness whose store holds `path`, from the path alone. */
export function harnessOfStorePath(path: string): string | undefined {
  const absolute = resolve(path)
  for (const { harness, root } of STORE_PATHS) {
    if (absolute.includes(`${sep}${root.split('/').join(sep)}${sep}`)) return harness
  }
  // A Codex rollout under any Codex home's `sessions/` or `archived_sessions/`.
  const segments = absolute.split(sep)
  for (let i = 1; i < segments.length - 1; i += 1) {
    if (!(CODEX_HOME_RULE.sessionDirs as readonly string[]).includes(segments[i + 1]!)) continue
    if (isCodexHome(segments.slice(0, i + 1).join(sep))) return 'codex'
  }
  return undefined
}

const HEAD_ROWS = 20
/** A JSON document (not JSONL) is parsed whole to be sniffed; past this it must be named with --format. */
const MAX_WHOLE_JSON_BYTES = 256 * 1024 * 1024
const CODEX_ROLLOUT_TYPES = new Set(['session_meta', 'response_item', 'event_msg', 'turn_context'])

/** The first rows of a JSONL file, or the rows of a JSON document. */
async function headRows(path: string): Promise<unknown[]> {
  const rows: unknown[] = []
  let unparsed = 0
  for await (const row of readJsonl<unknown>(path, { mode: 'recover', onCorruption: () => { unparsed += 1 } })) {
    rows.push(row)
    // A distinctive native row identifies a long rollout without reading the next tool result.
    if (nativeFormat(row) || rows.length >= HEAD_ROWS) return rows
  }
  if (rows.length > 0 && unparsed === 0) {
    // A one-line JSON document: an array of events, or an `{ events }` wrapper.
    const only = rows.length === 1 ? rows[0] : undefined
    if (Array.isArray(only)) return only
    if (isObject(only) && Array.isArray(only.events)) return only.events
    return rows
  }
  // A pretty-printed JSON document reads as no JSONL at all.
  const info = await stat(path)
  if (info.size > MAX_WHOLE_JSON_BYTES) return rows
  const parsed: unknown = await readFile(path, 'utf8').then((text) => JSON.parse(text) as unknown).catch(() => undefined)
  if (parsed === undefined) return rows
  if (Array.isArray(parsed)) return parsed
  if (isObject(parsed) && Array.isArray(parsed.events)) return parsed.events
  return [parsed]
}

function nativeFormat(row: unknown): string | undefined {
  if (!isObject(row)) return undefined
  if ((typeof row.sessionId === 'string' || typeof row.session_id === 'string')
    && typeof row.type === 'string' && ('message' in row || 'uuid' in row || 'subtype' in row)) return 'claude-code'
  if (CODEX_ROLLOUT_TYPES.has(String(row.type)) && isObject(row.payload)) return 'codex'
  if (row.type === 'session' && typeof row.id === 'string') return 'pi'
  if (row.type === 'session_start') return 'factory'
  const update = isObject(row.params) && isObject(row.params.update) ? row.params.update : isObject(row.update) ? row.update : row
  if (typeof update.sessionUpdate === 'string') return 'grok'
  if (row.type === 'context.append_loop_event' && isObject(row.event)
    || row.type === 'profile.bind' && isObject(row.environmentDisclosure)
    || isObject(row.message) && typeof row.message.type === 'string' && isObject(row.message.payload)) return 'kimi'
  return isCodexExecRecord(row) ? 'codex-exec' : undefined
}

export type FileFormat =
  | { readonly kind: 'session'; readonly harness: string }
  | { readonly kind: 'spans'; readonly reader: 'otlp' | TraceEvidenceInputFormat }

// Loose retained files and native stores use the same physical record signatures.
export async function recordedFileFormat(path: string, store?: string, requested?: string): Promise<FileFormat | undefined> {
  // Standard OTLP/JSON is known from its first bytes; its lines can be too large to parse just to look.
  if (isCompressedJsonlFile(path) || await isOtlpJsonFile(path)) return { kind: 'spans', reader: 'otlp' }
  const rows = await headRows(path)
  if (rows.length > 0 && rows.every((row) => isObject(row) && typeof row.trace_id === 'string' && typeof row.span_id === 'string')) {
    return { kind: 'spans', reader: 'otlp' }
  }
  // Standard OTLP/JSON (`resourceSpans`), or the camelCase span rows Tangle Intelligence serves.
  if (rows.length > 0 && rows.every(isStandardOtlpRow)) return { kind: 'spans', reader: 'otlp' }
  if (!rows.some((row) => isObject(row) && typeof row.span_id === 'string')) {
    for (const row of rows) {
      const format = nativeFormat(row)
      if (format) {
        // Prime writes Pi records but owns the session ID in its filename.
        const harness = format === 'pi' && (store ?? requested) === 'prime' ? 'prime' : format
        return { kind: 'session', harness }
      }
    }
  }
  const evidence = detectEvidenceFormat(rows)
  if (evidence === 'sandbox-events') {
    // A Sandbox live stream opens with the sandbox's own events; its first
    // Codex envelope can come after any number of them. Discovery's rule is
    // the same: any `"backend":"codex"` envelope makes the file a live stream.
    for await (const row of readJsonl<unknown>(path, { mode: 'recover', onCorruption: () => {} })) {
      if (isCodexExecRecord(row)) return { kind: 'session', harness: 'codex-exec' }
    }
  }
  if (evidence) return { kind: 'spans', reader: evidence }
  return undefined
}

export function incompatibleFile(format: FileFormat | undefined, requested: string): string | undefined {
  if (!format) return undefined
  const actual = format.kind === 'session' ? format.harness : format.reader
  return actual === requested ? undefined : `expected ${requested}, found ${actual} records`
}

// A file ref is normally resolved and read in the same call. Recheck the bytes if a writer
// changes or replaces the file between reads. The entry's lifetime is the caller's reference.
const inspected = new WeakMap<SessionRef, { stamp: string; format: FileFormat | undefined }>()
const fileStamp = (s: Stats): string => `${s.dev}:${s.ino}:${s.size}:${s.ctimeMs}:${s.mtimeMs}`

export function rememberFileFormat(ref: SessionRef, stat: Stats, format: FileFormat | undefined): void {
  inspected.set(ref, { stamp: fileStamp(stat), format })
}

export async function checkNativeFile(ref: SessionRef, harness: string): Promise<FileFormat | undefined> {
  const info = await stat(ref.path)
  if (!info.isFile()) return undefined
  const previous = inspected.get(ref)
  const format = previous?.stamp === fileStamp(info)
    ? previous.format : await recordedFileFormat(ref.path, harnessOfStorePath(ref.path), harness)
  const mismatch = incompatibleFile(format, harness)
  if (mismatch) throw new Error(`${ref.path}: ${mismatch}`)
  rememberFileFormat(ref, info, format)
  return format
}

export async function isClaudeStreamJson(path: string): Promise<boolean> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(65536)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n').slice(0, 20)) {
      if (!line || line.length > 60000) continue
      try {
        const row = JSON.parse(line) as { type?: string; subtype?: string }
        if (row.type === 'system' && row.subtype === 'init') return true
      } catch {
        // A torn head is the shared reader's integrity decision.
      }
    }
    return false
  } finally {
    await file.close()
  }
}
