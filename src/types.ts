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
import type { JsonlCorruptionReceipt } from './jsonl.js'

export type CorruptionMode = 'recover' | 'strict'

export interface ParseOptions {
  /** Recover valid JSONL records by default; strict rejects the first corruption. */
  corruptionMode?: CorruptionMode
  /** For resumed session formats, parse all turns, the latest turn, or one exact turn. */
  taskScope?: 'all' | 'latest' | 'turn'
  /** Stable turn identifier required when taskScope is `turn`. */
  taskTurnId?: string
  /** Stop active session reads and parsing. */
  signal?: AbortSignal
}

export type ParentTaskResolution =
  | { readonly kind: 'resolved'; readonly turnId: string }
  | {
      readonly kind: 'unavailable'
      readonly reason: 'child-reference-not-found' | 'parent-turn-metadata-missing' | 'ambiguous'
      readonly turnIds?: readonly string[]
    }

export interface SessionCorruptionReceipt extends JsonlCorruptionReceipt {
  harness: string
  sessionId: string
}

export interface SessionIntegrity {
  status: 'degraded_not_lossless'
  corruptions: SessionCorruptionReceipt[]
}

/**
 * Execution-environment identity for a session — what replay verification
 * needs to reconstruct where the session's commands actually ran. Populated
 * by adapters/importers where known: sandbox sessions know their image
 * (`runtime.ready` carries it); host-harness sessions usually do not.
 * Absent fields mean "not recorded", never "none".
 */
export interface SessionEnvironment {
  /** Container image reference (repo:tag or repo@digest) the session executed in. */
  image?: string
  /** Immutable image digest (`sha256:…`) — the replay-grade pin when known. */
  imageDigest?: string
  /** Sandbox/container instance id that executed the session. */
  sandboxId?: string
  /** Working directory commands executed from; null when unrecorded. */
  cwd: string | null
  /** Commit hash the workspace was at when the session ran, when recorded. */
  gitCommit?: string
}

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
  /** Present when parsing recovered valid records around corrupt source records. */
  integrity?: SessionIntegrity
  /** Execution-environment identity, when the source records it (sandbox sessions). */
  environment?: SessionEnvironment
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
  /** Resolve all files for one stable session ID without cataloging unrelated sessions. */
  locateBySessionId?(sessionId: string, opts?: LocateOptions): Promise<SessionRef[]>
  /** Parse one discovered session into normalized OTLP spans. */
  parse(ref: SessionRef, options?: ParseOptions): Promise<OtlpSpan[]>
  /** Every file whose bytes can affect parse output. Defaults to ref.path. */
  sourcePaths?(
    ref: SessionRef,
    options?: Pick<ParseOptions, 'signal'>,
  ): Promise<readonly string[]>
  /**
   * Resolve the exact parent task that referenced a child by stable session ID.
   * Adapters must not infer this from names or timestamps.
   */
  resolveParentTask?(
    ref: SessionRef,
    childSessionId: string,
    options?: Pick<ParseOptions, 'corruptionMode' | 'signal'>,
  ): Promise<ParentTaskResolution>
  /**
   * Resolve the child sessions a parent spawned when the harness recorded no child session ID.
   *
   * Some harness builds name a spawned child only by the task path the parent asked for
   * (codex `exec` 0.148-0.152 returns `{"task_name": "/root/c1_b_grid"}` and emits no
   * `sub_agent_activity` stream). The same path is stamped in the child's own session metadata
   * alongside its parent's ID, so the pair (parent session ID, agent path) is an exact key.
   * Adapters must match that pair exactly and must not infer a child from names or timestamps.
   */
  locateSpawnedChildren?(
    parentSessionId: string,
    agentPaths: readonly string[],
    options?: LocateOptions & Pick<ParseOptions, 'corruptionMode' | 'signal'>,
  ): Promise<readonly SpawnedChildResolution[]>
}

/** One `agent path -> child session` answer. `ref` is absent when the pair matched no file. */
export interface SpawnedChildResolution {
  readonly agentPath: string
  readonly ref?: SessionRef
  readonly reason?: 'not-found' | 'ambiguous'
  /** Session IDs that matched the pair when more than one did. */
  readonly candidates?: readonly string[]
}
