/** Ref conversion at the native-reader boundary; shared-store resolution stays with the adapter. */
import { dirname, join } from 'node:path'
import {
  claudeCodeRefForFile,
  codexRefForFile,
  factoryRefForFile,
  grokRefForFile,
  kimiRefForFile,
  nanoclawRefForFile,
  piRefForFile,
  readerFor,
  type SessionRef as NativeRef,
} from '@tangle-network/harness-sessions'
import type { SessionRef } from '../types.js'

export type SupportedHarness = string

export function nativeRef(harness: SupportedHarness, ref: SessionRef): NativeRef {
  const unattributed = ref.sessionId.startsWith('unattributed:')
  const selected = (native: NativeRef): NativeRef => unattributed
    ? { ...native, nativeSessionId: ref.sessionId }
    : native
  switch (harness) {
    case 'claude-code': return selected(claudeCodeRefForFile(ref.path))
    case 'codex': return selected(codexRefForFile(ref.path))
    case 'pi': return selected(piRefForFile(ref.path))
    case 'prime': return selected({ ...piRefForFile(ref.path), harness, format: 'prime.session-jsonl' })
    case 'kimi-code': return selected(kimiRefForFile(ref.path.endsWith('wire.jsonl') ? ref.path : join(ref.path, 'wire.jsonl')))
    case 'factory-droids': return selected(factoryRefForFile(ref.path))
    case 'grok': return selected(grokRefForFile(ref.path))
    case 'nanoclaw': {
      const native = nanoclawRefForFile(ref.path)
      return selected({ ...native, files: [join(dirname(ref.path), 'outbound.db'), join(dirname(ref.path), 'inbound.db')] })
    }
    case 'opencode':
    case 'hermes':
    case 'openclaw': throw new Error(`${harness} SQLite sessions must be selected from its session catalog`)
    default: {
      const reader = readerFor(harness)
      const format = reader.formats[0]
      if (!format) throw new Error(`${harness} declares no native session format`)
      return selected({
        harness,
        format,
        nativeSessionId: ref.sessionId,
        path: ref.path,
        files: [ref.path],
        home: null,
        cwd: ref.cwd,
        mtimeMs: ref.mtimeMs,
        parentNativeSessionId: null,
      })
    }
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

