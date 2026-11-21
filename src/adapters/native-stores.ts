import { stat } from 'node:fs/promises'
import { nativeStoreSessions, type HarnessSessionReader, type SessionRef as NativeRef } from '@tangle-network/harness-sessions'
import type { SessionRef } from '../types.js'
import type { HarnessSessionsAdapter } from './harness-sessions.js'
import { isMissingPathError } from '../json.js'

export function nativePresentation(reader: HarnessSessionReader): { display: string; aliases: readonly string[] } {
  const display = reader.harness === 'kimi-code' ? 'kimi' : reader.harness === 'factory-droids' ? 'factory' : reader.harness
  return { display, aliases: [...new Set([...reader.aliases, ...(display === reader.harness ? [] : [reader.harness])])] }
}

export async function storedSession(harness: string, ref: SessionRef): Promise<NativeRef> {
  const nativeSessionId = ref.sessionId === ref.path || ref.sessionId.startsWith('unattributed:') ? undefined : ref.sessionId
  const rows = await nativeStoreSessions(ref.path, { harness, nativeSessionId })
  if (rows.length !== 1) throw new Error(`${harness} store ${ref.path} contains ${rows.length} matching sessions; select one native session ID`)
  return rows[0]!
}

/** Checkpointing a WAL or replacing either half of a paired database changes the index version. */
export async function nativeStoreVersion(paths: readonly string[]): Promise<string> {
  const versions = await Promise.all(paths.map(async path => {
    try {
      const info = await stat(path)
      return `${path}:${info.ino}:${info.size}:${info.mtimeMs}`
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      return `${path}:missing`
    }
  }))
  return versions.sort().join('|')
}

/** A dense sweep reads each native ID once and stats the files shared by those IDs once. */
async function catalogVersions(harness: string, path: string): Promise<Map<string, string>> {
  const rows = await nativeStoreSessions(path, { harness })
  const fileSets = new Map<string, Promise<string>>()
  const entries = rows.map(async row => {
    const key = JSON.stringify(row.files)
    const version = fileSets.get(key) ?? nativeStoreVersion(row.files)
    fileSets.set(key, version)
    return [row.nativeSessionId, await version] as const
  })
  return new Map(await Promise.all(entries))
}

/** Only complete, multi-session selections share a catalog. Sparse selections keep their indexed ID lookup. */
export function indexStoreVersions(
  adapter: HarnessSessionsAdapter,
  refs: readonly SessionRef[],
  versions: Map<SessionRef, () => Promise<string>>,
): void {
  for (const ref of refs) versions.set(ref, async () => nativeStoreVersion(await adapter.sourcePaths(ref)))
  if (refs.length < 2) return
  const groups = new Map<string, { refs: SessionRef[]; ids: Set<string>; native: boolean }>()
  for (const ref of refs) {
    let group = groups.get(ref.path)
    if (!group) {
      group = { refs: [], ids: new Set(), native: false }
      groups.set(ref.path, group)
    }
    group.refs.push(ref)
    group.ids.add(ref.sessionId)
  }
  for (const row of adapter.knownNativeRefs) {
    const group = groups.get(row.path)
    if (!group) continue
    if (!group.ids.has(row.nativeSessionId)) groups.delete(row.path)
    else group.native = true
  }
  for (const [path, group] of groups) {
    if (!group.native || group.refs.length < 2) continue
    let snapshot: Promise<Map<string, string>> | undefined
    for (const ref of group.refs) {
      versions.set(ref, async () => {
        snapshot ??= catalogVersions(adapter.nativeHarness, path)
        const version = (await snapshot).get(ref.sessionId)
        if (version === undefined) throw new Error(`${adapter.harness} store ${path} contains 0 matching sessions for ${ref.sessionId}`)
        return version
      })
    }
  }
}
