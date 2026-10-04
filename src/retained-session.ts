import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { sessionIdFromAttributes, stampSessionIdentity } from './attributes.js'
import { stampSessionIntegrity } from './integrity.js'
import type { OtlpSpan } from './otlp.js'
import { computeSessionFacts } from './session-facts.js'
import { resolveAdapter } from './registry.js'
import { validateOtlpSpans } from './span-validation.js'
import type { SessionRef } from './types.js'

export const RETAINED_SESSION_READER_VERSION = '2'

export interface RetainedSessionFile {
  readonly path: string
  readonly content: string
}

export interface RetainedSessionSelection {
  readonly status: 'selected' | 'unavailable'
  readonly reason: string | null
  readonly sessionId: string | null
  readonly sourceFiles: readonly { readonly path: string; readonly sha256: string }[]
  readonly duplicateFiles: readonly string[]
  readonly unselectedFiles: readonly { readonly path: string; readonly reason: string }[]
  readonly spans: readonly OtlpSpan[]
}

/**
 * Parse an explicitly retained capture without consulting the host's session catalog.
 * Native identity must come from the adapter's records. A path, caller supplied
 * fallback ID, or worker name never establishes identity. Runtime owns custody,
 * hash verification, capture completeness, and the binding to its node.
 */
export async function parseRetainedSession(input: {
  readonly harness: string
  readonly nativeSessionId: string | null
  readonly files: readonly RetainedSessionFile[]
  readonly signal?: AbortSignal
}): Promise<RetainedSessionSelection> {
  input.signal?.throwIfAborted()
  const unselectedFiles: { path: string; reason: string }[] = []
  const unavailable = (reason: string): RetainedSessionSelection => ({
    status: 'unavailable', reason, sessionId: input.nativeSessionId,
    sourceFiles: [], duplicateFiles: [], unselectedFiles, spans: [],
  })
  if (!input.nativeSessionId) return unavailable('Capture has no recorded native session identity.')
  const adapter = resolveAdapter(input.harness)
  if (!adapter) return unavailable(`No native trace adapter for ${input.harness}.`)
  if (input.files.length > 1024) return unavailable('Retained capture exceeds 1024 text files.')
  let totalBytes = 0
  for (const file of input.files) {
    const bytes = Buffer.byteLength(file.content)
    totalBytes += bytes
    if (bytes > 16 * 1024 ** 2 || totalBytes > 64 * 1024 ** 2) {
      return unavailable('Retained capture exceeds the 16 MiB per-file or 64 MiB total text limit.')
    }
  }
  const root = await mkdtemp(join(tmpdir(), 'traces-retained-'))
  try {
    const files = new Map<string, RetainedSessionFile>()
    for (const file of input.files) {
      input.signal?.throwIfAborted()
      const path = resolve(root, file.path)
      const rel = relative(root, path)
      if (!file.path || isAbsolute(file.path) || file.path.includes('\\') || file.path.includes('\0')
        || rel === '' || rel === '..' || rel.startsWith('../') || files.has(path)) {
        throw new Error('Retained source paths must be unique relative files inside the capture.')
      }
      files.set(path, file)
    }
    for (const [path, file] of files) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, file.content, { mode: 0o600, flag: 'wx' })
    }
    const selected: { file: RetainedSessionFile; paths: readonly string[]; spans: OtlpSpan[] }[] = []
    for (const [path, file] of files) {
      input.signal?.throwIfAborted()
      // The fallback is deliberately different from the claimed native ID.
      const fallback = `unattributed:${root}:${file.path}`
      const ref: SessionRef = { harness: adapter.harness, sessionId: fallback, path, cwd: null, mtimeMs: 0 }
      try {
        const sources = adapter.sourcePaths ? await adapter.sourcePaths(ref, { signal: input.signal }) : [path]
        if (sources.some((source) => !files.has(resolve(source)))) {
          throw new Error('Parser requires files outside the supplied retained capture.')
        }
        const spans = validateOtlpSpans(await adapter.parse(ref, {
          corruptionMode: 'recover', taskScope: 'all', captureSources: false, signal: input.signal,
        }), `${adapter.harness} retained adapter output`)
        const roots = spans.filter((span) => span.parent_span_id === null)
        const identities = new Set(roots.map((span) => sessionIdFromAttributes(span.attributes)))
        if (identities.size !== 1 || !identities.has(input.nativeSessionId)) {
          unselectedFiles.push({ path: file.path, reason: 'No unambiguous matching native identity in parser output.' })
          continue
        }
        if (computeSessionFacts(spans, { includeContent: false }).every((facts) => facts.recordSpans === 0)) {
          unselectedFiles.push({ path: file.path, reason: 'Native identity was recorded without any session records.' })
          continue
        }
        stampSessionIntegrity(ref, spans)
        stampSessionIdentity(spans, input.nativeSessionId)
        // Parser source paths name the private staging directory. Retain stable logical
        // paths instead, so re-reading the same capture has the same span digest.
        for (const span of spans) {
          for (const [key, value] of Object.entries(span.attributes)) {
            if (typeof value === 'string' && value.includes(root)) {
              span.attributes[key] = value.split(root + '/').join('retained://')
            }
          }
        }
        selected.push({ file, paths: sources, spans })
      } catch (error) {
        input.signal?.throwIfAborted()
        // Parser errors may include native content; retain a structural diagnostic only.
        unselectedFiles.push({ path: file.path, reason: `Native parser could not read this file (${error instanceof Error ? error.name : 'Error'}).` })
      }
    }
    if (!selected.length) return unavailable('No retained parser entrypoint established the recorded native session identity.')
    // Multiple workspace roots can retain the same session. Count an identical
    // or append-only snapshot once; differing histories need an explicit decision.
    selected.sort((a, b) => b.file.content.length - a.file.content.length || a.file.path.localeCompare(b.file.path))
    const chosen = selected[0]!
    if (selected.some((candidate) => !chosen.file.content.startsWith(candidate.file.content))) {
      return unavailable('Retained files contain divergent histories for the same native session.')
    }
    return {
      status: 'selected', reason: null, sessionId: input.nativeSessionId,
      sourceFiles: chosen.paths.map((path) => {
        const file = files.get(resolve(path))!
        return { path: file.path, sha256: `sha256:${createHash('sha256').update(file.content).digest('hex')}` }
      }).sort((a, b) => a.path.localeCompare(b.path)),
      duplicateFiles: selected.slice(1).map((candidate) => candidate.file.path),
      unselectedFiles, spans: chosen.spans,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
