# Library (SDK)

[traces](../README.md#docs) › Library (SDK)

The main exports. [`src/index.ts`](../src/index.ts) is the complete list; resolve signatures there.

The CLI is a thin consumer of these exports.

| Export | Signature | Use |
|---|---|---|
| `readOtlpInput` | `(file\|dir) → { files, skipped, rows, spans, validation, issues }` | ingest OTLP from **any** system — no adapter; never throws on a foreign trace |
| `validateTraceSpans` | `(spans) → { ok, findings, capabilities }` | the contract's conformance check, re-exported |
| `conformanceOfSpans` | `(spans) → TraceValidation` | grade spans this package produced, on the artifact a consumer receives |
| `renderValidation` / `renderConformance` | `(validation, opts) → string` | the `validate` report / its conformance section |
| `skippedAnalyses` | `(validation) → SkippedAnalysis[]` | which analyses a missing capability empties, and why |
| `summarizeSpanStructure` | `(spans) → SpanStructure` | how much of the tree attaches: rootless, orphans, links |
| `analyzeLoopConvergence` | `(spans) → LoopConvergenceReport` | per loop, the per-round outcome/score series and whether it improved, plateaued, regressed or fell back |
| `analyzeSteeringChain` | `(spans) → SteeringChainReport` | which verdict span caused which subsequent round, following `links` |
| `llmSpan` / `toolSpan` / `loopSpan` / `branchSpan` / `steeredBy` | contract builders, re-exported | emit conforming spans from your own system |
| `analyzeSpans` | `(spans, { registry? }) → AnalyzeResult` | run agent-eval's deterministic behavioral analyst, or **your own** via `registry`; no model call |
| `runTraceInvestigation` | `(TraceInvestigationOptions) → TraceInvestigationResult` | what `traces analyze <ref> --format json` prints: facts, finding packet, measures, conformance, `cannotAnswer` |
| `runTraceQuestions` | `(TraceQuestionsOptions) → TraceQuestionsResult` | ask many free-form questions of one span list, concurrently, under one shared cost ledger; keeps each answer and checks its citations |
| `buildTraceFindingPacket` | `({ findings }) → TraceFindingPacket` | render any `AnalystFinding[]` without changing its schema |
| `streamSessions` | `(TraceStreamOptions) → Promise<void>` | the session, finding and tick events `traces watch --format jsonl` prints, over active or named sessions |
| `classifyLiveActions` | `(spans) → TraceLiveAction[]` | classify spans once as read/edit/verify/tool/other |
| `defaultTraceLiveAnalysts` | `TraceLiveAnalyst[]` | the built-in online analysts; extend or replace them |
| `collectSessionWorkflow` | `(adapter, seeds, opts?) → SessionWorkflow` | resolve a bounded parent/child session tree with explicit relationship issues |
| `collectSessionSelection` | `(groups, opts?) → SessionSelection` | parse, expand, and optionally byte-bind selected session groups |
| `exportTraceEvidenceFile` | `(path, opts?) → { format, spans, redactionCount }` | convert compact evidence/events/OpenInference files to redacted OpenInference spans |
| `scanSessions` | `(ScanOptions) → AsyncIterable<ScannedSession>` | the shared locate→parse iterator |
| `redactSpans` | `(spans, { profile?, knownSecrets? }) → { spans, report }` | redact spans with agent-eval's redaction core |
| `assessSpans` / `verifySafe` | `(spans, profile?)` / `(path, { profile?, knownSecrets? })` → verdict | share-safety verdict for spans or files |
| `planUpload` / `executeUpload` | `(…, { backend? }) → …` | redact + dedup + send to any sink |
| `selectAdapters` / `listAdapters` / `resolveAdapter` | adapter selection + the harness registry |
| `HarnessTraceAdapter` | interface (`locate` + `parse`) | implement to add a harness |

```ts
import {
  AnalystRegistry, analyzeSpans, makeFinding, readOtlpInput, renderValidation,
  streamSessions,
} from '@tangle-network/traces'

// Read OTLP any system emitted, and find out what it can answer before analysing:
const input = await readOtlpInput('spans.otlp.jsonl')   // or a directory
console.log(renderValidation(input.validation, { subject: 'spans.otlp.jsonl', spans: input.spans }))
if (input.validation.ok) await analyzeSpans(input.spans)

// Watch live sessions and feed their findings anywhere (read-only, cancellable):
const c = new AbortController()
await streamSessions({ signal: c.signal, onEvent: (event) => { if (event.event === 'finding') alert(event.finding.claim) } })

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
