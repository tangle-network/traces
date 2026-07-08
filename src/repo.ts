/**
 * Per-session repo / git RESOURCE labels.
 *
 * Today every session groups under one `service.name` bucket (the harness, e.g.
 * "claude-code"), so all repos collapse together on the Tangle spine. The spine
 * groups by `deriveSubjectKey`, which reads `tangle.subject.key` first — so we
 * resolve a per-REPO subject key here and stamp it as a resource attribute.
 *
 * Derivation (fail-safe; historical sessions may point at a DELETED cwd, e.g. an
 * old worktree):
 *   - recorded cwd exists in or under a git repo → read the repo REMOTE url,
 *     normalize to `host/owner/repo`, plus branch and HEAD short sha.
 *   - recorded cwd is a lossy slash-decoded path from a dashed transcript dir
 *     (e.g. `agent/runtime`) → repair it to the real dashed directory when it
 *     exists (e.g. `agent-runtime`).
 *   - recorded cwd is missing or less specific than tool execution evidence →
 *     infer from absolute paths and explicit tool `workdir` / `cwd` fields.
 *   - no usable repo signal → fall back to the cwd path basename and omit
 *     `git.*` keys (no fabrication).
 *
 * Never throws. A missing cwd yields `{}` so the session keeps today's behavior.
 */

import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, parse as parsePath } from 'node:path'
import { ATTR } from './attributes.js'
import type { OtlpSpan } from './otlp.js'

export type RepoResolutionSource = 'none' | 'ref-cwd' | 'repaired-cwd' | 'span-path' | 'span-workdir'

/** Resource-attribute keys this resolver may stamp. */
export type RepoAttrs = Partial<
  Record<
    | typeof ATTR.SUBJECT_KEY
    | typeof ATTR.GIT_REPOSITORY
    | typeof ATTR.GIT_BRANCH_NAME
    | typeof ATTR.GIT_COMMIT
    | typeof ATTR.CWD,
    string
  >
> & Partial<Record<typeof ATTR.REPO_RESOLUTION_SOURCE, RepoResolutionSource>>

export interface RepoResolution {
  /** Resource attributes to stamp onto spans. */
  attrs: RepoAttrs
  /** Best-known cwd/repo directory after repair or span-path inference. */
  cwd: string | null
  /** Which signal produced the selected cwd. */
  source: RepoResolutionSource
}

/**
 * Normalize a git remote url to `host/owner/repo`, dropping scheme, auth, the
 * `.git` suffix, and any trailing slash. Handles both `https://` and the
 * `git@host:owner/repo.git` SCP-style forms. Returns null when unparseable.
 */
export function normalizeRemote(url: string): string | null {
  const raw = url.trim()
  if (!raw) return null

  // URL form: scheme://[user[:pass]@]host[:port]/owner/repo[.git]
  const url2 = raw.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.+)$/)
  if (url2) {
    let rest = url2[1]!
    const at = rest.lastIndexOf('@')
    if (at !== -1) rest = rest.slice(at + 1)
    rest = rest.replace(/\.git$/, '').replace(/\/+$/g, '')
    // Strip a :port on the host segment.
    const slash = rest.indexOf('/')
    if (slash === -1) return null
    const host = rest.slice(0, slash).replace(/:\d+$/, '')
    const path = rest.slice(slash + 1).replace(/^\/+/, '')
    return host && path ? `${host}/${path}` : null
  }

  // SCP-style (no scheme): git@github.com:owner/repo.git
  const scp = raw.match(/^[^@/]+@([^:/]+):(.+)$/)
  if (scp) {
    const path = scp[2]!.replace(/\.git$/, '').replace(/^\/+|\/+$/g, '')
    return path ? `${scp[1]}/${path}` : null
  }

  return null
}

