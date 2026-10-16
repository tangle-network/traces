/**
 * `traces bundle` — keep one session's evidence beyond log rotation.
 *
 * A bundle is a directory a reader can cite long after the live stores have
 * rotated:
 *
 *   session/          the transcript byte for byte, and every other source file
 *                     the session's spans cite (subagent transcripts, metadata)
 *   spans.otlp.jsonl  the session's spans, as every command reads them
 *   facts.json        the session's facts sheet (`traces facts --format json`)
 *   git-log.txt       commits in the session's window, from its recorded cwd
 *   manifest.json     provenance, and the size and SHA-256 of every file
 *
 * The transcript is REQUIRED — no transcript, no bundle, loudly. Every other
 * input whose absence is possible (subagents, a recorded cwd, a git history)
 * is recorded in `manifest.absent` with the reason: a fact, never a silent gap.
 * Assembly spends no model call.
 *
 * A bundle directory is a ref: `traces facts <dir>` reads its spans.
 */

import { cp, copyFile, lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isMissingPathError } from './json.js'
import { writeOtlpFile } from './otlp.js'
import { buildSessionFactsReport } from './session-facts.js'
import { collectSessionSelection, fileSha256 } from './session-selection.js'
import { sourceFileId } from './source-location.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'
import { tracesVersion } from './version.js'

export interface SessionBundleFile {
  /** Opaque source identity when this file backs native span attributes. */
  readonly sourceId?: string
  /** Bundle-relative path, `/`-separated. */
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface SessionBundleAbsence {
  /** Bundle-relative path the artifact would have occupied. */
  readonly path: string
  readonly reason: string
}

export interface SessionBundleManifest {
  readonly schemaVersion: 3
  readonly kind: 'traces.session_bundle'
  readonly createdAt: string
  readonly provenance: {
    readonly sessionId: string
    readonly harness: string
    readonly cwd: string | null
    /** Absolute path of the source transcript at assembly time. */
    readonly transcriptPath: string
    readonly transcriptSha256: string
    readonly tracesVersion: string
    /** The session's own records, as `facts.json` reports them. */
    readonly sessionWindow: {
      readonly firstRecordAt: string | null
      readonly lastRecordAt: string | null
      /** Pad applied to each side of the window when reading the git log. */
      readonly padMs: number
    }
  }
  readonly files: readonly SessionBundleFile[]
  readonly absent: readonly SessionBundleAbsence[]
}

export interface SessionBundleResult {
  readonly directory: string
  readonly manifestPath: string
  readonly manifest: SessionBundleManifest
}

export interface AssembleSessionBundleOptions {
  readonly adapter: HarnessTraceAdapter
  readonly ref: SessionRef
  /** Bundle directory to create. Must be new or empty: one bundle, one session. */
  readonly outDir: string
  readonly generatedAt?: string
  readonly signal?: AbortSignal
}

/**
 * Commits land moments after the last span (a session commits as it closes),
 * so a bare record window would drop exactly the commit the session made last.
 * The manifest records the pad, so the rule is inspectable.
 */
const SESSION_WINDOW_PAD_MS = 15 * 60 * 1000

function bundlePath(...parts: string[]): string {
  return parts.join('/')
}

async function statOrNull(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path)
  } catch (error) {
    if (isMissingPathError(error)) return null
    // ENOTDIR: a path component is a file — for probing purposes the target
    // does not exist, which is not a failure worth killing the bundle over.
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return null
    throw error
  }
}

interface GitLogOutcome {
  readonly succeeded: boolean
  readonly stdout?: string
  readonly error?: string
}

async function runGitLog(cwd: string, sinceIso: string, untilIso: string): Promise<GitLogOutcome> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  try {
    const { stdout } = await run(
      'git',
      ['-C', cwd, 'log', `--since=${sinceIso}`, `--until=${untilIso}`, '--date=iso-strict', '--pretty=format:%H %ad %an %s'],
      { timeout: 5000 },
    )
    return { succeeded: true, stdout }
  } catch (error) {
    return { succeeded: false, error: error instanceof Error ? error.message.split('\n', 1)[0] : String(error) }
  }
}

/** Every file under a bundle directory, as sorted bundle-relative `/`-separated paths. */
async function listBundleFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const pending = [resolve(root)]
  while (pending.length > 0) {
    const dir = pending.pop()!
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) out.push(relative(resolve(root), path).split(sep).join('/'))
    }
  }
  return out.sort()
}

/**
 * Assemble one session's bundle directory. Throws when the transcript is
 * missing or unparseable — a bundle without its primary source is not a
 * degraded bundle, it is not a bundle.
 */
