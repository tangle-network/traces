/**
 * `traces bundle` — assemble one session's durable evidence directory.
 *
 * A bundle is the input contract for downstream consumers (distillers,
 * report writers, auditors) that must cite a session long after the live
 * stores have rotated: the raw transcript + subagent transcripts, every
 * derived artifact this CLI already knows how to produce (session index,
 * deterministic analyze report, policy evidence, OTLP spans), the repo's
 * `.evolve` ledger sliced to the session window, the git log for that
 * window, and a manifest with a SHA-256 per file so any later claim can be
 * checked against the exact bytes it cites.
 *
 * The transcript is REQUIRED — no transcript, no bundle, loudly. Everything
 * else is an optional input whose absence is a recorded fact in the
 * manifest (`absent`, with the reason), never a silent gap and never an
 * error: a session without subagents or without an `.evolve` ledger is a
 * complete bundle of a smaller session.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { buildPolicyEvidenceRecord, serializePolicyEvidence } from './evidence.js'
import { runTraceInvestigation } from './improvement.js'
import { isMissingPathError } from './json.js'
import { sessionReportSource } from './report.js'
import {
  buildSessionIndexFromRows,
  findContextRoot,
  serializeSessionIndex,
} from './session-index.js'
import { parseSession } from './session-source.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'

export interface SessionBundleFile {
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

export type SessionBundleSliceRule =
  /** JSONL rows kept verbatim when their `ts` falls inside the padded session window. */
  | 'session-window-rows'
  | 'copied-whole'
  /** The lexically last `handoff-*.md` — names are date-prefixed, so name order is time order. */
  | 'latest-by-name'
  /** Files whose name carries a `YYYY-MM-DD` date inside the session window's dates. */
  | 'session-window-dated-files'

export interface SessionBundleLedgerSlice {
  readonly path: string
  /** Absolute source path the slice was read from. */
  readonly source: string
  readonly rule: SessionBundleSliceRule
  readonly totalRows?: number
  readonly keptRows?: number
  /** Rows excluded because no `ts` could be parsed — counted, never silently dropped. */
  readonly unparseableTsRows?: number
}

export interface SessionBundleManifest {
  readonly schemaVersion: 1
  readonly kind: 'traces.session_bundle'
  readonly createdAt: string
  readonly provenance: {
    readonly sessionId: string
    readonly harness: string
    readonly cwd: string | null
    /** Absolute path of the source transcript at assembly time. */
    readonly transcriptPath: string
    readonly transcriptSha256: string
    /** Root the `.evolve` ledger and git log were read under, when found. */
    readonly contextRoot: string | null
    readonly tracesVersion: string
    readonly sessionWindow: {
      readonly firstSpanAt: string | null
      readonly lastSpanAt: string | null
      /** Pad applied to each side of the window when slicing ledger rows. */
      readonly padMs: number
    }
  }
  readonly files: readonly SessionBundleFile[]
  readonly absent: readonly SessionBundleAbsence[]
  readonly ledgerSlices: readonly SessionBundleLedgerSlice[]
  readonly knownLimits: readonly string[]
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
  readonly minLoopOccurrences?: number
  readonly signal?: AbortSignal
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void
}

/**
 * Ledger rows land moments AFTER the last span (handoff/reflect run at
 * session close), so a bare span window would drop exactly the decision
 * records the bundle exists to keep. 15 minutes admits session-close writes
 * without swallowing a neighboring session's rows; the manifest records the
 * value so the slice rule is inspectable, not folklore.
 */
const SESSION_WINDOW_PAD_MS = 15 * 60 * 1000

/**
 * Honest limits of what a v1 bundle captures, carried in every manifest so a
 * consumer reads the boundary from the artifact instead of discovering it.
 */
const KNOWN_LIMITS: readonly string[] = [
  "'what was decided' is prose-only: handoff, progress, and reflection files are copied as markdown with no structured decision extraction",
  "'what was measured' is split between experiments.jsonl free-text fields and progress/handoff markdown tables",
  'session-to-ledger join is by timestamp/cwd inference: ledger rows are window-sliced, not linked by transcript path',
  'progress.md is copied whole; no session-dated section extraction is performed',
  'open pull-request state is not captured: the bundler makes no network calls',
]

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

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

interface JsonlSlice {
  readonly kept: readonly string[]
  readonly totalRows: number
  readonly unparseableTsRows: number
}