async function readGit(cwd: string): Promise<{ remote: string | null; branch: string | null; commit: string | null }> {
  // A readable `.git` (dir for a normal repo, file for a worktree/submodule).
  await stat(`${cwd}/.git`) // throws if absent → caller falls back

  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  const git = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 5000 })
      const v = stdout.trim()
      return v.length > 0 ? v : null
    } catch {
      return null
    }
  }

  // Prefer `origin`, else the first configured remote.
  let remote = await git(['remote', 'get-url', 'origin'])
  if (!remote) {
    const first = await git(['remote'])
    const name = first?.split('\n')[0]?.trim()
    if (name) remote = await git(['remote', 'get-url', name])
  }
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const commit = await git(['rev-parse', '--short', 'HEAD'])
  return {
    remote,
    branch: branch === 'HEAD' ? null : branch, // detached HEAD → no branch name
    commit,
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 5000 })
    const v = stdout.trim()
    return v.length > 0 ? v : null
  } catch {
    return null
  }
}

function uniqNormalized(paths: Iterable<string>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    const n = normalize(path)
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

function parseWorktreePorcelain(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean)
}

/** Expand a selected cwd to every checked-out worktree for the same git repo. */
export async function equivalentGitCwds(cwd: string | null | undefined): Promise<string[]> {
  if (!cwd) return []
  const selected = normalize(cwd)
  if (!isAbsolute(selected)) return [selected]

  const top = await gitOutput(selected, ['rev-parse', '--show-toplevel'])
  if (!top) return [selected]

  const worktrees = await gitOutput(top, ['worktree', 'list', '--porcelain'])
  return uniqNormalized([selected, top, ...(worktrees ? parseWorktreePorcelain(worktrees) : [])])
}

/** Boundary-aware cwd matching; `/repo` matches `/repo/src`, not `/repo-old`. */
export function cwdMatchesSelection(cwd: string | null | undefined, selections: readonly string[]): boolean {
  if (!cwd) return false
  const value = normalize(cwd)
  return selections.some((selection) => {
    const prefix = normalize(selection)
    return value === prefix || value.startsWith(`${prefix}/`)
  })
}