export async function assembleSessionBundle(opts: AssembleSessionBundleOptions): Promise<SessionBundleResult> {
  const { adapter, ref } = opts
  const generatedAt = opts.generatedAt ?? new Date().toISOString()

  try {
    await stat(ref.path)
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`session transcript not found at ${ref.path} — a bundle cannot be assembled without its transcript`)
    }
    throw error
  }
  const selection = await collectSessionSelection([{ adapter, refs: [ref] }], {
    bindSources: true,
    signal: opts.signal,
  })
  const row = selection.rows[0]!
  const spans = row.spans
  const transcriptSha256 = row.sourceFiles!.find((file) => resolve(file.path) === resolve(ref.path))?.sha256
    ?? row.sourceSha256!

  const outDir = resolve(opts.outDir)
  await mkdir(outDir, { recursive: true })
  if ((await readdir(outDir)).length > 0) {
    throw new Error(
      `bundle output directory ${outDir} is not empty — pass a new directory so one bundle holds exactly one session`,
    )
  }

  const absent: SessionBundleAbsence[] = []

  // session/ — the raw sources, byte-for-byte.
  await mkdir(join(outDir, 'session'), { recursive: true })
  const subagentsSource = join(ref.path.replace(/\.jsonl$/, ''), 'subagents')
  if ((await statOrNull(subagentsSource))?.isDirectory()) {
    await cp(subagentsSource, join(outDir, 'session', 'subagents'), { recursive: true })
  } else {
    absent.push({ path: bundlePath('session', 'subagents'), reason: `no subagents directory at ${subagentsSource}` })
  }

  const retainedSourceIds = new Map<string, string>()
  for (const file of row.sourceFiles!) {
    opts.signal?.throwIfAborted()
    const sourceId = sourceFileId(file.path)
    const subagentRelative = relative(subagentsSource, file.path)
    const path = resolve(file.path) === resolve(ref.path)
      ? bundlePath('session', 'transcript.jsonl')
      : !subagentRelative.startsWith('..') && !subagentRelative.startsWith(sep)
        ? bundlePath('session', 'subagents', subagentRelative)
        : bundlePath('session', 'sources', `${sourceId}.jsonl`)
    const target = join(outDir, path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(file.path, target)
    if (await fileSha256(target, opts.signal) !== file.sha256) {
      throw new Error(`session source changed while retaining bundle evidence: ${file.path}`)
    }
    retainedSourceIds.set(path, sourceId)
  }

  // spans.otlp.jsonl and facts.json — what every command reads, computed once.
  await writeOtlpFile(spans, join(outDir, 'spans.otlp.jsonl'))
  const facts = buildSessionFactsReport(spans, { harness: ref.harness, generatedAt })
  await writeFile(join(outDir, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`, 'utf8')

  const own = facts.sessions.find((session) => session.sessionId === ref.sessionId) ?? facts.sessions[0]
  const firstRecordAt = own?.firstRecordAt.value ?? null
  const lastRecordAt = own?.lastRecordAt.value ?? null
  // The cwd the session recorded; a session file named on the command line
  // carries none until it is read.
  const cwd = own?.cwd.value ?? ref.cwd ?? null

  // git-log.txt — commit history for the session window, from the recorded cwd.
  const gitLogPath = 'git-log.txt'
  if (!cwd) {
    absent.push({ path: gitLogPath, reason: 'session has no recorded cwd to read git history from' })
  } else if (firstRecordAt === null || lastRecordAt === null) {
    absent.push({ path: gitLogPath, reason: 'session window unavailable (no record carries a time)' })
  } else {
    const log = await runGitLog(
      cwd,
      new Date(Date.parse(firstRecordAt) - SESSION_WINDOW_PAD_MS).toISOString(),
      new Date(Date.parse(lastRecordAt) + SESSION_WINDOW_PAD_MS).toISOString(),
    )
    if (log.succeeded) {
      // An empty log is data: the session touched a repo with no commits in
      // the window. The file exists so a consumer reads "0 commits", not "unknown".
      await writeFile(join(outDir, gitLogPath), log.stdout ? `${log.stdout}\n` : '', 'utf8')
    } else {
      absent.push({ path: gitLogPath, reason: `git log failed in ${cwd}: ${log.error}` })
    }
  }

  // manifest.json — sha256 per file, written LAST so it covers every byte.
  const files: SessionBundleFile[] = []
  for (const path of await listBundleFiles(outDir)) {
    const filePath = join(outDir, path)
    const sourceId = retainedSourceIds.get(path)
    files.push({
      ...(sourceId !== undefined ? { sourceId } : {}),
      path,
      bytes: (await stat(filePath)).size,
      sha256: await fileSha256(filePath),
    })
  }
  const manifest: SessionBundleManifest = {
    schemaVersion: 3,
    kind: 'traces.session_bundle',
    createdAt: generatedAt,
    provenance: {
      // The id the session recorded; a file named on the command line is its own ref.
      sessionId: own?.sessionId ?? ref.sessionId,
      harness: ref.harness,
      cwd,
      transcriptPath: resolve(ref.path),
      transcriptSha256,
      tracesVersion: tracesVersion(),
      sessionWindow: { firstRecordAt, lastRecordAt, padMs: SESSION_WINDOW_PAD_MS },
    },
    files,
    absent,
  }
  const manifestPath = join(outDir, 'manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { directory: outDir, manifestPath, manifest }
}

/**
 * The file list of a bundle's manifest, after proving the directory is a
 * bundle. A 0.x bundle (schemaVersion 2) is read too: it is retained
 * evidence, and its manifest lists its files the same way.
 */
async function readBundleFileList(bundleDir: string): Promise<readonly SessionBundleFile[]> {
  const path = join(bundleDir, 'manifest.json')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`no manifest.json at ${path} — ${bundleDir} is not a traces session bundle`)
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const manifest = parsed as { kind?: unknown; schemaVersion?: unknown; files?: unknown }
  if (manifest?.kind !== 'traces.session_bundle') {
    throw new Error(`${path} has kind ${JSON.stringify(manifest?.kind)}, expected "traces.session_bundle"`)
  }
  if (manifest.schemaVersion !== 3 && manifest.schemaVersion !== 2) {
    throw new Error(`${path} is bundle schemaVersion ${JSON.stringify(manifest.schemaVersion)}; this traces reads 2 and 3`)
  }
  if (!Array.isArray(manifest.files)) throw new Error(`${path} lists no files`)
  return manifest.files as SessionBundleFile[]
}

export type SessionBundleIssueKind =
  /** Listed in the manifest, absent on disk. */
  | 'missing'
  /** On disk, not listed in the manifest. */
  | 'unexpected'
  /** Listed, present, and its bytes differ from the recorded size or SHA-256. */
  | 'mismatch'
  /** A manifest path that is absolute, climbs out of the bundle, or is not `/`-separated. */
  | 'unsafe-path'
  /** A symbolic link or other non-regular entry: the manifest can only vouch for regular files. */
  | 'not-a-file'

export interface SessionBundleIssue {
  readonly kind: SessionBundleIssueKind
  readonly path: string
  readonly detail: string
}

export interface SessionBundleVerification {
  /** True only when every listed file matches and nothing else is present. */
  readonly ok: boolean
  readonly directory: string
  /** Files listed in the manifest. */
  readonly listed: number
  /** Listed files whose size and SHA-256 matched. */
  readonly matched: number
  readonly issues: readonly SessionBundleIssue[]
}

function unsafeBundlePath(path: string): string | null {
  if (path.length === 0) return 'empty path'
  if (path.includes('\\')) return 'contains a backslash'
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'is absolute'
  if (path.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    return 'has an empty, "." or ".." segment'
  }
  return null
}

/** Every entry under `root` that is not a directory or a regular file, bundle-relative. */
async function nonRegularEntries(root: string): Promise<string[]> {
  const out: string[] = []
  const pending = [resolve(root)]
  while (pending.length > 0) {
    const dir = pending.pop()!
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (!entry.isFile()) out.push(relative(resolve(root), path).split(sep).join('/'))
    }
  }
  return out.sort()
}

/**
 * Check a bundle directory against its own manifest: every listed file is
 * present with the recorded size and SHA-256, and nothing unlisted sits beside
 * them. The manifest is written last and never lists itself, so
 * `manifest.json` is the one file exempt from both checks.
 *
 * This proves the bytes are the bytes the bundler wrote. It does not prove who
 * wrote them or when: anyone who can rewrite a file can rewrite the manifest.
 */
export async function verifySessionBundle(bundleDir: string): Promise<SessionBundleVerification> {
  const directory = resolve(bundleDir)
  const listedFiles = await readBundleFileList(directory)
  const issues: SessionBundleIssue[] = []
  const listed = new Set<string>()
  let matched = 0
  for (const file of listedFiles) {
    const unsafe = unsafeBundlePath(file.path)
    if (unsafe) {
      issues.push({ kind: 'unsafe-path', path: file.path, detail: `manifest path ${unsafe}` })
      continue
    }
    listed.add(file.path)
    const info = await lstat(join(directory, file.path)).catch((error: unknown) => {
      if (isMissingPathError(error)) return null
      throw error
    })
    if (!info) {
      issues.push({ kind: 'missing', path: file.path, detail: 'listed in the manifest, not on disk' })
      continue
    }
    if (!info.isFile()) continue // reported by the non-regular scan below
    const sha256 = await fileSha256(join(directory, file.path))
    if (info.size !== file.bytes || sha256 !== file.sha256) {
      issues.push({
        kind: 'mismatch',
        path: file.path,
        detail: `recorded ${file.bytes} bytes sha256 ${file.sha256}, found ${info.size} bytes sha256 ${sha256}`,
      })
      continue
    }
    matched += 1
  }
  for (const path of await listBundleFiles(directory)) {
    if (path === 'manifest.json' || listed.has(path)) continue
    issues.push({ kind: 'unexpected', path, detail: 'on disk, not listed in the manifest' })
  }
  for (const path of await nonRegularEntries(directory)) {
    issues.push({ kind: 'not-a-file', path, detail: 'a symbolic link or special file; a bundle holds regular files only' })
  }
  return { ok: issues.length === 0, directory, listed: listedFiles.length, matched, issues }
}
