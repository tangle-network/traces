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
export { knownHarnesses, listAdapters, resolveAdapter, selectAdapters } from './registry.js'
export * from './session-source.js' // scanSessions() — shared locate→parse iterator
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

// ── Detection / analysis (built-in, or bring your own analysts) ───────────
export * from './pipelines.js' // runPipelines() — stuck-loop + tool-use
export * from './runtime-store.js' // toRuntimeStore() — feed agent-eval pipelines
export * from './analyze.js' // analyzeSpans({ registry? }) — run YOUR analysts

// ── Live observation (event-driven; feed any system) ──────────────────────
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