async function pathStat(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

async function directoryExists(path: string): Promise<boolean> {
  const s = await pathStat(path)
  return Boolean(s?.isDirectory())
}

async function nearestExistingDir(path: string): Promise<string | null> {
  if (!path || !isAbsolute(path)) return null

  let cur = normalize(path)
  for (;;) {
    const s = await pathStat(cur)
    if (s?.isDirectory()) return cur
    if (s?.isFile()) return dirname(cur)

    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

async function findGitRoot(path: string): Promise<string | null> {
  let cur = await nearestExistingDir(path)
  while (cur) {
    if (await pathStat(join(cur, '.git'))) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
  return null
}

async function repairDashedPath(cwd: string): Promise<string | null> {
  if (!isAbsolute(cwd) || (await directoryExists(cwd))) return null

  const normalized = normalize(cwd)
  const parsed = parsePath(normalized)
  const parts = normalized.slice(parsed.root.length).split('/').filter(Boolean)
  if (parts.length === 0) return null

  let current = parsed.root
  let index = 0
  while (index < parts.length) {
    const nextPart = parts[index]
    if (!nextPart) break
    const exact = join(current, nextPart)
    if (!(await directoryExists(exact))) break
    current = exact
    index += 1
  }

  while (index < parts.length) {
    let match: string | null = null
    let consumed = 0
    for (let n = parts.length - index; n >= 1; n -= 1) {
      const segment = parts.slice(index, index + n).join('-')
      const candidate = join(current, segment)
      if (await directoryExists(candidate)) {
        match = candidate
        consumed = n
        break
      }
    }
    if (!match) return null
    current = match
    index += consumed
  }

  return current !== normalized ? current : null
}

const ABSOLUTE_PATH_RE = /\/(?:home|tmp|private\/tmp|Users|work|workspace|workspaces|mnt|srv|var|opt|repo|app)\/[^\s"'`<>|;]+/g
const MAX_SPAN_PATH_CANDIDATES = 64
const MAX_SPAN_TEXT_CHARS = 200_000
const SOURCE_WEIGHT: Record<RepoResolutionSource, number> = {
  none: 0,
  'span-path': 5,
  'ref-cwd': 50,
  'repaired-cwd': 90,
  'span-workdir': 100,
}

interface PathEvidence {
  path: string
  source: Extract<RepoResolutionSource, 'span-path' | 'span-workdir'>
  weight: number
}

function cleanPathCandidate(raw: string): string | null {
  let value = raw
    .trim()
    .replace(/\\n/g, '')
    .replace(/[),\].}]+$/g, '')
    .replace(/:\d+(?::\d+)?$/g, '')
  value = normalize(value)
  return isAbsolute(value) ? value : null
}

function looksLikeWorkdirKey(key: string | undefined): boolean {
  return key === 'cwd' || key === 'workdir' || key === 'workingDirectory' || key === 'working_directory'
}

function* pathEvidenceFromText(
  text: string,
  source: Extract<RepoResolutionSource, 'span-path' | 'span-workdir'>,
): Generator<PathEvidence> {
  if (source === 'span-workdir') {
    const direct = cleanPathCandidate(text)
    if (direct) yield { path: direct, source, weight: SOURCE_WEIGHT[source] }
  }
  for (const match of text.matchAll(ABSOLUTE_PATH_RE)) {
    const candidate = cleanPathCandidate(match[0])
    if (candidate) yield { path: candidate, source: 'span-path', weight: SOURCE_WEIGHT['span-path'] }
  }
}

function* pathsFromUnknown(value: unknown, key?: string, depth = 0): Generator<PathEvidence> {
  if (depth > 4 || value == null) return
  if (typeof value === 'string') {
    yield* pathEvidenceFromText(value, looksLikeWorkdirKey(key) ? 'span-workdir' : 'span-path')
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        yield* pathsFromUnknown(JSON.parse(trimmed), key, depth + 1)
      } catch {
        // Not JSON; the raw string was already yielded.
      }
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* pathsFromUnknown(item, key, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) yield* pathsFromUnknown(item, childKey, depth + 1)
  }
}

function extractAbsolutePaths(spans: readonly OtlpSpan[]): PathEvidence[] {
  const paths: PathEvidence[] = []
  const seen = new Set<string>()
  let scannedChars = 0

  for (const span of spans) {
    for (const value of [span.name, span.status.message, ...Object.values(span.attributes)]) {
      for (const evidence of pathsFromUnknown(value)) {
        scannedChars += evidence.path.length
        if (scannedChars > MAX_SPAN_TEXT_CHARS) return paths

        const key = `${evidence.source}:${evidence.path}`
        if (seen.has(key)) continue
        seen.add(key)
        paths.push(evidence)
        if (paths.length >= MAX_SPAN_PATH_CANDIDATES) return paths
      }
    }
  }

  return paths
}

/**
 * Resolve per-session repo/git resource attributes from a session's cwd.
 * Fail-safe and never throws; see the module doc for the derivation contract.
 */
export async function resolveRepoAttrs(cwd: string | null | undefined): Promise<RepoAttrs> {
  if (!cwd) return {}

  const attrs: RepoAttrs = { [ATTR.CWD]: cwd }

  // basename fallback (also used when git can't resolve a remote / dir is gone).
  const basename = (() => {
    const trimmed = cwd.replace(/\/+$/g, '')
    const idx = trimmed.lastIndexOf('/')
    const name = idx === -1 ? trimmed : trimmed.slice(idx + 1)
    return name || trimmed
  })()

  try {
    const gitRoot = await findGitRoot(cwd)
    if (!gitRoot) throw new Error('no git root')

    const { remote, branch, commit } = await readGit(gitRoot)
    const normalized = remote ? normalizeRemote(remote) : null
    if (normalized) {
      attrs[ATTR.SUBJECT_KEY] = normalized
      attrs[ATTR.GIT_REPOSITORY] = normalized
      if (branch) attrs[ATTR.GIT_BRANCH_NAME] = branch
      if (commit) attrs[ATTR.GIT_COMMIT] = commit
      return attrs
    }
    // Readable `.git` but no usable remote → still group by path basename,
    // and surface branch/commit when we have them (no remote to fabricate).
    if (branch) attrs[ATTR.GIT_BRANCH_NAME] = branch
    if (commit) attrs[ATTR.GIT_COMMIT] = commit
  } catch {
    // cwd/.git gone (deleted worktree) or git unavailable → path-basename group,
    // no git.* fabrication.
  }

  attrs[ATTR.SUBJECT_KEY] = basename
  return attrs
}

async function repoCandidateForPath(path: string): Promise<string | null> {
  return (await findGitRoot(path)) ?? (await nearestExistingDir(path))
}

export async function resolveSessionRepoAttrs(
  cwd: string | null | undefined,
  spans: readonly OtlpSpan[],
): Promise<RepoResolution> {
  const candidates = new Map<string, { cwd: string; source: RepoResolutionSource; score: number; order: number }>()
  const add = (value: string | null | undefined, source: RepoResolutionSource, weight = SOURCE_WEIGHT[source]): void => {
    if (!value) return
    const existing = candidates.get(value)
    if (existing) {
      existing.score += weight
      if (SOURCE_WEIGHT[source] > SOURCE_WEIGHT[existing.source]) existing.source = source
      return
    }
    candidates.set(value, { cwd: value, source, score: weight, order: candidates.size })
  }

  if (cwd) {
    add(await repairDashedPath(cwd), 'repaired-cwd')
    add(cwd, 'ref-cwd')
  }

  for (const evidence of extractAbsolutePaths(spans)) {
    add(await repoCandidateForPath(evidence.path), evidence.source, evidence.weight)
  }

  const resolved: Array<{ attrs: RepoAttrs; cwd: string; source: RepoResolutionSource; score: number; order: number }> = []
  for (const candidate of candidates.values()) {
    const attrs = await resolveRepoAttrs(candidate.cwd)
    resolved.push({ ...candidate, attrs })
  }

  const byScore = (a: { score: number; order: number }, b: { score: number; order: number }): number => b.score - a.score || a.order - b.order
  const withGit = resolved.filter((candidate) => candidate.attrs[ATTR.GIT_REPOSITORY]).sort(byScore)
  const selected = withGit[0] ?? resolved.filter((candidate) => candidate.attrs[ATTR.SUBJECT_KEY]).sort(byScore)[0]
  if (!selected) return { attrs: {}, cwd: null, source: 'none' }

  return {
    attrs: { ...selected.attrs, [ATTR.REPO_RESOLUTION_SOURCE]: selected.source },
    cwd: selected.attrs[ATTR.CWD] ?? selected.cwd,
    source: selected.source,
  }
}

/**
 * Stamp resolved repo attrs onto every span's attributes (so they land in the
 * OTLP resource attributes via `toOpenInferenceSpan`). Additive — existing
 * `service.name` / `agent.name` are untouched. Mutates in place and returns the
 * same array for ergonomic chaining. A no-op when `attrs` is empty.
 */
export function stampRepoAttrs(spans: readonly import('./otlp.js').OtlpSpan[], attrs: RepoAttrs): readonly import('./otlp.js').OtlpSpan[] {
  const keys = Object.keys(attrs)
  if (keys.length === 0) return spans
  for (const s of spans) {
    for (const k of keys) {
      // Never clobber a value an adapter already set deliberately.
      if (s.attributes[k] === undefined) s.attributes[k] = (attrs as Record<string, string>)[k]
    }
  }
  return spans
}
