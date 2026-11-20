import { stat } from 'node:fs/promises'
import { nativeStoreSessions, type HarnessSessionReader, type SessionRef as NativeRef } from '@tangle-network/harness-sessions'
import type { SessionRef } from '../types.js'
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
