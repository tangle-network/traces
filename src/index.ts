/**
 * @tangle-network/traces — library surface.
 *
 * Build on top of the trace toolkit programmatically: read coding-agent
 * sessions (or register your own harness), convert to OTLP, run the loop/stall
 * pipelines or your OWN analysts, observe live sessions with an event API,
 * collect redacted batches, and upload to the Tangle Intelligence Platform or
 * your own sink.
 *
 * The CLI (`traces`) is a thin consumer of exactly these primitives.
 */

// ── Core span model + adapters (read / convert / extend) ──────────────────
export * from './types.js' // HarnessTraceAdapter, SessionRef, LocateOptions
export * from './otlp.js' // OtlpSpan, span(), serializeSpans(), writeOtlpFile()
export * from './attributes.js' // ATTR keys, INGEST_SOURCE_CLI, DEFAULT_HARNESS
export * from './time.js' // parseIsoToEpochMs(), parseSince()
export { JsonSourceError, readJsonFile } from './json.js'
export { JsonlParseError, readJsonl, takeJsonl } from './jsonl.js'
export type { JsonlCorruptionReceipt, JsonlReadOptions } from './jsonl.js'
export {
  recordSessionCorruption,
  sessionIntegrityAttributes,
  stampSessionIntegrity,
} from './integrity.js'
export { knownHarnesses, listAdapters, resolveAdapter, selectAdapters } from './registry.js'
export * from './session-source.js' // scanSessions() / parseSession() — locate→parse→stamp
export * from './repo.js' // resolveRepoAttrs() — per-session repo/git resource labels
export { ClaudeAdapter } from './adapters/claude.js'
export { CodexAdapter } from './adapters/codex.js'
export { OpencodeAdapter } from './adapters/opencode.js'
export { GeminiAdapter } from './adapters/gemini.js'
export { QwenAdapter } from './adapters/qwen.js'
export { FactoryAdapter } from './adapters/factory.js'
export { PiAdapter } from './adapters/pi.js'
export { AmpAdapter } from './adapters/amp.js'
export { CopilotAdapter } from './adapters/copilot.js'
export { ForgeAdapter } from './adapters/forge.js'
// Conversation-capture helpers for custom adapters — emit the human's turn the
// same way every built-in adapter does.
export { ACTOR_ATTR, CONTENT_CAP, capText, userPromptSpan } from './adapters/conversation.js'
export type { Actor, UserPromptInput } from './adapters/conversation.js'
// Actor + reaction classification (the user-reaction analyst keys off these).
export {
  classifyReaction,
  claudeActor,
  codexActor,
  CORRECTIVE_REACTIONS,
  looksLikeAgentPrompt,
  textIsSynthetic,
} from './adapters/actor.js'
export type { Reaction } from './adapters/actor.js'

// ── Detection / analysis (built-in, or bring your own analysts) ───────────
export * from './pipelines.js' // runPipelines() — repeated-call + tool-use
export * from './reactions.js' // analyzeReactions() — human-reaction analyst
export * from './adoption.js' // analyzeAdoption() — skill + subagent metrics
export * from './runtime-store.js' // toRuntimeStore() — feed agent-eval pipelines
export * from './analyze.js' // analyzeSpans({ registry? }) — run YOUR analysts
export * from './evidence.js' // policy-evidence JSONL for downstream miners
export * from './session-index.js' // collectSessionIndex() — reusable session catalog
export * from './inspect.js' // inspectSessionIndex() — ranked findings from a session catalog
export * from './file-export.js' // convert evidence/events files to OpenInference JSONL
export * from './improvement.js' // runTraceInvestigation()/runTraceImprovementLoop() artifact pack

// ── External engines (NOT bundled — shell out to tools you install) ────────
export * from './external.js' // haloAnalyzer / commandAnalyzer; commandRedactor

// ── Live observation (event-driven; feed any system) ──────────────────────
export * from './live.js' // streamSessions(), traceStreamEventsFromSpans(), semantic live findings
export * from './observer.js' // watchSessions({ onLoop, onReport, signal })

// ── Privacy + batch collection + upload (pluggable backend) ───────────────
export * from './redact.js' // redactSpans(), TRACES_REDACTION_RULES
export * from './collect.js' // collectSessions() — redacted batches
export * from './upload.js' // planUpload / executeUpload({ backend? })
export * from './upload-state.js' // dedup state

// ── agent-eval extension essentials, re-exported for one-import ergonomics ─
export {
  AnalystRegistry,
  buildDefaultAnalystRegistry,
  makeFinding,
} from '@tangle-network/agent-eval/analyst'
export type { Analyst, AnalystContext, AnalystFinding } from '@tangle-network/agent-eval/analyst'
export { createHostedClient, hostedClientFromEnv } from '@tangle-network/agent-eval/hosted'
export type { HostedClient } from '@tangle-network/agent-eval/hosted'
export { DEFAULT_REDACTION_RULES, redactString, redactValue } from '@tangle-network/agent-eval/traces'
export type { RedactionReport, RedactionRule } from '@tangle-network/agent-eval/traces'
