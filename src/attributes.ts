/**
 * Span-attribute keys the upload path stamps. The CLI is the producer; the
 * Tangle Intelligence Platform is the consumer.
 *
 * `SESSION_ID` and `INGEST_SOURCE` are a cross-repo WIRE CONTRACT — the platform
 * keys its cross-source dedup on them (`session.id`/`tangle.sessionId` linkage +
 * `tangle.ingest_source === "cli"`). Do NOT change their string VALUES without a
 * coordinated platform release. The rest are stored-but-not-parsed metadata,
 * free to evolve.
 *
 * `SESSION_ID` stays camelCase because it must match agent-eval's
 * `parseConversationLinkage` key list; the metadata keys are snake_case.
 */
export const ATTR = {
  /** = the trace/session id. Wire contract (dedup linkage). */
  SESSION_ID: 'tangle.sessionId',
  /** "cli" marks a CLI upload so the platform can drop a re-upload of a session
   *  that also streamed live. Wire contract. */
  INGEST_SOURCE: 'tangle.ingest_source',
  HARNESS: 'tangle.harness',
  CWD: 'tangle.cwd',
  /** THE per-session grouping key the spine derives subjects from
   *  (`deriveSubjectKey` reads `tangle.subject.key` first). Resolves to the git
   *  remote (host/owner/repo) when readable, else the cwd path basename. */
  SUBJECT_KEY: 'tangle.subject.key',
  /** Normalized git remote (e.g. `github.com/tangle-network/agent-dev-container`). */
  GIT_REPOSITORY: 'git.repository',
  /** Current branch at conversion time. */
  GIT_BRANCH_NAME: 'git.branch',
  /** HEAD short sha at conversion time. */
  GIT_COMMIT: 'git.commit',
  /** How traces resolved the session cwd: recorded cwd, repaired cwd, or span path. */
  REPO_RESOLUTION_SOURCE: 'traces.repo_resolution_source',
  GIT_BRANCH: 'tangle.git_branch',
  HOST: 'tangle.host',
  /** Basename of the session file. (Renamed from the ambiguous `tangle.source`,
   *  which collided with `tangle.ingest_source`.) */
  SESSION_FILE: 'tangle.session_file',
  UPLOADED_AT: 'tangle.uploaded_at',
  UPLOADER: 'tangle.uploader',
  REDACTION_VERSION: 'redaction.version',
  REDACTION_COUNT: 'redaction.count',
  /** Upload contract: bounded root summary plus location-only receipt child spans.
   *  Receipt hashes are deliberate integrity evidence; raw malformed bytes never upload. */
  SESSION_INTEGRITY: 'traces.session.integrity',
  CORRUPTION_COUNT: 'traces.session.corruption_count',
  CORRUPTION_DIGEST: 'traces.session.corruption_digest',
  CORRUPTION_RECEIPT_VERSION: 'traces.session.corruption.receipt_version',
  CORRUPTION_RECEIPT_KIND: 'traces.session.corruption.kind',
  CORRUPTION_SOURCE_PATH: 'traces.session.corruption.source_path',
  CORRUPTION_LINE_NUMBER: 'traces.session.corruption.line_number',
  CORRUPTION_BYTE_OFFSET: 'traces.session.corruption.byte_offset',
  CORRUPTION_BYTE_LENGTH: 'traces.session.corruption.byte_length',
  CORRUPTION_SHA256: 'traces.session.corruption.sha256',
  RAW_SOURCE_RETENTION: 'traces.session.raw_source_retention',
} as const

/** `tangle.ingest_source` value for CLI-uploaded traces. Wire contract. */
export const INGEST_SOURCE_CLI = 'cli'

/** Harness used when none is specified on a single-harness command. */
export const DEFAULT_HARNESS = 'claude-code'

const SESSION_ID_ATTRIBUTE_KEYS = [ATTR.SESSION_ID, 'session.id', 'traces.session.id'] as const

export function sessionIdFromAttributes(
  attributes: Readonly<Record<string, unknown>>,
): string | undefined {
  return SESSION_ID_ATTRIBUTE_KEYS.map((key) => attributes[key]).find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
}

export interface SessionIdentityConflict {
  readonly traceId: string
  readonly sessionIds: readonly string[]
}

export interface SessionIdentityIndex {
  readonly sessionByTrace: Map<string, string>
  readonly conflicts: readonly SessionIdentityConflict[]
}

export function indexSessionIdsByTrace(
  spans: readonly {
    trace_id: string
    attributes: Readonly<Record<string, unknown>>
  }[],
): SessionIdentityIndex {
  const candidatesByTrace = new Map<string, Set<string>>()
  for (const span of spans) {
    const candidates = candidatesByTrace.get(span.trace_id) ?? new Set<string>()
    for (const key of SESSION_ID_ATTRIBUTE_KEYS) {
      const value = span.attributes[key]
      if (typeof value === 'string' && value.length > 0) candidates.add(value)
    }
    if (candidates.size > 0) candidatesByTrace.set(span.trace_id, candidates)
  }

  const sessionByTrace = new Map<string, string>()
  const conflicts: SessionIdentityConflict[] = []
  for (const [traceId, candidates] of candidatesByTrace) {
    const sessionIds = [...candidates].sort()
    if (sessionIds.length === 1) {
      sessionByTrace.set(traceId, sessionIds[0]!)
    } else {
      conflicts.push({ traceId, sessionIds })
    }
  }
  conflicts.sort((a, b) => a.traceId.localeCompare(b.traceId))
  return { sessionByTrace, conflicts }
}

/**
 * Ensure every locally parsed trace has one session identity without hiding
 * source conflicts. Existing stable identities win; otherwise the local
 * session reference is stamped on every span in that trace.
 */
export function stampSessionIdentity(
  spans: {
    trace_id: string
    attributes: Record<string, unknown>
  }[],
  fallbackSessionId: string,
): void {
  const { sessionByTrace, conflicts } = indexSessionIdsByTrace(spans)
  const conflictingTraceIds = new Set(conflicts.map((conflict) => conflict.traceId))
  const traceIds = new Set(spans.map((span) => span.trace_id))
  const singleTraceId = traceIds.size === 1 ? traceIds.values().next().value : undefined
  for (const span of spans) {
    if (conflictingTraceIds.has(span.trace_id)) continue
    const sessionId = sessionByTrace.get(span.trace_id) ?? singleTraceId ?? fallbackSessionId
    if (!sessionIdFromAttributes(span.attributes)) {
      span.attributes[ATTR.SESSION_ID] = sessionId
    }
  }
}
