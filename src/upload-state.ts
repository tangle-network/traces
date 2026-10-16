/**
 * Local upload-dedup state.
 *
 * Persists the final outbound content hash for each harness/session so an
 * unchanged upload is skipped while changed spans or privacy modes are sent.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { contentHash } from '@tangle-network/agent-eval'
import type { TraceSpanEvent } from '@tangle-network/agent-eval/hosted'
import type { OtlpSpan } from './otlp.js'

function stateFile(): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
  return join(base, 'tangle-traces', 'uploaded.json')
}

export interface UploadRecord {
  hash: string
  uploadedAt: string
  harness: string
  spanCount: number
}

/** Keyed by `${harness}:${sessionId}`. */
export type UploadState = Record<string, UploadRecord>

export function uploadKey(harness: string, sessionId: string): string {
  return `${harness}:${sessionId}`
}

/** Stable content hash of complete spans, including captured values and results. */
export function sessionHash(spans: readonly OtlpSpan[]): string {
  return contentHash(spans).slice(0, 32)
}

export interface UploadIdentity {
  stripContent: boolean
  /**
   * Always null: the external redactor hook is gone (1.0). The field stays in
   * the hashed identity so a session uploaded before 1.0 still matches its
   * recorded hash and is not sent twice.
   */
  redactor: null
  redactionVersion: string
}

/** Hash the exact outbound events and the privacy mode that produced them. */
export function outboundHash(events: readonly TraceSpanEvent[], identity: UploadIdentity): string {
  return contentHash({ events, identity }).slice(0, 32)
}

export async function loadState(): Promise<UploadState> {
  try {
    return JSON.parse(await readFile(stateFile(), 'utf8')) as UploadState
  } catch {
    return {}
  }
}

export async function saveState(state: UploadState): Promise<void> {
  const f = stateFile()
  await mkdir(dirname(f), { recursive: true })
  await writeFile(f, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** True when this session+hash has already been uploaded. */
export function alreadyUploaded(state: UploadState, harness: string, sessionId: string, hash: string): boolean {
  return state[uploadKey(harness, sessionId)]?.hash === hash
}
