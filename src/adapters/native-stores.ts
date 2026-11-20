import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import {
  hermesSessionsInStore,
  nanoclawRefForFile,
  opencodeSessionsInStore,
  type HarnessSessionReader,
  type SessionRef as NativeRef,
} from '@tangle-network/harness-sessions'

export function readsSqlite(reader: HarnessSessionReader): boolean {
  return reader.stores.some((store) => store.write === 'sqlite-wal')
}

export function nativePresentation(reader: HarnessSessionReader): { display: string; aliases: readonly string[] } {
  const display = reader.harness === 'kimi-code' ? 'kimi' : reader.harness === 'factory-droids' ? 'factory' : reader.harness
  return { display, aliases: [...new Set([...reader.aliases, ...(display === reader.harness ? [] : [reader.harness])])] }
}

async function mtimeMs(path: string): Promise<number> {
  return (await stat(path)).mtimeMs
}

function openclawSessionsInStore(path: string, mtime: number): NativeRef[] {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(`${pathToFileURL(path).href}?mode=ro`, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return (db.prepare('SELECT session_id FROM session_windows').all() as Array<{ session_id: string }>).map((row) => ({
      harness: 'openclaw',
      format: 'openclaw.session-jsonl',
      nativeSessionId: row.session_id,
      path,
      files: [path],
      home: null,
      cwd: null,
      mtimeMs: mtime,
      parentNativeSessionId: null,
    }))
  } finally {
    db.close()
  }
}

/** Catalog one declared SQLite store without interpreting its session records. */
export async function nativeSessionsInStore(
  reader: HarnessSessionReader,
  path: string,
  nativeSessionId?: string,
): Promise<NativeRef[]> {
  if (!readsSqlite(reader)) return []
  const modified = await mtimeMs(path)
  let refs: NativeRef[]
  if (reader.harness === 'opencode') {
    refs = await opencodeSessionsInStore(path, null, { ...(nativeSessionId ? { nativeSessionId } : {}) })
  } else if (reader.harness === 'hermes') {
    refs = await hermesSessionsInStore(path)
  } else if (reader.harness === 'openclaw') {
    // harness-sessions 1.0.11–1.0.15 has this catalog internally but exports only the reader.
    try {
      refs = openclawSessionsInStore(path, modified)
    } catch {
      refs = []
    }
  } else if (reader.harness === 'nanoclaw') {
    const ref = nanoclawRefForFile(path)
    const pair = [join(dirname(path), 'outbound.db'), join(dirname(path), 'inbound.db')]
    await reader.read(ref)
    refs = [{ ...ref, path, files: pair, mtimeMs: modified }]
  } else {
    return []
  }
  return refs
    .filter((ref) => nativeSessionId === undefined || ref.nativeSessionId === nativeSessionId)
    .map((ref) => ({ ...ref, path, mtimeMs: ref.mtimeMs || modified }))
}

/** Every source that can change a native read, including live SQLite sidecars. */
export async function nativeSourcePaths(reader: HarnessSessionReader, paths: readonly string[]): Promise<string[]> {
  const all = new Set(paths)
  if (readsSqlite(reader)) {
    for (const path of paths) {
      for (const suffix of ['-wal', '-shm']) {
        try {
          if ((await stat(`${path}${suffix}`)).isFile()) all.add(`${path}${suffix}`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
  }
  return [...all]
}

/** A whole-store version, so a WAL or paired DB update invalidates the turn index. */
export async function nativeStoreVersion(reader: HarnessSessionReader, paths: readonly string[]): Promise<string> {
  const versions = await Promise.all((await nativeSourcePaths(reader, paths)).map(async (path) => {
    const info = await stat(path)
    return `${path}:${info.ino}:${info.size}:${info.mtimeMs}`
  }))
  return versions.sort().join('|')
}
