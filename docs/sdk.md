# Library (SDK)

[traces](../README.md#docs) › Library (SDK)

The CLI is a thin consumer of these exports.

| Export | Signature | Use |
|---|---|---|
| `readOtlpInput` | `(file\|dir) → { files, skipped, rows, spans, validation, issues }` | ingest OTLP from **any** system — no adapter; never throws on a foreign trace |
| `validateTraceSpans` | `(spans) → { ok, findings, capabilities }` | the contract's conformance check, re-exported |
| `conformanceOfSpans` | `(spans) → TraceValidation` | grade spans this package produced, on the artifact a consumer receives |
| `renderValidation` / `renderConformance` | `(validation, opts) → string` | the `validate` report / the section embedded in an analysis report |
| `skippedAnalyses` | `(validation) → SkippedAnalysis[]` | which analyses a missing capability empties, and why |
| `unavailableCapabilities` / `incompleteInputsNote` | `(validation) → Map` / `(map, name) → string` | the gate: what the trace cannot support, and the marker each affected section carries |
| `summarizeSpanStructure` | `(spans) → SpanStructure` | how much of the tree attaches: rootless, orphans, links |
| `analyzeLoopConvergence` | `(spans) → LoopConvergenceReport` | per loop, the per-round outcome/score series and whether it improved, plateaued, regressed or fell back |
| `analyzeSteeringChain` | `(spans) → SteeringChainReport` | which verdict span caused which subsequent round, following `links` |
| `llmSpan` / `toolSpan` / `loopSpan` / `branchSpan` / `steeredBy` | contract builders, re-exported | emit conforming spans from your own system |
| `analyzeSpans` | `(spans, { registry?, ai?, budgetUsd? }) → AnalyzeResult` | run built-in analysts, or **your own** via `registry` |
| `runTraceInvestigation` | `(TraceInvestigationOptions) → TraceInvestigationResult` | typed findings with actions/checks, execution facts, external analyzer output, and report |
| `runTraceImprovement` | `(TraceImprovementOptions) → TraceImprovementResult` | writes the full findings, evidence, report, and trace artifact pack |
| `runTraceQuestions` | `(TraceQuestionsOptions) → TraceQuestionsResult` | ask many free-form questions of one span list, concurrently, under one shared cost ledger; keeps each answer and checks its citations |
| `buildTraceFindingPacket` | `({ findings }) → TraceFindingPacket` | render any `AnalystFinding[]` without changing its schema |
| `runTraceStoreInvestigation` | `({ traceStore }) → TraceStoreInvestigationResult` | run the same packet layer over a hosted/custom `TraceAnalysisStore` |
| `loadTracesConfig` | `(path?) → TracesConfig \| undefined` | load BYO analysts and external analyzers |
| `watchSessions` | `(ObserverOptions) → Promise<void>` | live observer; `onLoop` / `onReport` / `signal` / `adapters` |
| `streamSessions` | `(TraceStreamOptions) → Promise<void>` | live JSONL-ready event stream over active sessions |
| `traceStreamEventsFromSpans` | `(spans, opts?) → TraceStreamEvent[]` | replay an existing span list as stream events |
| `analyzeLiveBatch` | `(spans, opts?) → TraceLiveBatch` | compute semantic online findings for one batch |
| `classifyLiveActions` | `(spans) → TraceLiveAction[]` | classify spans once as read/edit/verify/claim/tool/other |
| `defaultTraceLiveAnalysts` | `TraceLiveAnalyst[]` | the built-in online analysts; extend or replace them |
| `collectSessionIndex` | `(ScanOptions) → TraceSessionIndex` | scan sessions and return a reusable JSON-ready catalog |
| `inspectSessionIndex` | `(TraceSessionIndex) → TraceInspectionReport` | rank improvement findings from an index without rescanning sessions |
| `buildPolicyEvidenceRecord` | `(ref, spans, opts?) → PolicyEvidenceRecord` | summarize one session for downstream policy mining |
| `collectPolicyEvidence` | `(ScanOptions) → PolicyEvidenceRecord[]` | scan harness sessions and emit policy-evidence rows |
| `collectSessionWorkflow` | `(adapter, seeds, opts?) → SessionWorkflow` | resolve a bounded parent/child session tree with explicit relationship issues |
| `collectSessionSelection` | `(groups, opts?) → SessionSelection` | parse, expand, and optionally byte-bind selected session groups |
| `exportTraceEvidenceFile` | `(path, opts?) → { format, spans, redactionCount }` | convert compact evidence/events/OpenInference files to redacted OpenInference spans |
| `scanSessions` | `(ScanOptions) → AsyncIterable<ScannedSession>` | the shared locate→parse iterator |
| `collectSessions` | `(CollectOptions) → SessionBatch[]` | redacted per-session batches for your own pipeline |
| `redactSpans` | `(spans, { profile?, knownSecrets? }) → { spans, report }` | redact spans with agent-eval's redaction core |
| `assessSpans` / `verifySafe` | `(spans, profile?)` / `(path, { profile?, knownSecrets? })` → verdict | share-safety verdict for spans or files |
| `planUpload` / `executeUpload` | `(…, { backend? }) → …` | redact + dedup + send to any sink |
| `selectAdapters` / `listAdapters` / `resolveAdapter` | adapter selection + the harness registry |
| `PiAdapter` | `new PiAdapter({ sessionsRoot? })` | parse Pi's default session tree or an exact `PI_CODING_AGENT_SESSION_DIR` |
| `HarnessTraceAdapter` | interface (`locate` + `parse`) | implement to add a harness |
| `ExternalAnalyzer` / `Redactor` | `haloAnalyzer` / `hodoscopeAnalyzer` / `commandAnalyzer` / `commandRedactor` | drive engines/models you install |

```ts
import {
  AnalystRegistry, analyzeSpans, makeFinding, readOtlpInput, renderValidation,
  streamSessions, watchSessions,
} from '@tangle-network/traces'

// Read OTLP any system emitted, and find out what it can answer before analysing:
const input = await readOtlpInput('spans.otlp.jsonl')   // or a directory
console.log(renderValidation(input.validation, { subject: 'spans.otlp.jsonl', spans: input.spans }))
if (input.validation.ok) await analyzeSpans(input.spans)

// Observe live sessions, feed findings anywhere (read-only, cancellable):
const c = new AbortController()
await watchSessions({ all: true, signal: c.signal, onLoop: (l) => alert(`${l.toolName} x${l.occurrences}`) })

// Feed a visualizer or dashboard:
await streamSessions({ all: true, signal: c.signal, includeSpans: false, onEvent: (event) => console.log(event) })

// Run your own analyst instead of the built-ins:
const registry = new AnalystRegistry()
registry.register({
  id: 'mine', description: '…', inputKind: 'trace-store', cost: { kind: 'deterministic' }, version: '1.0.0',
  async analyze() {
    return [makeFinding({ analyst_id: 'mine', area: 'custom', claim: '…', severity: 'info', evidence_refs: [], confidence: 0.9 })]
  },
})
await analyzeSpans(input.spans, { registry })
```
