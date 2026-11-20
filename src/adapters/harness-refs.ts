/** Ref conversion at the native-reader boundary; shared-store resolution stays with the adapter. */
import { join } from 'node:path'
import {
  claudeCodeRefForFile, codexRefForFile, factoryRefForFile, grokRefForFile, kimiRefForFile, piRefForFile, type SessionRef as NativeRef,
} from '@tangle-network/harness-sessions'
import type { SessionRef } from '../types.js'

export type SupportedHarness = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'kimi-code' | 'factory-droids' | 'grok'

export function nativeRef(harness: SupportedHarness, ref: SessionRef): NativeRef {
  const unattributed = ref.sessionId.startsWith('unattributed:')
  const selected = (native: NativeRef): NativeRef => unattributed
    ? { ...native, nativeSessionId: ref.sessionId }
    : native
  switch (harness) {
    case 'claude-code': return selected(claudeCodeRefForFile(ref.path))
    case 'codex': return selected(codexRefForFile(ref.path))
    case 'pi': return selected(piRefForFile(ref.path))
    case 'kimi-code': return selected(kimiRefForFile(ref.path.endsWith('wire.jsonl') ? ref.path : join(ref.path, 'wire.jsonl')))
    case 'factory-droids': return selected(factoryRefForFile(ref.path))
    case 'grok': return selected(grokRefForFile(ref.path))
    case 'opencode': throw new Error('OpenCode SQLite sessions must be selected from its session catalog')
  }
}

export function sessionRefKey(ref: SessionRef): string {
  return `${ref.sessionId}\0${ref.path}`
}

export function legacyOpencodeFile(ref: SessionRef, registered: ReadonlyMap<string, NativeRef>): boolean {
  return !ref.path.endsWith('.db') && !registered.has(sessionRefKey(ref))
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

