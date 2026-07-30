---
name: build-trace-analyst
description: Write and calibrate a custom agent-eval trace analyst on real and labeled workflows.
---

# Build a trace analyst

Implement one measurable finding that existing analysts do not provide.

## Check coverage

1. Run maintained analysis on one positive and one clean case.
2. Call `buildDefaultAnalystRegistry().list()` for batch analysts.
Check live analysts separately only for `traces stream`.
3. Search source or public docs once for the target behavior, then decide.

Extend an existing analyst when it already emits the target with usable evidence.
Do not inspect bundled `dist` or `node_modules`.

## Implement

- Use `Analyst`, `AnalystRegistry`, `TraceAnalysisStore`, and `makeFinding` from `@tangle-network/traces`.
- Start with `getOverview`; narrow with `queryTraces`, `viewSpans`, or `searchTrace`.
- Pass `context.signal` through reads and model calls.
- Return stable `analyst_id`, `area`, `subject`, and `id_basis` values.
- Cite exact spans as `trace://<trace-id>/span/<span-id>`.
- Return no finding when evidence is absent.
- Use `cost.kind: 'deterministic'` only without model calls.
- For `cost.kind: 'llm'`, use the injected chat client, budget, cancellation, and usage recording.
- Extend `buildDefaultAnalystRegistry()` unless full replacement is intentional.

Use the [custom analyst](../../examples/custom-analyst.ts) and [config](../../examples/improvement-config.mjs) examples rather than adding a wrapper.

## Run

```bash
pnpm tsx examples/custom-analyst.ts --fixture
pnpm tsx examples/custom-analyst.ts --good-fixture
traces improve --harness codex --current --latest-turn --workflow \
  --config traces.config.mjs --dir .traces/custom-analyst
```

Inspect every finding and cited span.

## Calibrate

Use `runAnalystBenchmark` with `registryBenchmarkRunner` from `@tangle-network/agent-eval/analyst`.
Use AgentRx or CodeTraceBench labels when they match the finding.
Compare the candidate with a no-findings baseline and relevant maintained or external analysts on identical cases and limits.

Use at least 20 independent cases before comparative statistics.
Retain every case row and report recall, precision, F1, first-bad-step accuracy, citation coverage and validity, clean-case false positives, repeat agreement, failures, latency, calls, all token fields, and known or missing cost.

Do not claim quality from fixtures alone.
Require a fresh task comparison before using findings to change an agent or knowledge base.

## Then consider

- Use `inspect-agent-traces` to investigate a miss or false positive on its original workflow.
- Use `calibrate-before-measure` before trusting a new label set or scoring rule.
