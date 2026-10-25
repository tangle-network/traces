/**
 * Refs: what a positional argument names, read for what it is, so no flag
 * names its type.
 *
 *   1. An existing path is read by its content: a harness session file (its
 *      harness from its store root, else from its first records), a Sandbox
 *      live stream (Codex events in `raw` envelopes, read by codex-exec), a
 *      sandbox-events recording, OTLP or OpenInference JSONL, standard
 *      OTLP/JSON (`resourceSpans`, one document or one envelope per line),
 *      the span rows Tangle Intelligence serves, a
 *      directory of OTLP files, a bundle directory, a Runtime run directory,
 *      or a store root: a directory that holds harness stores the way a home
 *      does (a trace archive's `<host>/home`, a fleet seat). `path#<trace id>`
 *      and `path#branch=<id>` pick one run from a span file.
 *   2. Anything else is a session id, or a unique prefix or suffix of at least
 *      8 characters, looked up across every harness (in the store root named
 *      beside it, when there is one).
 *
 * `--harness` forces the reader of a file ref and narrows an id lookup; an
 * input format named on the command line forces how a file ref is read.
 */

import type { Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { CODEX_HOME_RULE, STORES, codexHomes, isCodexHome } from '@tangle-network/harness-sessions'
import { ATTR } from '@tangle-network/agent-trace-contract'
import { isCodexExecRecord } from './adapters/codex-exec.js'
import { readsStoreRoots } from './adapters/harness-sessions.js'
import { detectEvidenceFormat, exportTraceEvidenceFile, type TraceEvidenceInputFormat } from './file-export.js'
import { readJsonl } from './jsonl.js'
import type { OtlpSpan } from './otlp.js'
import { isOtlpJsonFile, isStandardOtlpRow, readOtlpInput } from './otlp-input.js'
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
  /** `--harness` as given: forces the reader of a file ref and narrows an id lookup. */
  readonly harness?: string
  /** An input format named on the command line: forces how a file ref is read. */
  readonly format?: SpanReader
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function errorText(error: unknown): string {
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

async function isDirectory(path: string): Promise<boolean> {
  return (await statOf(path))?.isDirectory() ?? false
}

async function isFile(path: string): Promise<boolean> {
  return (await statOf(path))?.isFile() ?? false
}

function ownHome(): string {
  return process.env.HOME || homedir()
}

// ── Files ─────────────────────────────────────────────────────────────

const HEAD_ROWS = 20
/** A JSON document (not JSONL) is parsed whole to be sniffed; past this it must be named with --format. */
const MAX_WHOLE_JSON_BYTES = 256 * 1024 * 1024
const CODEX_ROLLOUT_TYPES = new Set(['session_meta', 'response_item', 'event_msg', 'turn_context'])

/** Harness stores a session file can sit in, by the path segment that names the store. */
const STORE_PATHS: ReadonlyArray<{ readonly harness: string; readonly root: string }> = [
  { harness: 'claude-code', root: STORES['claude-code.projects-jsonl'].root },
  { harness: 'pi', root: STORES['pi.session-jsonl'].root },
  { harness: 'kimi', root: STORES['kimi.session-dir'].root },
  { harness: 'factory', root: STORES['factory.session-jsonl'].root },
]

/** The harness whose store holds `path`, from the path alone. */
function harnessOfStorePath(path: string): string | undefined {
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

/** The first rows of a JSONL file, or the rows of a JSON document. */
async function headRows(path: string): Promise<unknown[]> {
  const rows: unknown[] = []
  let unparsed = 0
  for await (const row of readJsonl<unknown>(path, { mode: 'recover', onCorruption: () => { unparsed += 1 } })) {
    rows.push(row)
    if (rows.length >= HEAD_ROWS) return rows
    if (unparsed > HEAD_ROWS && rows.length === 0) break
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
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return rows
  }
  if (Array.isArray(parsed)) return parsed
  if (isObject(parsed) && Array.isArray(parsed.events)) return parsed.events
  return [parsed]
}

function isClaudeRecord(row: unknown): boolean {
  return isObject(row) &&
    (typeof row.sessionId === 'string' || typeof row.session_id === 'string') &&
    typeof row.type === 'string' &&
    ('message' in row || 'uuid' in row || 'subtype' in row)
}

type Sniffed =
  | { readonly kind: 'session'; readonly harness: string }
  | { readonly kind: 'spans'; readonly reader: SpanReader }

/**
 * What a trace file holds: its store decides its harness; otherwise its first
 * records do. A file nothing claims is read as OTLP, which names every row it
 * cannot use rather than refusing the file.
 */
export async function sniffTraceFile(path: string): Promise<Sniffed> {
  const stored = harnessOfStorePath(path)
  if (stored) return { kind: 'session', harness: stored }
  // Standard OTLP/JSON is known from its first bytes; its lines can be too large to parse just to look.
  if (await isOtlpJsonFile(path)) return { kind: 'spans', reader: 'otlp' }
  const rows = await headRows(path)
  if (rows.some(isCodexExecRecord)) return { kind: 'session', harness: 'codex-exec' }
  if (rows.length > 0 && rows.every((row) => isObject(row) && typeof row.trace_id === 'string' && typeof row.span_id === 'string')) {
    return { kind: 'spans', reader: 'otlp' }
  }
  // Standard OTLP/JSON (`resourceSpans`), or the camelCase span rows Tangle Intelligence serves.
  if (rows.length > 0 && rows.every(isStandardOtlpRow)) return { kind: 'spans', reader: 'otlp' }
  if (!rows.some((row) => isObject(row) && typeof row.span_id === 'string')) {
    if (rows.some(isClaudeRecord)) return { kind: 'session', harness: 'claude-code' }
    if (rows.some((row) => isObject(row) && CODEX_ROLLOUT_TYPES.has(String(row.type)) && isObject(row.payload))) {
      return { kind: 'session', harness: 'codex' }
    }
    const first = rows[0]
    if (isObject(first) && first.type === 'session' && typeof first.id === 'string') return { kind: 'session', harness: 'pi' }
    if (rows.some((row) => isObject(row) && row.type === 'session_start')) return { kind: 'session', harness: 'factory' }
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
  return { kind: 'spans', reader: 'otlp' }
}

function adapterFor(harness: string): HarnessTraceAdapter {
  const adapter = resolveAdapter(harness)
  if (!adapter) {
    throw new RefError(`unknown harness "${harness}"; known: ${listAdapters().map((a) => a.harness).join(', ')}`, 'usage')
  }
  return adapter
}

async function fileRef(path: string, ref: string, selector: string | undefined, options: ResolveRefOptions): Promise<ResolvedRef> {
  if (options.format) return { kind: 'spans', ref, path, reader: options.format, ...(selector ? { selector } : {}) }
  const sniffed = options.harness ? { kind: 'session' as const, harness: options.harness } : await sniffTraceFile(path)
  if (sniffed.kind === 'spans') return { kind: 'spans', ref, path, reader: sniffed.reader, ...(selector ? { selector } : {}) }
  if (selector) throw new RefError(`${ref}: a #selector picks a run from a span file; ${path} is a ${sniffed.harness} session`, 'usage')
  const adapter = adapterFor(sniffed.harness)
  const info = await stat(path)
  // The same ref an explicit session path has always produced, so a session
  // reads the same whichever way it is named.
  return {
    kind: 'session',
    ref,
    adapter,
    session: { harness: adapter.harness, sessionId: ref, path, cwd: null, mtimeMs: info.mtimeMs },
  }
}

// ── Directories ───────────────────────────────────────────────────────

/** Session stores traces reads under a home, besides the Codex homes. */
const HOME_STORES = [
  STORES['claude-code.projects-jsonl'].root,
  STORES['opencode.sqlite'].root,
  STORES['pi.session-jsonl'].root,
  STORES['kimi.session-dir'].root,
  STORES['factory.session-jsonl'].root,
]

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

async function directoryRef(path: string, ref: string): Promise<ResolvedRef> {
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
  return { kind: 'spans', ref, path, reader: 'otlp' }
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

function candidate({ adapter, session }: Found): RefCandidate {
  return { harness: adapter.harness, sessionId: session.sessionId, path: session.path }
}

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

async function pathRef(ref: string, options: ResolveRefOptions): Promise<ResolvedRef | undefined> {
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
  const roots = byPath.filter((ref): ref is Extract<ResolvedRef, { kind: 'store-root' }> => ref?.kind === 'store-root')
  if (roots.length > 1) {
    throw new RefError(`name one store root per command, not ${roots.length}: ${roots.map((root) => root.ref).join(', ')}`, 'usage')
  }
  const resolved: ResolvedRef[] = []
  for (const [index, ref] of refs.entries()) {
    resolved.push(byPath[index] ?? await lookupSession(ref, options, roots[0]?.path))
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
  const byId = new Map<string, OtlpSpan>()
  for (const span of spans) byId.set(span.span_id, span)
  const children = new Map<string, OtlpSpan[]>()
  for (const span of spans) {
    if (!span.parent_span_id) continue
    const list = children.get(span.parent_span_id)
    if (list) list.push(span)
    else children.set(span.parent_span_id, [span])
  }
  const matched = spans.filter(
    (span) => span.attributes[ATTR.branchId] === branch || span.attributes[ATTR.branchArm] === branch,
  )
  const matchedIds = new Set(matched.map((span) => span.span_id))
  const hasMatchedAncestor = (span: OtlpSpan): boolean => {
    let current = span
    while (current.parent_span_id) {
      const parent = byId.get(current.parent_span_id)
      if (!parent) return false
      if (matchedIds.has(parent.span_id)) return true
      current = parent
    }
    return false
  }
  const roots = matched.filter((span) => !hasMatchedAncestor(span))
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
    stack.push(...(children.get(span.span_id) ?? []))
  }
  return spans.filter((span) => selected.has(span))
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

/** Every span one ref names. A store root names many sessions, not one run. */
export async function readRefSpans(ref: string, options: ResolveRefOptions = {}): Promise<OtlpSpan[]> {
  const resolved = (await resolveRefs([ref], options))[0]!
  switch (resolved.kind) {
    case 'session':
      return parseSession(resolved.adapter, resolved.session)
    case 'run-dir':
      return (await import('./adapters/runtime-run.js')).readRuntimeRunDirectory(resolved.path)
    case 'store-root':
      throw new RefError(`${ref} is a store root, which holds many sessions; name one session in it`, 'usage')
    case 'spans': {
      const spans = resolved.reader === 'otlp'
        ? [...(await readOtlpInput(resolved.path)).spans]
        : (await exportTraceEvidenceFile(resolved.path, { format: resolved.reader })).spans
      return resolved.selector ? selectSpans(spans, resolved.selector, resolved.path) : spans
    }
  }
}
