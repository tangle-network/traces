/**
 * Refs: what a positional argument names, read for what it is, so no flag
 * names its type.
 *
 *   1. An existing path is read by its content: a harness session file (its
 *      records identify the format, its store disambiguates shared formats), a Sandbox
 *      live stream (Codex events in `raw` envelopes, read by codex-exec), a
 *      sandbox-events recording, OTLP or OpenInference JSONL, standard
 *      OTLP/JSON (`resourceSpans`, one document or one envelope per line),
 *      the span rows Tangle Intelligence serves, a
 *      directory of OTLP files, a bundle directory, a Runtime run directory,
 *      or a store root: a directory that holds harness stores the way a home
 *      does (a trace archive's `<host>/home`, a fleet seat). `path#<trace id>`
 *      and `path#branch=<id>` pick one run from a span file. A native
 *      SQLite database takes `path#session=<exact native id>`.
 *   2. Anything else is a session id, or a unique prefix or suffix of at least
 *      8 characters, looked up across every harness (in the store root named
 *      beside it, when there is one).
 *
 * `--harness` requires a compatible file reader and narrows an id lookup; an
 * input format named on the command line forces how a file ref is read.
 */

import type { Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { CODEX_HOME_RULE, codexHomes, isNativeStoreDatabase, nativeStoreSessions, type SessionRef as NativeRef } from '@tangle-network/harness-sessions'
import { ATTR } from '@tangle-network/agent-trace-contract'
import { readsStoreRoots } from './adapters/harness-sessions.js'
import { exportTraceEvidenceFile, type TraceEvidenceInputFormat } from './file-export.js'
import { harnessOfStorePath, incompatibleFile, recordedFileFormat, rememberFileFormat, STORE_PATHS, type FileFormat } from './session-file-format.js'
import type { OtlpSpan } from './otlp.js'
import { resolveOtlpInputFiles } from './otlp-input.js'
import { readConsistentOtlpInput } from './otlp-measurement.js'
import { listAdapters, resolveAdapter } from './registry.js'
import { parseSession } from './session-source.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'

/** The shortest prefix or suffix that names a session. Codex ids are UUIDv7, whose first 6 hex characters change every few hours. */
export const MIN_REF_CHARS = 8

export type RefErrorCode = 'usage' | 'unreadable' | 'ambiguous'

export interface RefCandidate {
  readonly harness: string
  readonly sessionId: string
  readonly path: string
}

/** A ref that names nothing, or more than one thing. Every such ref exits 2. */
export class RefError extends Error {
  readonly code: RefErrorCode
  readonly candidates: readonly RefCandidate[]

  constructor(message: string, code: RefErrorCode, candidates: readonly RefCandidate[] = []) {
    super(message)
    this.name = 'RefError'
    this.code = code
    this.candidates = candidates
  }
}

/** How a span file is read: as OTLP, or converted from one evidence format. */
export type SpanReader = 'otlp' | TraceEvidenceInputFormat

export type ResolvedRef =
  | { readonly kind: 'session'; readonly ref: string; readonly adapter: HarnessTraceAdapter; readonly session: SessionRef }
  | { readonly kind: 'spans'; readonly ref: string; readonly path: string; readonly reader: SpanReader; readonly selector?: string }
  | { readonly kind: 'run-dir'; readonly ref: string; readonly path: string }
  | { readonly kind: 'store-root'; readonly ref: string; readonly path: string }

export interface ResolveRefOptions {
  /** `--harness` as given: requires a compatible file reader and narrows an id lookup. */
  readonly harness?: string
  /** An input format named on the command line: forces how a file ref is read. */
  readonly format?: SpanReader
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function statOf(path: string): Promise<Stats | null> {
  try {
    return await stat(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

const isDirectory = async (path: string): Promise<boolean> => (await statOf(path))?.isDirectory() ?? false
const isFile = async (path: string): Promise<boolean> => (await statOf(path))?.isFile() ?? false
const ownHome = (): string => process.env.HOME || homedir()

// ── Files ─────────────────────────────────────────────────────────────

function adapterFor(harness: string): HarnessTraceAdapter {
  const adapter = resolveAdapter(harness)
  if (!adapter) {
    throw new RefError(`unknown harness "${harness}"; known: ${listAdapters().map((a) => a.harness).join(', ')}`, 'usage')
  }
  return adapter
}

async function sqliteSessionRef(path: string, ref: string, selector: string | undefined, options: ResolveRefOptions): Promise<ResolvedRef> {
  if (selector !== undefined && (!selector.startsWith('session=') || selector === 'session=')) {
    throw new RefError(`${ref}: select a native session with #session=<exact native id>`, 'usage')
  }
  const id = selector?.slice('session='.length)
  const absolute = resolve(path)
  const selected = options.harness ? adapterFor(options.harness) : undefined
  if (selected && (!readsStoreRoots(selected) || !selected.readsSqlite())) {
    throw new RefError(`${ref}: --harness ${options.harness} does not read a SQLite session store`, 'usage')
  }
  let rows: NativeRef[]
  try {
    rows = await nativeStoreSessions(absolute, { harness: selected?.harness, nativeSessionId: id })
  } catch (error) {
    // The SDK requires a harness for a mixed schema. Resolve its choices for the CLI diagnostic.
    if (!selected && error instanceof Error && !('code' in error)) {
      const catalogs = await Promise.allSettled(listAdapters().filter(readsStoreRoots)
        .filter(adapter => adapter.readsSqlite())
        .map(adapter => nativeStoreSessions(absolute, { harness: adapter.nativeHarness })))
      const choices = catalogs.flatMap(catalog => catalog.status === 'fulfilled' ? catalog.value : [])
      if (new Set(choices.map(row => row.harness)).size > 1) {
        throw new RefError(`${path} contains multiple native harnesses; select one with --harness`, 'ambiguous',
          choices.map(row => ({ harness: row.harness, sessionId: row.nativeSessionId, path: absolute })))
      }
    }
    throw new RefError(`${path}: ${errorText(error)}`, 'unreadable')
  }
  if (!rows.length) {
    throw new RefError(id ? `${path} has no exact native session ${id}` : `${path} is not a recognized native session SQLite store`, 'unreadable')
  }
  if (rows.length > 1) {
    throw new RefError(`${path} contains ${rows.length} matching native sessions; select one with #session=<exact native id>`, 'ambiguous',
      rows.map(row => ({ harness: row.harness, sessionId: row.nativeSessionId, path: absolute })))
  }
  const row = rows[0]!
  const adapter = adapterFor(row.harness)
  if (!readsStoreRoots(adapter)) throw new RefError(`${row.harness} has no native store reader`, 'unreadable')
  return { kind: 'session', ref, adapter, session: adapter.bindNativeRef(row) }
}

// A Grok session is its updates log plus named companions, including events.jsonl in the 0.x store.
function isGrokSessionFile(path: string, stored: string | undefined): boolean {
  const name = basename(path)
  if (name === 'events.jsonl') return stored === 'grok'
  const grok = resolveAdapter('grok')
  return grok !== undefined && readsStoreRoots(grok) && grok.nativeStores.some(store => store.files.some(file => basename(file) === name))
}

async function fileRef(path: string, ref: string, selector: string | undefined, options: ResolveRefOptions): Promise<ResolvedRef> {
  if (options.format) return { kind: 'spans', ref, path, reader: options.format, ...(selector ? { selector } : {}) }
  // A retained database can have any name, even inside another harness's inferred store root.
  if (await isNativeStoreDatabase(path)) return sqliteSessionRef(path, ref, selector, options)
  const requested = options.harness ? adapterFor(options.harness).harness : undefined
  const stored = harnessOfStorePath(path)
  const sourceInfo = await stat(path)
  const recorded = await recordedFileFormat(path, stored, requested)
  const grokFile = isGrokSessionFile(path, stored)
  const fallback = (stored === 'grok' && !grokFile ? undefined : stored) ?? requested
  const sniffed: FileFormat = recorded ?? (fallback ? { kind: 'session', harness: fallback } : { kind: 'spans', reader: 'otlp' })
  const mismatch = requested && incompatibleFile(sniffed, requested)
  if (mismatch) throw new RefError(`${path}: ${mismatch}`, 'unreadable')
  if (sniffed.kind === 'spans') return { kind: 'spans', ref, path, reader: sniffed.reader, ...(selector ? { selector } : {}) }
  if (selector) throw new RefError(`${ref}: a #selector picks a run from a span file; ${path} is a ${sniffed.harness} session`, 'usage')
  const adapter = adapterFor(sniffed.harness)
  const session = adapter.harness === 'grok' && grokFile ? join(dirname(path), 'updates.jsonl') : path
  const info = session === path ? sourceInfo : await stat(session)
  const selected = { harness: adapter.harness, sessionId: ref, path: session, cwd: null, mtimeMs: info.mtimeMs }
  if (session === path) rememberFileFormat(selected, info, recorded)
  return { kind: 'session', ref, adapter, session: selected }
}

// ── Directories ───────────────────────────────────────────────────────

/** Session stores traces reads under a home, besides the Codex homes. */
const HOME_STORES = [...new Set(STORE_PATHS.map((store) => store.root))]

/** True when `dir` holds harness stores the way a home does. */
export async function isStoreRoot(dir: string): Promise<boolean> {
  for (const root of HOME_STORES) if (await isDirectory(join(dir, root))) return true
  for (const home of await codexHomes(dir)) {
    for (const sessions of CODEX_HOME_RULE.sessionDirs) if (await isDirectory(join(home, sessions))) return true
  }
  return false
}

/** Where a bundle keeps its spans: 1.0's layout, then a 0.x bundle's, which stays readable as evidence. */
const BUNDLE_SPAN_FILES = ['spans.otlp.jsonl', join('derived', 'trace.otlp.jsonl')]

/**
 * A retained tree can hold one session at several points in its life, one copy per attempt: the same
 * file name, each a byte prefix of the longest. Only the longest is the session; a different file
 * that happens to share the name stays.
 */
async function withoutEarlierCopies(paths: readonly string[]): Promise<string[]> {
  const byName = new Map<string, string[]>()
  for (const path of paths) byName.set(basename(path), [...byName.get(basename(path)) ?? [], path])
  const kept: string[] = []
  for (const copies of byName.values()) {
    const bytes = await Promise.all(copies.map(async (path) => ({ path, body: copies.length > 1 ? await readFile(path) : Buffer.alloc(0) })))
    const longest = bytes.reduce((best, copy) => (copy.body.length > best.body.length ? copy : best))
    kept.push(...bytes.filter(({ path, body }) => path === longest.path || !longest.body.subarray(0, body.length).equals(body)).map(({ path }) => path))
  }
  return kept
}

async function directoryRef(path: string, ref: string): Promise<ResolvedRef | ResolvedRef[]> {
  if (await isFile(join(path, 'manifest.json'))) {
    for (const file of BUNDLE_SPAN_FILES) {
      if (await isFile(join(path, file))) return { kind: 'spans', ref, path: join(path, file), reader: 'otlp' }
    }
    throw new RefError(`${ref} has a manifest.json but no spans.otlp.jsonl; it is not a traces bundle`, 'unreadable')
  }
  // The run-tree reader is loaded only for a directory ref, so other commands never load it.
  const { findSupervisorRunDirs, isRuntimeSupervisorRunDir } = await import('@tangle-network/agent-eval/supervisor-run')
  if (await isRuntimeSupervisorRunDir(path)) return { kind: 'run-dir', ref, path }
  if (await isStoreRoot(path)) return { kind: 'store-root', ref, path: resolve(path) }
  if ((await findSupervisorRunDirs(path)).length > 0) return { kind: 'run-dir', ref, path }
  // A tree with no OTLP in it may hold retained session files, each read by its content.
  const { files, skipped } = await resolveOtlpInputFiles(path, true)
  // A Claude subagent transcript (`<id>/subagents/**/*.jsonl`, harness-sessions' catalog) is read with its parent `<id>.jsonl`.
  const paths = new Set(skipped.map((file) => file.path)), parts = (path: string) => path.split(`${sep}subagents${sep}`), folded = (path: string) => parts(path).slice(1).some((_, i) => paths.has(`${parts(path).slice(0, i + 1).join(`${sep}subagents${sep}`)}.jsonl`))
  const sessionFiles = files.length > 0 ? [] : await withoutEarlierCopies([...paths].filter((path) => !folded(path)))
  const refs = await Promise.all(sessionFiles.map((file) => fileRef(file, file, undefined, {})))
  // A harness's own store is the session; a recording beside it, such as a Sandbox event stream, is a derived copy.
  // Sibling files of one Grok session resolve to the same record; each session is read once.
  const sessions = [...new Map(refs.filter((found) => found.kind === 'session').map((found) => [found.session.path, found])).values()]
  const stored = sessions.filter((found) => harnessOfStorePath(found.session.path))
  return stored.length > 0 ? stored : sessions.length > 0 ? sessions : { kind: 'spans', ref, path, reader: 'otlp' }
}

// ── Session ids ───────────────────────────────────────────────────────

/** A ref that cannot be an id: it names a path that does not exist. */
function looksLikePath(ref: string): boolean {
  return ref.includes('/') || ref.startsWith('.') || ref.startsWith('~') || /\.(?:jsonl|ndjson|json|db)$/iu.test(ref)
}

interface Found {
  readonly adapter: HarnessTraceAdapter
  readonly session: SessionRef
}

const candidate = ({ adapter, session }: Found): RefCandidate => ({ harness: adapter.harness, sessionId: session.sessionId, path: session.path })

/** Shorter than this, a ref is a prefix or suffix: no harness writes ids this short. */
const COMPLETE_ID_CHARS = 20

/**
 * The one session whose id is `query`, or starts or ends with it. An exact
 * id anywhere wins over a prefix or suffix anywhere.
 */
async function lookupSession(query: string, options: ResolveRefOptions, storeRoot: string | undefined): Promise<ResolvedRef> {
  const short = query.length < MIN_REF_CHARS
  const home = storeRoot ?? ownHome()
  const selected: readonly HarnessTraceAdapter[] = options.harness ? [adapterFor(options.harness)] : listAdapters()
  const adapters: readonly HarnessTraceAdapter[] = storeRoot === undefined ? selected : selected.filter(readsStoreRoots)
  const failures = new Map<string, string>()
  // An adapter that cannot look up one id lists every session, once for both passes.
  const listed = new Map<HarnessTraceAdapter, Promise<SessionRef[]>>()
  const sessionsOf = (adapter: HarnessTraceAdapter, exact: boolean): Promise<SessionRef[]> => {
    if (readsStoreRoots(adapter) && exact) return adapter.locateIn(home, { nativeSessionId: query })
    let all = listed.get(adapter)
    if (!all) {
      all = readsStoreRoots(adapter) ? adapter.locateIn(home) : adapter.locate()
      listed.set(adapter, all)
    }
    return all
  }
  const search = async (exact: boolean): Promise<Found[]> => {
    const found = new Map<string, Found>()
    for (const adapter of adapters) {
      let sessions: SessionRef[]
      try {
        sessions = await sessionsOf(adapter, exact)
      } catch (error) {
        failures.set(adapter.harness, errorText(error))
        continue
      }
      for (const session of sessions) {
        const id = session.sessionId
        if (id === query || (!exact && (id.startsWith(query) || id.endsWith(query)))) {
          found.set(`${adapter.harness}\0${session.path}\0${id}`, { adapter, session })
        }
      }
    }
    return [...found.values()].sort((a, b) => b.session.mtimeMs - a.session.mtimeMs)
  }
  // A whole id is looked up directly; a prefix or suffix needs every session listed.
  let found = query.length >= COMPLETE_ID_CHARS || short ? await search(true) : []
  if (found.length === 0 && short) {
    throw new RefError(
      `"${query}" is not a file, a directory or a session id, and a session id prefix or suffix needs at least ${MIN_REF_CHARS} characters`,
      'usage',
    )
  }
  if (found.length === 0) {
    const matched = await search(false)
    const exact = matched.filter(({ session }) => session.sessionId === query)
    found = exact.length > 0 ? exact : matched
  }
  if (found.length === 1) return { kind: 'session', ref: query, adapter: found[0]!.adapter, session: found[0]!.session }
  const where = storeRoot === undefined ? '' : ` under ${storeRoot}`
  if (found.length === 0) {
    const unread = failures.size > 0 ? `; could not read ${[...failures].map(([harness, reason]) => `${harness}: ${reason}`).join('; ')}` : ''
    throw new RefError(
      `no session id is, starts with or ends with "${query}"${where} (${adapters.map((a) => a.harness).join(', ')})${unread}; ` +
        '`traces list` shows ids',
      'unreadable',
    )
  }
  const shown = found.slice(0, 5).map((item) => `${item.adapter.harness} ${item.session.sessionId}`)
  const more = found.length > shown.length ? ` and ${found.length - shown.length} more` : ''
  throw new RefError(
    `"${query}" matches ${found.length} sessions${where} (${shown.join(', ')}${more}); pass more of the id`,
    'ambiguous',
    found.map(candidate),
  )
}

/**
 * For each id, the shortest form a ref resolves to it alone among `ids`: a
 * prefix or a suffix of at least {@link MIN_REF_CHARS} characters that no
 * other id starts or ends with, the shorter of the two (the prefix on a tie),
 * else the whole id.
 */
export function shortestRefs(ids: readonly string[]): Map<string, string> {
  const unique = [...new Set(ids)]
  const reverse = (text: string): string => [...text].reverse().join('')
  const forward = [...unique].sort()
  const backward = unique.map(reverse).sort()
  // Up to two entries of `sorted` that start with `prefix`.
  const starting = (sorted: readonly string[], prefix: string): string[] => {
    let low = 0
    let high = sorted.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (sorted[mid]! < prefix) low = mid + 1
      else high = mid
    }
    const found: string[] = []
    for (let i = low; i < sorted.length && found.length < 2 && sorted[i]!.startsWith(prefix); i += 1) found.push(sorted[i]!)
    return found
  }
  // `id` is the only id that starts or ends with `form`.
  const alone = (id: string, form: string): boolean => {
    const matches = new Set([...starting(forward, form), ...starting(backward, reverse(form)).map(reverse)])
    return matches.size === 1 && matches.has(id)
  }
  const shortest = new Map<string, string>()
  for (const id of unique) {
    let best = id
    for (let length = MIN_REF_CHARS; length < id.length; length += 1) {
      const prefix = id.slice(0, length)
      const suffix = id.slice(-length)
      if (alone(id, prefix)) { best = prefix; break }
      if (alone(id, suffix)) { best = suffix; break }
    }
    shortest.set(id, best)
  }
  return shortest
}

// ── Entry points ──────────────────────────────────────────────────────

/** `path#<trace id>` or `path#branch=<id>`, when the whole string is not itself a path. */
async function splitSelector(ref: string): Promise<{ path: string; selector?: string }> {
  const hash = ref.lastIndexOf('#')
  if (hash <= 0 || hash === ref.length - 1 || (await statOf(ref)) !== null) return { path: ref }
  const path = ref.slice(0, hash)
  return (await statOf(path)) === null ? { path: ref } : { path, selector: ref.slice(hash + 1) }
}

async function pathRef(ref: string, options: ResolveRefOptions): Promise<ResolvedRef | ResolvedRef[] | undefined> {
  const { path, selector } = await splitSelector(ref)
  const info = await statOf(path)
  if (info === null) {
    if (looksLikePath(ref)) throw new RefError(`no such file or directory: ${ref}`, 'unreadable')
    return undefined
  }
  if (info.isDirectory()) {
    if (selector) throw new RefError(`${ref}: a #selector picks a run from a span file, not a directory`, 'usage')
    return directoryRef(path, ref)
  }
  if (!info.isFile()) throw new RefError(`${ref} is neither a file nor a directory`, 'unreadable')
  return fileRef(path, ref, selector, options)
}

/**
 * Resolve each ref. Paths are read first, so an id is looked up in the store
 * root named beside it; a command reads at most one store root.
 */
export async function resolveRefs(refs: readonly string[], options: ResolveRefOptions = {}): Promise<ResolvedRef[]> {
  const byPath = await Promise.all(refs.map((ref) => pathRef(ref, options)))
  const roots = byPath.flat().filter((ref): ref is Extract<ResolvedRef, { kind: 'store-root' }> => ref?.kind === 'store-root')
  if (roots.length > 1) {
    throw new RefError(`name one store root per command, not ${roots.length}: ${roots.map((root) => root.ref).join(', ')}`, 'usage')
  }
  const resolved: ResolvedRef[] = []
  for (const [index, ref] of refs.entries()) {
    resolved.push(...[byPath[index] ?? await lookupSession(ref, options, roots[0]?.path)].flat())
  }
  return resolved
}

// ── Reading spans ─────────────────────────────────────────────────────

/**
 * One arm of a run: every span whose `agent.branch.id` or `agent.branch.arm`
 * is `branch`, and every span below one. Sibling arms can share a branch id,
 * so a label that names more than one subtree is refused rather than unioned.
 */
export function branchSpans(spans: readonly OtlpSpan[], branch: string): OtlpSpan[] {
  const matched = spans.filter(
    (span) => span.attributes[ATTR.branchId] === branch || span.attributes[ATTR.branchArm] === branch,
  )
  if (!matched.length) return []
  const traceIds = new Set(matched.map((span) => span.trace_id))
  if (traceIds.size > 1) throw new Error(`"${branch}" matches ${traceIds.size} distinct traces; select a trace before choosing an arm`)
  // Span IDs and parent IDs are local to one trace. Other traces can reuse every ID in this arm.
  const trace = spans.filter((span) => span.trace_id === matched[0]!.trace_id)
  const byId = new Map(trace.map((span) => [span.span_id, span]))
  const children = new Map<string, OtlpSpan[]>()
  for (const span of trace) {
    if (!span.parent_span_id) continue
    const list = children.get(span.parent_span_id)
    if (list) list.push(span)
    else children.set(span.parent_span_id, [span])
  }
  const matchedIds = new Set(matched.map((span) => span.span_id))
  const hasMatchedAncestor = (span: OtlpSpan): boolean => {
    let current = span
    const visited = new Set<string>()
    while (current.parent_span_id) {
      if (visited.has(current.span_id)) throw new Error(`cyclic containment in branch "${branch}"`)
      visited.add(current.span_id)
      const parent = byId.get(current.parent_span_id)
      if (!parent) return false
      if (matchedIds.has(parent.span_id)) return true
      current = parent
    }
    return false
  }
  const roots = matched.filter((span) => !hasMatchedAncestor(span))
  if (!roots.length) throw new Error(`cyclic containment in branch "${branch}"`)
  if (roots.length > 1) {
    const named = roots
      .map((span) => `${span.span_id} (${ATTR.branchId}=${JSON.stringify(span.attributes[ATTR.branchId] ?? null)})`)
      .join(', ')
    throw new Error(
      `"${branch}" matches ${roots.length} separate subtrees, not one arm: ${named}` +
        ' — sibling arms can share a branch id; select by span id, or narrow the input to one arm first',
    )
  }
  const selected = new Set<OtlpSpan>()
  const stack = [...matched]
  while (stack.length > 0) {
    const span = stack.pop()!
    if (selected.has(span)) continue
    selected.add(span)
    for (const child of children.get(span.span_id) ?? []) stack.push(child)
  }
  return trace.filter((span) => selected.has(span))
}

/** The spans a `#<trace id>` or `#branch=<id>` selector picks from a file. */
export function selectSpans(spans: readonly OtlpSpan[], selector: string, path: string): OtlpSpan[] {
  if (selector.startsWith('branch=')) {
    const branch = selector.slice('branch='.length)
    const picked = branchSpans(spans, branch)
    if (picked.length === 0) throw new RefError(`${path} holds no span with ${ATTR.branchId} or ${ATTR.branchArm} "${branch}"`, 'unreadable')
    return picked
  }
  const picked = spans.filter((span) => span.trace_id === selector)
  if (picked.length === 0) throw new RefError(`${path} holds no run with trace id ${selector}`, 'unreadable')
  return picked
}

/** Every span one ref names. A store root or a tree of session files names many sessions, not one run. */
export async function readRefSpans(ref: string, options: ResolveRefOptions = {}): Promise<OtlpSpan[]> {
  const found = await resolveRefs([ref], options)
  if (found.length > 1) throw new RefError(`${ref} holds ${found.length} sessions; name one of them`, 'usage')
  const resolved = found[0]!
  switch (resolved.kind) {
    case 'session':
      return parseSession(resolved.adapter, resolved.session)
    case 'run-dir':
      return (await import('./adapters/runtime-run.js')).readRuntimeRunDirectory(resolved.path)
    case 'store-root':
      throw new RefError(`${ref} is a store root, which holds many sessions; name one session in it`, 'usage')
    case 'spans': {
      const spans = resolved.reader === 'otlp'
        ? [...(await readConsistentOtlpInput(resolved.path)).spans]
        : (await exportTraceEvidenceFile(resolved.path, { format: resolved.reader })).spans
      return resolved.selector ? selectSpans(spans, resolved.selector, resolved.path) : spans
    }
  }
}
