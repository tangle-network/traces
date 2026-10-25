/** Derived reader cache only; graph and run records remain Runtime-owned. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { HarnessTraceAdapter, SessionRef } from './types.js'

interface Fingerprint { readonly path: string; readonly mtimeMs: number; readonly size: number; readonly ino: number }
interface SourceSnapshot { readonly sourceKey: string; readonly files: readonly Fingerprint[]; readonly directories: readonly Fingerprint[] }
const CACHE_VERSION = 2

async function fingerprint(path: string): Promise<Fingerprint> {
  const info = await stat(path)
  return { path, mtimeMs: info.mtimeMs, size: info.size, ino: info.ino }
}

export class GraphSourceCache {
  private constructor(private readonly path: string, private readonly entries: Record<string, SourceSnapshot>) {}
  static async load(root: string): Promise<GraphSourceCache> {
    const path = join(root, 'traces-source-cache.json')
    let entries: Record<string, SourceSnapshot> = {}
    try {
      const saved = JSON.parse(await readFile(path, 'utf8')) as { version: number; entries: Record<string, SourceSnapshot> }
      if (saved.version === CACHE_VERSION && saved.entries && typeof saved.entries === 'object') entries = saved.entries
    } catch { /* A missing or invalid derived cache requires a real reader pass. */ }
    return new GraphSourceCache(path, entries)
  }
  async unchanged(key: string, existingSources: ReadonlySet<string>): Promise<boolean> {
    const entry = this.entries[key]
    if (!entry || !existingSources.has(entry.sourceKey)) return false
    try {
      const fresh = await Promise.all([...entry.files, ...entry.directories].map((file) => fingerprint(file.path)))
      return JSON.stringify(fresh) === JSON.stringify([...entry.files, ...entry.directories])
    } catch { return false }
  }
  async remember(key: string, rows: readonly { adapter: HarnessTraceAdapter; ref: SessionRef }[], readStartedAt: number, sourceKey: string): Promise<void> {
    const paths = (await Promise.all(rows.map(({ adapter, ref }) => adapter.sourcePaths ? adapter.sourcePaths(ref) : [ref.path]))).flat()
    const directories = new Set<string>()
    const base = dirname(rows[0]!.ref.path)
    for (const path of paths) {
      let directory = dirname(path)
      directories.add(directory)
      while (directory !== base && relative(base, directory) && !relative(base, directory).startsWith('..')) {
        directory = dirname(directory)
        directories.add(directory)
      }
    }
    const snapshot = {
      sourceKey,
      files: await Promise.all([...new Set(paths)].sort().map(fingerprint)),
      directories: await Promise.all([...directories].sort().map(fingerprint)),
    }
    // Any source touched during the read needs a fresh owner read next time.
    if ([...snapshot.files, ...snapshot.directories].every((entry) => entry.mtimeMs < readStartedAt)) this.entries[key] = snapshot
    else delete this.entries[key]
  }
  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, entries: this.entries }), { mode: 0o600 })
    await rename(temporary, this.path)
  }
}
