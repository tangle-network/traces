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
 *   - cwd exists AND has a readable `.git` → read the git REMOTE url, normalize
 *     to `host/owner/repo` (e.g. github.com/tangle-network/agent-dev-container)
 *     for `tangle.subject.key` + `git.repository`, plus the current branch and
 *     HEAD short sha. `tangle.cwd` carries the path.
 *   - cwd is null/gone, or no readable `.git` → fall back to the cwd path
 *     basename for `tangle.subject.key` (the project dir name still groups
 *     per-project even when the dir is deleted), set `tangle.cwd`, and OMIT the
 *     `git.*` keys (no fabrication).
 *
 * Never throws. A missing cwd yields `{}` so the session keeps today's behavior.
 */

import { ATTR } from './attributes.js'

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
>

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
  const { stat } = await import('node:fs/promises')
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
    const { remote, branch, commit } = await readGit(cwd)
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
