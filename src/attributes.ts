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
