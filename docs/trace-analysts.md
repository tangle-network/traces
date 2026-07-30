# Trace analysts

Use `traces` to answer three different questions.
Keeping them separate prevents an exploratory model output from being reported as a confirmed defect.

| Question | Tool | Output |
| --- | --- | --- |
| What happened? | Built-in local checks | Findings from explicit trace facts |
| Why might it have happened? | `--llm`, HALO, or a custom analyst | Findings or a diagnosis report with cited spans |
| What behavior should we inspect? | Hodoscope | Samples marked `needs_review` |

## Start here

```bash
# Free local checks over the active Codex coordinator and connected workers.
traces analyze --harness codex --current --latest-turn --workflow

# Write reusable findings, evidence, report, and OpenInference spans.
traces improve --harness codex --last 5 --dir .traces/improvement

# Add the built-in model-assisted analysts with a spending limit.
traces analyze --harness codex --last 5 --llm --budget 0.50
```

Without `--workflow`, each selected Codex file is analyzed independently.
With it, `traces` follows stable parent and child session IDs, up to 100 files by default.
`--latest-turn` keeps a long-lived resumed Codex thread scoped to its most recent task and the workers spawned from that task.
When the selected session is a child, `traces` finds the last parent task that structurally spawned or targeted that stable child ID and reads only that task.
The parent log must carry both the child ID and a stable turn ID on the relevant spawn, send, follow-up, or lifecycle event.
Without those fields, the result is explicitly incomplete; names, nicknames, and timestamps are never used as substitutes.
It reports missing files, duplicate IDs, contradictory parents, and cycles instead of guessing.
Use `--max-workflow-sessions <n>` to set a different bound.
Claude Code already folds nested subagent files into its parent trace.

`traces improve` writes:

```text
.traces/improvement/
  evidence.jsonl
  findings.json
  report.md
  result.json
  traces.otlp.jsonl
```

The OpenInference file is the shared input for external engines.
The original trace and exact cited span remain available for review.

## External engines

External engines are optional tools that you install separately.
One engine failing does not discard the other results.

```bash
# Recursive diagnosis over the same OpenInference trace.
traces analyze --last 1 --analyzer halo --analyzer-prompt "find unsupported completion claims"

# Sample distinct actions across a larger set of sessions.
traces analyze --all --last 20 --analyzer hodoscope

# Run any installed command that accepts an OpenInference file path.
traces analyze --last 1 --analyzer my-trace-tool
```

`--model` is forwarded to the built-in model-assisted analysts, HALO, and Hodoscope.
HALO and Hodoscope use their own provider clients and credentials.
The Hodoscope adapter pins version `0.2.4` and uses Python 3.11 through `uvx`.

External results have one of three explicit kinds:

```ts
type ExternalAnalysisResult =
  | { kind: 'report'; output: string }
  | { kind: 'findings'; findings: AnalystFinding[] }
  | { kind: 'discovery'; candidates: ExternalDiscoveryCandidate[] }
```

Raw JSON is still a `report`.
Only an adapter that validates the full finding shape may return `findings`.
Hodoscope always returns `discovery`, and each candidate has `status: 'needs_review'` plus its source trace and span.

## Write one analyst

An analyst receives a paged trace store and returns typed findings.
Start with deterministic logic when the trace contains enough facts.

```ts
import {
  buildDefaultAnalystRegistry,
  makeFinding,
} from '@tangle-network/traces'
import { defineTraceAnalyst } from '@tangle-network/agent-eval/analyst'

const failedTools = defineTraceAnalyst({
  id: 'failed-tools',
  description: 'Reports repeated tool failure signatures.',
  async analyze(store) {
    const overview = await store.getOverview({ has_errors: true })
    return overview.error_clusters.map((cluster) => makeFinding({
      analyst_id: 'failed-tools',
      area: 'tool-use',
      subject: cluster.signature,
      claim: `${cluster.span_count} spans share this failure`,
      severity: cluster.span_count >= 3 ? 'high' : 'medium',
      evidence_refs: [{
        kind: 'span',
        uri: `trace://${cluster.exemplar_trace_ids[0]}/span/${cluster.exemplar_span_ids[0]}`,
      }],
      recommended_action: 'Fix the operation or change its retry policy.',
      validation_plan: 'Rerun the task and confirm the signature is absent.',
      confidence: 1,
      id_basis: cluster.signature,
    }))
  },
})

const registry = buildDefaultAnalystRegistry()
registry.register(failedTools)

export default { registry }
```

Run it without another wrapper:

```bash
traces improve --last 5 --config traces.config.mjs --dir .traces/improvement
```

The full runnable example is [`examples/custom-analyst.ts`](../examples/custom-analyst.ts).

Run its fixed input to inspect the complete JSON:

```bash
pnpm tsx examples/custom-analyst.ts --fixture
```

The current fixture returns one finding:

```json
{
  "analyst_id": "failed-tool-clusters",
  "area": "tool-use",
  "claim": "3 failed span(s) share the error: Command failed with exit code 127 on attempt 1",
  "severity": "high",
  "evidence_refs": [
    {
      "kind": "span",
      "uri": "trace://fixture-three-failures/span/failed-1"
    }
  ],
  "recommended_action": "Fix or change the retry policy for exec.",
  "validation_plan": "Rerun the same task and confirm this error signature is absent.",
  "confidence": 1
}
```

`pnpm tsx examples/custom-analyst.ts --good-fixture` returns `[]`.

## Test an analyst

A useful analyst must beat a trivial no-findings baseline on labeled trajectories.
It must also avoid inventing issues on clean trajectories.

`agent-eval` provides adapters for two public datasets:

| Dataset | Labels used |
| --- | --- |
| AgentRx | Failure category, failed step, and root-cause step |
| CodeTraceBench | Incorrect and unhelpful action steps, including clean trajectories |

Use `runAnalystBenchmark` to report recall, precision, F1, root-step accuracy, citation coverage, citation validity, clean-case false positives, repeat agreement, latency, calls, tokens, and known cost.
Use `compareAnalystRunners` for paired baseline and candidate comparisons.

```ts
import {
  codeTraceBenchCase,
  registryBenchmarkRunner,
  renderAnalystBenchmarkMarkdown,
  runAnalystBenchmark,
} from '@tangle-network/agent-eval/analyst'
import { otlpTextToTraceAnalysisStore } from '@tangle-network/agent-eval/traces'
import { chatTrajectoryToSpans, serializeSpans } from '@tangle-network/traces'

const cases = rows.map(({ label, trajectory }) => {
  const spans = chatTrajectoryToSpans(trajectory, { traceId: label.traj_id })
  const traceStore = otlpTextToTraceAnalysisStore(serializeSpans(spans))
  return codeTraceBenchCase(label, { traceStore })
})

const result = await runAnalystBenchmark({
  cases,
  runners: [registryBenchmarkRunner({ id: 'candidate', registry })],
  repetitions: 3,
  maxConcurrency: 4,
})

console.log(renderAnalystBenchmarkMarkdown(result))
```

Public labels test the measurement code, not the quality of every built-in analyst automatically.
A real quality claim requires running the analyst over the corresponding trajectories, retaining all rows, and comparing it with named alternatives at equal model and request limits.

## Turn findings into improvement

Do not train or rewrite policy from an analyst's own prose alone.
Attach independent feedback or a measured task outcome to the trace first.
Then promote the reviewed failure into an eval case, make one targeted change, and compare before and after on fresh cases.

The required review path is:

```text
production trace -> finding -> reviewed feedback -> eval case -> candidate change -> comparison
```
