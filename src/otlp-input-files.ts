/** Filesystem discovery for the existing OTLP reader; named inputs remain explicit. */
import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { appendAll } from './arrays.js'

/** A `*.jsonl` in the directory that does not hold OTLP spans, and how we know. */
export interface SkippedInputFile {
  readonly path: string
  /** What the first readable line was instead of a span. */
  readonly reason: string
}

/** A file or directory resolved to the OTLP files in it, plus the JSONL that is not OTLP. */
export interface ResolvedOtlpInput {
  readonly files: readonly string[]
  readonly skipped: readonly SkippedInputFile[]
}

/** JSONL extensions a directory scan considers at all. */
const OTLP_FILE_EXTENSIONS = ['.jsonl', '.ndjson']

/**
 * Directory name a producer puts its OTLP exports in. When one exists, it is
 * the ONLY thing read: a producer that separated its span files from its event
 * files has already answered "which of these are spans", and second-guessing
 * that by also scanning siblings is how a run directory's raw stream logs got
 * counted as broken spans.
 */
const OTLP_DIRECTORY_NAME = 'otlp'

/** Git's metadata layout identifies ordinary .git and bare repositories, regardless of name. */
function gitMetadata(entries: readonly Dirent[]): boolean {
  return entries.some((entry) => entry.name === 'HEAD' && entry.isFile())
    && entries.some((entry) => entry.name === 'config' && entry.isFile())
    && entries.some((entry) => entry.name === 'objects' && entry.isDirectory())
    && entries.some((entry) => entry.name === 'refs' && entry.isDirectory())
}

async function scopedEntries(dir: string, root: string): Promise<Dirent[] | null> {
  const entries = await readdir(dir, { withFileTypes: true })
  // An explicitly named directory remains readable. Recursive discovery does
  // not enter Git object storage to look for a producer's span export.
  return dir !== root && gitMetadata(entries) ? null : entries
}

/** Collect `*.jsonl` / `*.ndjson` under a directory, recursively, sorted. */
async function jsonlFilesUnder(dir: string, root: string): Promise<string[]> {
  const entries = await scopedEntries(dir, root) ?? []
  const files: string[] = []
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) appendAll(files, await jsonlFilesUnder(path, root))
    else if (OTLP_FILE_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))) files.push(path)
  }
  return files
}

/** Every `otlp/` directory under `dir`, so a results tree of per-cell exports resolves. */
async function otlpDirectoriesUnder(dir: string, root: string): Promise<string[]> {
  const entries = await scopedEntries(dir, root) ?? []
  const dirs: string[] = []
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name)
    if (entry.name === OTLP_DIRECTORY_NAME) {
      if (await scopedEntries(path, root) !== null) dirs.push(path)
    }
    else appendAll(dirs, await otlpDirectoriesUnder(path, root))
  }
  return dirs
}

/** The same recursive input discovery, without parsing or validating source rows. */
export async function otlpInputCandidates(path: string, allowEmptyDirectory: boolean): Promise<{
  readonly candidates: readonly string[]; readonly directory: boolean
}> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`no OTLP file or directory at ${path}`)
    }
    throw error
  }
  if (!info.isDirectory()) return { candidates: [path], directory: false }

  const otlpDirs = basename(path) === OTLP_DIRECTORY_NAME ? [path] : await otlpDirectoriesUnder(path, path)
  const candidates = otlpDirs.length > 0
    ? (await Promise.all(otlpDirs.map((dir) => jsonlFilesUnder(dir, path)))).flat()
    : await jsonlFilesUnder(path, path)
  if (candidates.length === 0) {
    if (allowEmptyDirectory) return { candidates: [], directory: true }
    throw new Error(`no ${OTLP_FILE_EXTENSIONS.join(' / ')} files under ${path}`)
  }

  return { candidates, directory: true }
}
