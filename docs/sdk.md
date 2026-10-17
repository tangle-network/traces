# Library (SDK)

[traces](../README.md#docs) › Library (SDK)

The SDK is 25 functions and 25 types. Each function is the engine of a `traces` command, or the analyst extension point (`analyzeSpans` with your own `registry`).
[`src/index.ts`](../src/index.ts) lists them, and `tests/sdk-surface.test.ts` fails when the built package exports any other name.
Import other packages' names from their owners: `AnalystRegistry`, `makeFinding`, `checkTraceContracts` and the redaction core from `@tangle-network/agent-eval`, and the span builders from `@tangle-network/agent-trace-contract`.

| Export | Signature | Command it serves |
|---|---|---|
| `scanSessions` | `(ScanOptions) → AsyncGenerator<ScannedSession>` | every command: locate, then parse, each harness session |
| `parseSession` | `(adapter, SessionRef, opts?) → Promise<OtlpSpan[]>` | one session's spans |
| `knownHarnesses` | `() → string[]` | the ids `--harness` takes |
| `readOtlpInput` | `(file or dir) → Promise<OtlpInput>` | read OTLP from any producer; never throws on a foreign trace |
| `writeOtlpFile` | `(spans, path) → Promise<string>` | `traces convert <ref> --out <file>` |
| `computeSessionFacts` | `(spans, opts?) → SessionFacts[]` | `traces facts`: one sheet per session |
| `buildSessionFactsReport` | `(spans, opts?) → SessionFactsReport` | `traces facts <ref> --format json` |
| `renderSessionFacts` | `(SessionFactsReport) → string` | `traces facts` text |
| `analyzeSpans` | `(spans, AnalyzeOptions?) → Promise<AnalyzeResult>` | agent-eval's deterministic analyst, or yours through `{ registry }`; no model call |
| `runTraceInvestigation` | `(TraceInvestigationOptions) → Promise<TraceInvestigationResult>` | `traces analyze <ref> --format json`: facts, finding packet, measures, conformance, `cannotAnswer` |
| `buildTraceFindingPacket` | `(BuildTraceFindingPacketOptions) → TraceFindingPacket` | `findings.json` under `traces analyze <ref> --out <dir>`; renders any `AnalystFinding[]` unchanged |
| `runTraceQuestions` | `(options) → Promise<TraceQuestionsResult>` | `traces ask`: concurrent questions under one cost ledger, citations checked |
| `analysisEngineFromEnv` | `({ model, maxCostUsd?, timeoutMs?, onPermanentFailure?, env? }) → engine` | the model engine `traces ask` runs |
| `conformanceOfSpans` | `(spans) → TraceValidation` | `traces check <ref> --contract conformance` |
| `diffRuns` | `(a, b) → Promise<RunDiffReport>` | `traces diff`: two trace files or `file#<trace id>` refs |
| `renderRunDiff` | `(RunDiffReport) → string` | `traces diff` text |
| `streamSessions` | `(options) → Promise<void>` | `traces watch --format jsonl`: session, finding and tick events (`TraceStreamEvent`) |
| `redactSpans` | `(spans, { profile?, knownSecrets? }) → { spans, report }` | redaction before `upload` |
| `assessSpans` | `(spans, profile?) → ShareSafetyVerdict` | the share verdict for spans |
| `verifySafe` | `(path, { knownSecrets? }) → Promise<VerifySafeResult>` | `traces check <path> --share-safe` |
| `planUpload` | `(opts?) → Promise<UploadPlan>` | `traces upload <ref> --dry-run` |
| `executeUpload` | `(UploadPlan, { backend? }) → Promise<result>` | `traces upload`, to Intelligence or your own `UploadBackend` |
| `assembleSessionBundle` | `({ adapter, ref, outDir }) → Promise<result>` | `traces bundle` |
| `verifySessionBundle` | `(dir) → Promise<verification>` | `traces bundle verify <dir>` |
| `tracesVersion` | `() → string` | `traces --version` |

**Types:** `OtlpSpan`, `SessionRef`, `ScanOptions`, `ScannedSession`, `HarnessTraceAdapter`, `OtlpInput`, `SessionFact`, `SessionFacts`, `SessionFactsReport`, `SessionTurnFact`, `AnalyzeOptions`, `AnalyzeResult`, `TraceInvestigationOptions`, `TraceInvestigationResult`, `TraceFindingPacket`, `BuildTraceFindingPacketOptions`, `TraceQuestion`, `TraceQuestionsResult`, `RunDiffReport`, `TraceStreamEvent`, `TraceLiveFinding`, `UploadPlan`, `UploadBackend`, `VerifySafeResult`, `SessionBundleManifest`.
An options type that is not listed is still in `dist/index.d.ts`; name it as `Parameters<typeof runTraceQuestions>[0]`.

```ts
import { AnalystRegistry, makeFinding } from '@tangle-network/agent-eval/analyst'
import { analyzeSpans, readOtlpInput, streamSessions } from '@tangle-network/traces'

// Read OTLP any system emitted, and find out what it can answer before analysing:
const input = await readOtlpInput('spans.otlp.jsonl')   // or a directory
console.log(input.validation.capabilities)
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

The runnable version of the last part is [`examples/custom-analyst.ts`](../examples/custom-analyst.ts).
