/** Ref conversion at the native-reader boundary; shared-store resolution stays with the adapter. */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readerFor, type SessionRef as NativeRef } from '@tangle-network/harness-sessions'
import type { SessionRef } from '../types.js'

export function nativeRef(harness: string, ref: SessionRef): NativeRef {
  const reader = readerFor(harness)
  if (!reader.refForFile) throw new Error(`${harness} sessions must be selected from their native store`)
  const path = harness === 'kimi-code' && !ref.path.endsWith('wire.jsonl') ? join(ref.path, 'wire.jsonl') : ref.path
  const native = reader.refForFile(path)
  return ref.sessionId.startsWith('unattributed:') ? { ...native, nativeSessionId: ref.sessionId } : native
}

export function sessionRefKey(ref: SessionRef): string {
  return `${ref.sessionId}\0${ref.path}`
}

/** OpenCode's historical JSON layout identifies a session by its message directory. */
export async function legacyOpencodeFile(ref: SessionRef, registered: ReadonlyMap<string, NativeRef>): Promise<boolean> {
  return !registered.has(sessionRefKey(ref)) && (await stat(ref.path)).isDirectory()
}

export function tracesRef(ref: NativeRef, harness: string, registered?: Map<string, NativeRef>): SessionRef {
  const session = {
    harness,
    sessionId: ref.nativeSessionId,
    path: ref.path,
    cwd: ref.cwd,
    mtimeMs: ref.mtimeMs,
  }
  registered?.set(sessionRefKey(session), ref)
  return session
}

