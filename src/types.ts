/**
 * Harness trace adapter contract.
 *
 * Each coding-agent harness writes its session log in a different on-disk
 * format. An adapter knows (a) where that harness stores sessions and
 * (b) how to project one session file/dir onto normalized `OtlpSpan[]`.
 *
 * Adapters are the read counterpart of cli-bridge's existing per-harness
 * `BackendModule` resume logic — they live next to the code that already
 * locates these files.
 */

import type { OtlpSpan } from './otlp.js'

/** A single discovered session, before parsing. */
export interface SessionRef {
  /** Harness id (matches the nix profile / backend name). */
  harness: string
  /** Stable session identifier (uuid, thread id, or derived from path). */
  sessionId: string
  /** Absolute path to the session file (or session root dir for split formats). */
  path: string
  /** Working directory the session ran in, when recoverable. */
  cwd: string | null
  /** Last-modified epoch ms — used for `--last N` recency ordering. */
  mtimeMs: number
}

export interface LocateOptions {
  /** Limit discovery to sessions whose cwd matches (exact or prefix). */
  cwd?: string
  /** Only sessions modified at/after this epoch ms. */
  sinceMs?: number
}

export interface HarnessTraceAdapter {
  /** Canonical harness id this adapter handles. */
  readonly harness: string
  /** Aliases that resolve to this adapter (forks / variants / ACP wrappers). */
  readonly aliases?: readonly string[]
  /** Discover session files for this harness on disk. */
  locate(opts?: LocateOptions): Promise<SessionRef[]>
  /** Parse one discovered session into normalized OTLP spans. */
  parse(ref: SessionRef): Promise<OtlpSpan[]>
}
