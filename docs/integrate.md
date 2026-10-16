# Integrate your own system

[traces](../README.md#docs) › Integrate your own system

No adapter, no plugin. Emit the span contract and pass the file as the ref.

```bash
npm i @tangle-network/agent-trace-contract    # zero runtime dependencies
```

You install it to PRODUCE spans. This package already depends on it to read
them, so `npx @tangle-network/traces@latest` arrives with the contract-backed
analyses working: trace conformance, `traces validate`, OTLP files as refs,
round-over-round convergence and the steering chain, and OpenInference
conversion.

```ts
import { llmSpan, loopSpan, steeredBy, toolSpan } from '@tangle-network/agent-trace-contract'

// One round of a loop, the model call and tool call inside it, then the next
// round — linked to the verdict that CAUSED it, not parented to it.
const round1 = loopSpan({ traceId, spanId: 'round-1', parentSpanId: null, name: 'round 1',
  loopId: 'fix-loop', iteration: 1, startTime, endTime })
const call = llmSpan({ traceId, spanId: 'llm-1', parentSpanId: 'round-1', name: 'coder turn',
  model: 'glm-5.2', inputTokens: 1200, outputTokens: 340, costUsd: 0.0042, startTime, endTime })
const tool = toolSpan({ traceId, spanId: 'tool-1', parentSpanId: 'round-1', name: 'bash',
  toolName: 'bash', startTime, endTime })
const round2 = loopSpan({ traceId, spanId: 'round-2', parentSpanId: null, name: 'round 2',
  loopId: 'fix-loop', iteration: 2, resumed: true, startTime, endTime,
  links: [steeredBy('llm-1', traceId)] })
```

Write one span per line to a `.jsonl` file, then:

```bash
traces validate spans.otlp.jsonl        # exit 1 only when the file is not a trace
traces analyze spans.otlp.jsonl        # a directory reads the OTLP files under it
```

A directory is a run directory, not a span directory: it holds the span export
next to raw event, stream and SDK logs that are also `*.jsonl`. Only the OTLP
files are read — every other JSONL is listed in the report with what it actually
holds, rather than counted as several hundred broken spans. Put the exports in an
`otlp/` subdirectory and that decides it outright.

`traces convert <ref> --out <file>` writes the spans as contract OTLP-JSONL, and `traces upload <ref> --dry-run --out <file>` writes the redacted preview.

`parent_span_id` is CONTAINMENT — this span happened inside that one. `links` is
CAUSALITY — that verdict caused this retry. Encoding causality as a parent claims
a nesting that never existed, so the two edges stay separate and both survive a
round-trip through `traces`.

## What a trace cannot tell you, said out loud

`validate` reports the conformance of any OTLP file, conforming or not — it never
throws on a foreign trace, it reports it:

- **findings** by severity, each naming the *consequence* of the defect and the capabilities it blocks
- **the capability table** — `token-accounting`, `cost-attribution`, `tool-usage`, `loop-convergence`, `tree-comparison`, `steering-chain`, `latency-analysis` — available or not, with the trace's own reason
- **span structure** — how much of the tree actually attaches, and how many rows could not be read at all

Exit code is 1 on exactly one condition: not one entry could be read as a span,
so the file is not a trace. Severity says what a finding claims about the INPUT,
not how loud it is — `error` is "nothing readable", `warn` is "readable but
degraded", `info` is "nothing measurable lost" — so a `warn` exits 0 and the
capability table, not the exit code, says what the degradation cost.

### A re-export never validates cleaner than its source

`traces convert <ref> --out <file>` writes the spans that were read. Anywhere this package
normalized a field to analyse it — an `end_time` that precedes its `start_time`,
a status code the contract does not recognise — the export writes what the
PRODUCER wrote and keeps the normalized value in an attribute beside it, so
`negative-duration` and `invalid-status` are still findings against the copy.

A row that never became a span is the one thing that cannot be re-emitted: the
artifact is also the file the analysts read, so a non-span line in it is garbage
fed to the analysis and a repaired one is invented work. The export refuses the
equivalence instead — it carries `traces.source.unreadable_rows` and the kinds
behind it, accumulating across every hop, and `validate` on a re-export leads
with how much of the original is missing from it. Round-tripping a defective
trace through `traces` cannot produce a clean bill of health.

`analyze` prints the same section, plus an **analyses skipped, and why** list —
and, crucially, carries that verdict INTO the report. A section whose inputs are
incomplete says so in its own heading and again directly above its table, so a
number and the reason it is wrong can never end up forty lines apart. When the
trace supports `tree-comparison`, the table names the command that compares its
arms: `traces diff <file>#branch=<a> <file>#branch=<b>`.

Two of those analyses are why the loop shape exists at all:

- **round-over-round convergence** — per `agent.loop.id`, the per-round outcome
  and score series, and whether it improved, plateaued, regressed, or peaked and
  fell back. The verdict is read from the round's own `agent.outcome` or from the
  shallowest EVALUATOR span under it.
- **steering chain** — follows `links` (`agent.link.kind`) to report which verdict
  caused which subsequent round. A link whose target is missing is kept and marked,
  because a shorter chain than the producer recorded is the opposite of the truth.

Parent and verdict lookups use both trace and span IDs.
Steering edges retain `causeTraceId` and `effectTraceId`, including unresolved targets.
Generic chat transcripts report unknown execution status because message text does not establish completion.

Nothing is repaired on the way in. A span with an unreadable timestamp is
reported and excluded, because a synthesized value would put invented work into a
total.
