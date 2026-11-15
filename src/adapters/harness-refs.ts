/** Ref conversion at the native-reader boundary; shared-store resolution stays with the adapter. */
import { basename, dirname, join } from 'node:path'
import {
  claudeCodeRefForFile, codexRefForFile, factoryRefForFile, grokRefForFile, kimiRefForFile, piRefForFile, type SessionRef as NativeRef,
} from '@tangle-network/harness-sessions'
import type { SessionRef } from '../types.js'

const GROK_UPDATES = 'updates.jsonl'

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
    // A Grok session is a directory; its record is updates.jsonl whichever of its files the ref names.
    case 'grok': return selected(grokRefForFile(basename(ref.path) === GROK_UPDATES ? ref.path : join(dirname(ref.path), GROK_UPDATES)))
    case 'opencode': throw new Error('OpenCode SQLite sessions must be selected from its session catalog')
  }
}

export function tracesRef(ref: NativeRef, harness: string): SessionRef {
  return {
    harness,
    sessionId: ref.nativeSessionId,
    path: ref.path,
    cwd: ref.cwd,
    mtimeMs: ref.mtimeMs,
  }
}

