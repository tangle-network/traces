/**
 * Resolve an arm's citation to the source records it names.
 *
 * Gold quotes name a record by `<file>:<line>`, which any arm can produce from
 * the raw files. A traces arm cites span ids instead; those resolve through the
 * source-record offsets the traces adapters attach to each span, so a span id
 * counts only when the span really came from the gold record. The gold itself
 * never passes through an adapter.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ClaudeAdapter } from '../../src/adapters/claude.js'
import { CodexAdapter } from '../../src/adapters/codex.js'
import { SOURCE_ATTRIBUTE_PREFIX, sourceFileId, type SourceRecordReference } from '../../src/source-location.js'
import type { HarnessTraceAdapter } from '../../src/types.js'
import type { BenchManifest } from './fixtures.js'

export interface RecordRef {
  file: string
  line: number
}

export interface CitationIndex {
  /** The records a citation names, or undefined when it names nothing known. */
  resolve(cite: string): readonly RecordRef[] | undefined
  /** Whether a record holds the text in one of its decoded string values. */
  contains(ref: RecordRef, text: string): boolean
}

/** Whitespace-insensitive form used for every text comparison. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function stringValues(value: unknown, out: string[]): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) stringValues(item, out)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) stringValues(item, out)
  return out
}

const TRACE_URI = /^trace:\/\/([^/]+)\/span\/([^/]+)$/
const LINE_CITE = /^(.+):(\d+)$/

/**
 * An index over the fixture files alone: it resolves `<file>:<line>` citations.
 * `spans` adds span-id aliases, each mapped to the records its span came from.
 */
export function createCitationIndex(
  files: ReadonlyMap<string, string>,
  spans: ReadonlyMap<string, readonly RecordRef[]> = new Map(),
): CitationIndex {
  const lines = new Map<string, string[]>()
  const byBasename = new Map<string, string[]>()
  for (const [path, content] of files) {
    lines.set(path, content.split('\n'))
    const base = path.split('/').at(-1)!
    byBasename.set(base, [...(byBasename.get(base) ?? []), path])
  }
  const decoded = new Map<string, string[]>()

  const fileFor = (raw: string): string | undefined => {
    const path = raw.replace(/^\.\//, '').replace(/^fixtures\//, '')
    if (files.has(path)) return path
    const matches = byBasename.get(path.split('/').at(-1) ?? '') ?? []
    return matches.length === 1 ? matches[0] : undefined
  }

  return {
    resolve(cite) {
      const trimmed = cite.trim()
      const uri = TRACE_URI.exec(trimmed)
      const spanKey = uri ? decodeURIComponent(uri[2]!) : trimmed
      const bySpan = spans.get(spanKey)
      if (bySpan) return bySpan
      const lineCite = LINE_CITE.exec(trimmed)
      if (!lineCite) return undefined
      const file = fileFor(lineCite[1]!)
      const line = Number(lineCite[2])
      if (!file || line < 1 || line > (lines.get(file)?.length ?? 0)) return undefined
      return [{ file, line }]
    },
    contains(ref, text) {
      const key = `${ref.file}:${ref.line}`
      let values = decoded.get(key)
      if (!values) {
        const raw = lines.get(ref.file)?.[ref.line - 1] ?? ''
        let parsed: unknown = raw
        try {
          parsed = JSON.parse(raw) as unknown
        } catch {
          // A non-JSON line is compared as raw text.
        }
        values = stringValues(parsed, []).map(normalizeText)
        decoded.set(key, values)
      }
      const wanted = normalizeText(text)
      return wanted.length > 0 && values.some((value) => value.includes(wanted))
    },
  }
}

function lineStarts(content: Buffer): number[] {
  const starts = [0]
  for (let index = 0; index < content.length; index += 1) if (content[index] === 0x0a) starts.push(index + 1)
  return starts
}

const ADAPTERS: Record<string, HarnessTraceAdapter> = {
  codex: new CodexAdapter(),
  'claude-code': new ClaudeAdapter(),
}

/**
 * Parse every fixture session through its traces adapter and map each span id
 * (hex wire id and unambiguous readable source id) to the records it came from.
 */
export async function spanRecordMap(root: string, manifest: BenchManifest): Promise<Map<string, RecordRef[]>> {
  const fileById = new Map<string, { path: string; starts: number[] }>()
  for (const path of manifest.files) {
    const bytes = await readFile(join(root, path))
    fileById.set(sourceFileId(join(root, path)), { path, starts: lineStarts(bytes) })
  }
  const spans = new Map<string, RecordRef[]>()
  const readable = new Map<string, RecordRef[][]>()
  for (const session of manifest.sessions) {
    const adapter = ADAPTERS[session.harness]
    if (!adapter) throw new Error(`no adapter for ${session.harness}`)
    const parsed = await adapter.parse({
      harness: session.harness,
      sessionId: session.sessionId,
      path: join(root, session.path),
      cwd: null,
      mtimeMs: 0,
    }, { captureSources: true })
    for (const span of parsed) {
      const refs = new Map<string, RecordRef>()
      for (const [key, value] of Object.entries(span.attributes)) {
        if (!key.startsWith(SOURCE_ATTRIBUTE_PREFIX) || typeof value !== 'string') continue
        for (const ref of JSON.parse(value) as SourceRecordReference[]) {
          const file = fileById.get(ref.sourceId)
          if (!file) continue
          const index = file.starts.indexOf(ref.recordOffset)
          if (index >= 0) refs.set(`${file.path}:${index + 1}`, { file: file.path, line: index + 1 })
        }
      }
      const records = [...refs.values()]
      // A span that carries no source record names nothing. Mapping it to an empty list
      // would report a citation of it as resolved, which is what citing a real but wrong
      // record looks like, and the two failures have to stay apart in the report.
      if (records.length === 0) continue
      spans.set(span.span_id, records)
      for (const key of ['traces.codex.source_span_id', 'traces.claude.source_span_id']) {
        const alias = span.attributes[key]
        if (typeof alias === 'string') readable.set(alias, [...(readable.get(alias) ?? []), records])
      }
    }
  }
  // A readable id shared by two sessions (a fork repeats its parent's call ids) names nothing.
  for (const [alias, candidates] of readable) if (candidates.length === 1 && !spans.has(alias)) spans.set(alias, candidates[0]!)
  return spans
}

/** The full index an arm's answers are scored against. */
export async function loadCitationIndex(root: string, manifest: BenchManifest): Promise<CitationIndex> {
  const files = new Map<string, string>()
  for (const path of manifest.files) files.set(path, await readFile(join(root, path), 'utf8'))
  return createCitationIndex(files, await spanRecordMap(root, manifest))
}