/**
 * Keep rows VERBATIM (raw line bytes, no re-serialization) when their `ts`
 * parses inside the window. Rows without a parseable `ts` — including invalid
 * JSON lines — are excluded from the slice but counted in the manifest, so
 * nothing disappears without a number pointing at it.
 */
function sliceJsonlByWindow(text: string, windowStartMs: number, windowEndMs: number): JsonlSlice {
  const kept: string[] = []
  let totalRows = 0
  let unparseableTsRows = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    totalRows += 1
    let tsMs = Number.NaN
    try {
      const row: unknown = JSON.parse(line)
      const ts = row !== null && typeof row === 'object' && !Array.isArray(row)
        ? (row as { ts?: unknown }).ts
        : undefined
      if (typeof ts === 'string') tsMs = Date.parse(ts)
    } catch {
      // invalid JSON row → no timestamp → counted below
    }
    if (Number.isNaN(tsMs)) {
      unparseableTsRows += 1
      continue
    }
    if (tsMs >= windowStartMs && tsMs <= windowEndMs) kept.push(line)
  }
  return { kept, totalRows, unparseableTsRows }
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

async function walkBundleFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const dir = pending.pop()!
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) out.push(path)
    }
  }
  return out.sort()
}

interface LedgerContext {
  readonly evolveDir: string
  readonly ledgerDir: string
  readonly windowStartMs: number | null
  readonly windowEndMs: number | null
  readonly slices: SessionBundleLedgerSlice[]
  readonly absent: SessionBundleAbsence[]
}

async function sliceLedgerJsonl(ctx: LedgerContext, name: string): Promise<void> {
  const source = join(ctx.evolveDir, name)
  const s = await statOrNull(source)
  if (!s?.isFile()) {
    ctx.absent.push({ path: bundlePath('ledger', name), reason: `no ${name} at ${source}` })
    return
  }
  const text = await readFile(source, 'utf8')
  const target = join(ctx.ledgerDir, name)
  if (ctx.windowStartMs === null || ctx.windowEndMs === null) {
    await writeFile(target, text, 'utf8')
    ctx.slices.push({ path: bundlePath('ledger', name), source, rule: 'copied-whole' })
    return
  }
  const slice = sliceJsonlByWindow(text, ctx.windowStartMs, ctx.windowEndMs)
  await writeFile(target, slice.kept.length > 0 ? `${slice.kept.join('\n')}\n` : '', 'utf8')
  ctx.slices.push({
    path: bundlePath('ledger', name),
    source,
    rule: 'session-window-rows',
    totalRows: slice.totalRows,
    keptRows: slice.kept.length,
    unparseableTsRows: slice.unparseableTsRows,
  })
}

async function copyLedgerWhole(ctx: LedgerContext, name: string): Promise<void> {
  const source = join(ctx.evolveDir, name)
  const s = await statOrNull(source)
  if (!s?.isFile()) {
    ctx.absent.push({ path: bundlePath('ledger', name), reason: `no ${name} at ${source}` })
    return
  }
  await cp(source, join(ctx.ledgerDir, name))
  ctx.slices.push({ path: bundlePath('ledger', name), source, rule: 'copied-whole' })
}

