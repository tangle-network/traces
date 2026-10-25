# Library (SDK)

[traces](../README.md#docs) › Library (SDK)

The SDK exports named functions and types. Each function is the engine of a `traces` command, or the analyst extension point (`analyzeSpans` with your own `registry`).
[`src/index.ts`](../src/index.ts) lists them, and `tests/sdk-surface.test.ts` fails when the built package exports any other name.
Import other packages' names from their owners: `AnalystRegistry`, `makeFinding`, `checkTraceContracts` and the redaction core from `@tangle-network/agent-eval`, and the span builders from `@tangle-network/agent-trace-contract`.

| Export | Signature | Command it serves |
|---|---|---|
| `collectSessionSelection` | `(SessionSeedGroup[], CollectSessionSelectionOptions?) → Promise<SessionSelection>` | `traces graphs`: existing workflow expansion, source binding and explicit missing/ambiguous relationships |
| `describeSessionRelationship` | `(SessionRef, spans) → SessionRelationship` | `traces graphs`: recorded parent, child and resumed-session links |
| `buildSpanRunTree` | `(spans, source) → SpanRunSnapshot` | `traces graphs`: existing span identity/containment tree; facts remains the token owner |
| `scanSessions` | `(ScanOptions) → AsyncGenerator<ScannedSession>` | every command: locate, then parse, each harness session |
| `parseSession` | `(adapter, SessionRef, opts?) → Promise<OtlpSpan[]>` | one session's spans |
| `knownHarnesses` | `() → string[]` | the ids `--harness` takes |
| `readOtlpInput` | `(file or dir, options?) → Promise<OtlpInput>` | read OTLP from any producer; never throws on a foreign trace |
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

**Types:** `SpanRunSnapshot`, `SpanRunNode`, `SessionSeedGroup`, `SessionSelection`, `SessionSelectionRow`, `CollectSessionSelectionOptions`, `SessionRelationship`, `SessionWorkflowSummary`, `SessionWorkflowIssue`, `OtlpSpan`, `SessionRef`, `ScanOptions`, `ScannedSession`, `HarnessTraceAdapter`, `OtlpInput`, `SessionFact`, `SessionFacts`, `SessionFactsReport`, `SessionTurnFact`, `AnalyzeOptions`, `AnalyzeResult`, `TraceInvestigationOptions`, `TraceInvestigationResult`, `TraceFindingPacket`, `BuildTraceFindingPacketOptions`, `TraceQuestion`, `TraceQuestionsResult`, `RunDiffReport`, `TraceStreamEvent`, `TraceLiveFinding`, `UploadPlan`, `UploadBackend`, `VerifySafeResult`, `SessionBundleManifest`.
An options type that is not listed is still in `dist/index.d.ts`; name it as `Parameters<typeof runTraceQuestions>[0]`.

```ts
import { analyzeSpans, readOtlpInput, streamSessions } from '@tangle-network/traces'

const input = await readOtlpInput('spans.otlp.jsonl')   // any producer; never throws on a foreign trace
console.log(input.validation.capabilities)

const stop = new AbortController()
await streamSessions({ signal: stop.signal, onEvent: (event) => { if (event.event === 'finding') console.log(event.finding.claim) } })
```

## Write your own analyst

An analyst receives a paged trace store and returns typed findings; start with deterministic logic when the trace holds the facts.

```ts
import { buildDefaultAnalystRegistry, defineTraceAnalyst, makeFinding } from '@tangle-network/agent-eval/analyst'
import { analyzeSpans } from '@tangle-network/traces'

const failedTools = defineTraceAnalyst({
  id: 'failed-tools',
  description: 'Reports repeated tool failure signatures.',
  async analyze(store) {
    const overview = await store.getOverview({ has_errors: true })
    return overview.error_clusters.map((cluster) => makeFinding({
      analyst_id: 'failed-tools', area: 'tool-use', subject: cluster.signature,
      claim: `${cluster.span_count} spans share this failure`, severity: cluster.span_count >= 3 ? 'high' : 'medium',
      evidence_refs: [{ kind: 'span', uri: `trace://${cluster.exemplar_trace_ids[0]}/span/${cluster.exemplar_span_ids[0]}` }],
      confidence: 1, id_basis: cluster.signature,
    }))
  },
})
const registry = buildDefaultAnalystRegistry()
registry.register(failedTools)
const { result } = await analyzeSpans(spans, { registry })
```

The runnable version is [`examples/custom-analyst.ts`](../examples/custom-analyst.ts) (`pnpm tsx examples/custom-analyst.ts --fixture` prints its one finding).
Do not rewrite policy from an analyst's prose alone: attach a measured outcome or reviewed feedback, promote the failure into an eval case, change one thing, and compare on fresh cases.

## Observed workflow nodes

`computeSessionFacts(spans, { includeSubagents: true })` projects the existing span-run tree’s exclusive node memberships into separate `SessionFacts`, including folded children and recorded workflow phases. Each node counts its own records and tokens through the same facts engine; a parent's tokens exclude its children. The default remains one sheet per trace. Original `traceId` and `rootSpanId` identify every boundary; a missing native `sessionId` stays null. `SpanRunNode.kind` preserves the recorded boundary kind and `spanIds` names its exclusive records. `typedTurnCounts` preserves the shared classifier's uncapped human, fleet and relay counts without message text or repeated per-turn identifiers. The cited native CLI facts sheet omits these graph-only SDK helpers (`rootSpanId` and `typedTurnCounts`); graph ingestion consumes them directly before display compaction.

`collectSessionSelection` expands existing parent/child links and returns its workflow's `complete` and `issues`; callers retain those unknowns. With `bindSources: true`, workflow discovery and its byte-bound re-read use the same source-capture projection; a changed source digest or relationship still refuses ingestion. This is a reader result, not another graph schema. Runtime owns `StoredGraph`, `GraphRunRecord` and converting these facts into observations.

Runtime run readers use `readOtlpInput(path, { allowEmptyDirectory: true })` to select retained OTLP before journal fallback. Ordinary calls retain their existing no-OTLP-directory refusal. A run with retained spans never adds journal-derived usage to those spans.
