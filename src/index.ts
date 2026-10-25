/**
 * @tangle-network/traces: the SDK.
 *
 * Each name is a function a `traces` command is built on, or the analyst
 * extension point (`analyzeSpans({ registry })`): named values and types, each
 * exported by name. `tests/sdk-surface.test.ts` fails when `dist/index.js` or
 * `dist/index.d.ts` differs from this list.
 *
 * Import other packages' names from their owners: `AnalystRegistry`,
 * `makeFinding` and the redaction core from `@tangle-network/agent-eval`, and
 * the span builders and vocabulary from `@tangle-network/agent-trace-contract`.
 */

// ── Read: sessions from a harness store, or OTLP from any producer ────────
export { knownHarnesses } from './registry.js'
export { collectSessionSelection } from './session-selection.js'
export type { SessionSeedGroup, SessionSelection, SessionSelectionRow, CollectSessionSelectionOptions } from './session-selection.js'
export { describeSessionRelationship } from './session-relationship.js'
export type { SessionRelationship } from './session-relationship.js'
export type { SessionWorkflowSummary, SessionWorkflowIssue } from './session-workflow.js'
export { parseSession, scanSessions } from './session-source.js'
export type { ScanOptions, ScannedSession } from './session-source.js'
export type { HarnessTraceAdapter, SessionRef } from './types.js'
export { readOtlpInput } from './otlp-input.js'
export type { OtlpInput } from './otlp-input.js'
export { writeOtlpFile } from './otlp.js'
export type { OtlpSpan } from './otlp.js'

// ── facts: what happened, exactly, for $0 ─────────────────────────────────
export { buildSessionFactsReport, computeSessionFacts, renderSessionFacts } from './session-facts.js'
export type { SessionFact, SessionFacts, SessionFactsReport } from './session-facts.js'
export type { SessionTurnFact } from './session-turns.js'

// ── analyze: what went wrong, ranked; your own analysts through `registry` ─
export { analyzeSpans } from './analyze.js'
export type { AnalyzeOptions, AnalyzeResult } from './analyze.js'
export { buildTraceFindingPacket, runTraceInvestigation } from './improvement.js'
export type {
  BuildTraceFindingPacketOptions,
  TraceFindingPacket,
  TraceInvestigationOptions,
  TraceInvestigationResult,
} from './improvement.js'

// ── ask: the one call that spends ─────────────────────────────────────────
export { runTraceQuestions } from './ask.js'
export type { TraceQuestion, TraceQuestionsResult } from './ask.js'
export { analysisEngineFromEnv } from './analyst-model-call.js'

// ── check: conformance here; the contract checker is agent-eval's ─────────
export { conformanceOfSpans } from './conformance.js'

// ── diff ──────────────────────────────────────────────────────────────────
export { diffRuns, renderRunDiff } from './diff.js'
export type { RunDiffReport } from './diff.js'

// ── watch: the events `traces watch --format jsonl` prints ────────────────
export { streamSessions } from './live.js'
export type { TraceStreamEvent } from './live.js'
export type { TraceLiveFinding } from './pipelines.js'

// ── share: redact, judge, upload ──────────────────────────────────────────
export { assessSpans, redactSpans } from './redact.js'
export { verifySafe } from './verify-safe.js'
export type { VerifySafeResult } from './verify-safe.js'
export { executeUpload, planUpload } from './upload.js'
export type { UploadBackend, UploadPlan } from './upload.js'

// ── bundle: one session's evidence, kept and verified ─────────────────────
export { assembleSessionBundle, verifySessionBundle } from './bundle.js'
export type { SessionBundleManifest } from './bundle.js'

// ── meta ──────────────────────────────────────────────────────────────────
export { tracesVersion } from './version.js'