async function copyLatestHandoff(ctx: LedgerContext): Promise<void> {
  let names: string[]
  try {
    names = (await readdir(ctx.evolveDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^handoff-.*\.md$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    names = []
  }
  const latest = names[names.length - 1]
  if (!latest) {
    ctx.absent.push({
      path: bundlePath('ledger', 'handoff-*.md'),
      reason: `no flat handoff-*.md files in ${ctx.evolveDir}`,
    })
    return
  }
  const source = join(ctx.evolveDir, latest)
  await cp(source, join(ctx.ledgerDir, latest))
  ctx.slices.push({ path: bundlePath('ledger', latest), source, rule: 'latest-by-name' })
}

async function copyWindowReflections(ctx: LedgerContext): Promise<void> {
  const reflectionsDir = join(ctx.evolveDir, 'reflections')
  const s = await statOrNull(reflectionsDir)
  if (!s?.isDirectory()) {
    ctx.absent.push({
      path: bundlePath('ledger', 'reflections'),
      reason: `no reflections directory at ${reflectionsDir}`,
    })
    return
  }
  const names = (await readdir(reflectionsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort()
  const windowed = ctx.windowStartMs === null || ctx.windowEndMs === null
    ? names
    : names.filter((name) => {
        const date = name.match(/(\d{4}-\d{2}-\d{2})/)?.[1]
        if (!date) return false
        // Date-only comparison: a reflection is dated to a day, not an instant.
        const startDate = new Date(ctx.windowStartMs!).toISOString().slice(0, 10)
        const endDate = new Date(ctx.windowEndMs!).toISOString().slice(0, 10)
        return date >= startDate && date <= endDate
      })
  if (windowed.length === 0) {
    ctx.absent.push({
      path: bundlePath('ledger', 'reflections'),
      reason: `no reflections dated inside the session window in ${reflectionsDir}`,
    })
    return
  }
  await mkdir(join(ctx.ledgerDir, 'reflections'), { recursive: true })
  const rule: SessionBundleSliceRule = ctx.windowStartMs === null ? 'copied-whole' : 'session-window-dated-files'
  for (const name of windowed) {
    const source = join(reflectionsDir, name)
    await cp(source, join(ctx.ledgerDir, 'reflections', name))
    ctx.slices.push({ path: bundlePath('ledger', 'reflections', name), source, rule })
  }
}

/**
 * Assemble one session's bundle directory. Throws when the transcript is
 * missing or unparseable — a bundle without its primary source is not a
 * degraded bundle, it is not a bundle. Optional inputs (subagents directory,
 * `.evolve` ledger, git history) that are absent are recorded in
 * `manifest.absent` with the probed path and reason.
 */
export async function assembleSessionBundle(opts: AssembleSessionBundleOptions): Promise<SessionBundleResult> {
  const { adapter, ref } = opts
  const generatedAt = opts.generatedAt ?? new Date().toISOString()

  let transcriptBytes: Buffer
  try {
    transcriptBytes = await readFile(ref.path)
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(
        `session transcript not found at ${ref.path} — a bundle cannot be assembled without its transcript`,
      )
    }
    throw error
  }
  const transcriptSha256 = sha256Hex(transcriptBytes)

  // Parse BEFORE creating the output directory: an unparseable session must
  // fail without leaving a half-written bundle behind.
  const spans = await parseSession(adapter, ref, { signal: opts.signal })

  const outDir = resolve(opts.outDir)
  await mkdir(outDir, { recursive: true })
  if ((await readdir(outDir)).length > 0) {
    throw new Error(
      `bundle output directory ${outDir} is not empty — pass a new directory so one bundle holds exactly one session`,
    )
  }

  const absent: SessionBundleAbsence[] = []
  const slices: SessionBundleLedgerSlice[] = []

  // session/ — the raw sources, byte-for-byte.
  await mkdir(join(outDir, 'session'), { recursive: true })
  await writeFile(join(outDir, 'session', 'transcript.jsonl'), transcriptBytes)
  const subagentsSource = join(ref.path.replace(/\.jsonl$/, ''), 'subagents')
  if ((await statOrNull(subagentsSource))?.isDirectory()) {
    await cp(subagentsSource, join(outDir, 'session', 'subagents'), { recursive: true })
  } else {
    absent.push({ path: bundlePath('session', 'subagents'), reason: `no subagents directory at ${subagentsSource}` })
  }

  // derived/ — every derivation this CLI already owns, deterministic only:
  // a bundle assembly must never spend a model call.
  await mkdir(join(outDir, 'derived'), { recursive: true })
  const otlpPath = join(outDir, 'derived', 'trace.otlp.jsonl')
  const investigation = await runTraceInvestigation({
    spans,
    harness: ref.harness,
    sources: [sessionReportSource(ref, spans)],
    cwds: ref.cwd ? [ref.cwd] : [],
    minLoopOccurrences: opts.minLoopOccurrences,
    otlpOutPath: otlpPath,
    generatedAt,
    signal: opts.signal,
    log: opts.log,
  })
  await writeFile(join(outDir, 'derived', 'report.md'), investigation.report, 'utf8')

  const evidence = await buildPolicyEvidenceRecord(ref, spans, {
    generatedAt,
    minLoopOccurrences: opts.minLoopOccurrences,
    // Bundle-relative pointer: the bundle must stay internally valid when moved.
    otlpPath: bundlePath('derived', 'trace.otlp.jsonl'),
    sourceSha256: transcriptSha256,
  })
  await writeFile(join(outDir, 'derived', 'evidence.jsonl'), serializePolicyEvidence([evidence]), 'utf8')

  const index = await buildSessionIndexFromRows([{ ref, spans }], {
    generatedAt,
    minLoopOccurrences: opts.minLoopOccurrences,
    selection: { command: 'bundle', harness: ref.harness, session: ref.sessionId },
  })
  await writeFile(join(outDir, 'derived', 'session-index.json'), serializeSessionIndex(index), 'utf8')

  const { firstSpanAt, lastSpanAt } = evidence.metrics
  const windowStartMs = firstSpanAt !== null ? Date.parse(firstSpanAt) - SESSION_WINDOW_PAD_MS : null
  const windowEndMs = lastSpanAt !== null ? Date.parse(lastSpanAt) + SESSION_WINDOW_PAD_MS : null

  // ledger/ — the .evolve slices for this session's window.
  const contextRoot = await findContextRoot(ref.cwd)
  if (!contextRoot) {
    absent.push({ path: 'ledger', reason: `no context root found from session cwd ${ref.cwd ?? '(unknown)'}` })
  } else {
    const evolveDir = join(contextRoot, '.evolve')
    if (!(await statOrNull(evolveDir))?.isDirectory()) {
      absent.push({ path: 'ledger', reason: `no .evolve ledger at ${evolveDir}` })
    } else {
      const ledgerDir = join(outDir, 'ledger')
      await mkdir(ledgerDir, { recursive: true })
      const ctx: LedgerContext = { evolveDir, ledgerDir, windowStartMs, windowEndMs, slices, absent }
      await sliceLedgerJsonl(ctx, 'experiments.jsonl')
      await sliceLedgerJsonl(ctx, 'skill-runs.jsonl')
      await copyLedgerWhole(ctx, 'current.json')
      await copyLedgerWhole(ctx, 'scorecard.json')
      await copyLedgerWhole(ctx, 'progress.md')
      await copyLatestHandoff(ctx)
      await copyWindowReflections(ctx)
    }
  }

  // repo/ — commit history for the session window, from the resolved cwd.
  const gitLogPath = bundlePath('repo', 'git-log.txt')
  if (!ref.cwd) {
    absent.push({ path: gitLogPath, reason: 'session has no recorded cwd to read git history from' })
  } else if (windowStartMs === null || windowEndMs === null) {
    absent.push({ path: gitLogPath, reason: 'session window unavailable (spans carry no timestamps)' })
  } else {
    const log = await runGitLog(ref.cwd, new Date(windowStartMs).toISOString(), new Date(windowEndMs).toISOString())
    if (log.succeeded) {
      await mkdir(join(outDir, 'repo'), { recursive: true })
      // An empty log is data: the session touched a repo with no commits in
      // the window. The file exists so a consumer reads "0 commits", not "unknown".
      await writeFile(join(outDir, 'repo', 'git-log.txt'), log.stdout ? `${log.stdout}\n` : '', 'utf8')
    } else {
      absent.push({ path: gitLogPath, reason: `git log failed in ${ref.cwd}: ${log.error}` })
    }
  }

  // manifest.json — sha256 per file, written LAST so it covers every byte.
  const files: SessionBundleFile[] = []
  for (const path of await walkBundleFiles(outDir)) {
    const bytes = await readFile(path)
    files.push({
      path: relative(outDir, path).split(sep).join('/'),
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
    })
  }
  const manifest: SessionBundleManifest = {
    schemaVersion: 1,
    kind: 'traces.session_bundle',
    createdAt: generatedAt,
    provenance: {
      sessionId: ref.sessionId,
      harness: ref.harness,
      cwd: ref.cwd,
      transcriptPath: resolve(ref.path),
      transcriptSha256,
      contextRoot,
      tracesVersion: tracesPackageVersion(),
      sessionWindow: { firstSpanAt, lastSpanAt, padMs: SESSION_WINDOW_PAD_MS },
    },
    files,
    absent,
    ledgerSlices: slices,
    knownLimits: KNOWN_LIMITS,
  }
  const manifestPath = join(outDir, 'manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { directory: outDir, manifestPath, manifest }
}

let cachedVersion: string | undefined

function tracesPackageVersion(): string {
  if (cachedVersion) return cachedVersion
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown }
  if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('package.json is missing version')
  cachedVersion = pkg.version
  return cachedVersion
}
