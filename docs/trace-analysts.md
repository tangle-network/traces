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

# Limit a resumed Claude Code session to its latest task and subagents.
traces analyze --harness claude-code --session <path> --latest-turn

# Write reusable findings, evidence, report, and OpenInference spans.
traces improve --harness codex --last 5 --dir .traces/improvement

# Add the built-in model-assisted analysts with a spending limit.
traces analyze --harness codex --last 5 --llm --budget 0.50
```

Without `--workflow`, each selected Codex file is analyzed independently.
With it, `traces` follows stable parent and child session IDs, up to 100 files by default.
`--latest-turn` keeps a long-lived resumed Codex or Claude Code session scoped to its most recent task and the workers spawned from that task.
For Codex, when the selected session is a child, `traces` finds the last parent task that structurally spawned or targeted that stable child ID and reads only that task.
The Codex parent log must carry both the child ID and a stable turn ID on the relevant spawn, send, follow-up, or lifecycle event.
Without those fields, the result is explicitly incomplete; names, nicknames, and timestamps are never used as substitutes.
It reports missing files, duplicate IDs, contradictory parents, and cycles instead of guessing.
Use `--max-workflow-sessions <n>` to set a different bound.
Claude Code already folds nested subagent files into its parent trace.
Ordinary Claude subagents use their parent tool call ID.
Claude Workflow subagents use the run ID and transcript directory returned by the parent `Workflow` call.
If the same Workflow run is resumed, each child attaches to the latest matching call that started before it.
The selected task includes only children attached to its calls.
Returned directories from another resumed Claude session are parsed and included in source hashes.

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

The current fixture returns one finding.
Its stable fields are:

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
| CodeTraceBench | Incorrect and unhelpful action steps; solved label-empty rows are clean controls |

Use `runAnalystBenchmark` to report recall, precision, F1, root-step accuracy, citation coverage, citation validity, clean-case false positives, repeat agreement, latency, calls, tokens, and known cost.
Use `compareAnalystRunners` for paired baseline and candidate comparisons.
Failed label-empty CodeTraceBench rows are unlabeled, not clean controls.

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

## Verified findings (executed replay)

An analyst finding is a cited claim until something executes it.
`traces analyze --verify-findings` (and the standalone `traces verify-findings`) replays each finding's trajectory prefix in a real sandbox, re-runs the accused step, and annotates every finding with an executed verdict:

| Verdict | Meaning |
|---|---|
| `reproduced` | the recorded failure signature (returncode + stable output substring) reproduced when the accused step re-ran |
| `fix-flipped` | reproduced, and a supplied corrected command made the failure vanish in a fresh replay |
| `divergent` | the step executed but the recorded failure did not reproduce — evidence against the finding, or against replay fidelity (the receipt carries prefix divergences so you can tell which) |
| `not-replayable` | the finding could not be executed; the receipt names the precise reason (no step subject, unknown trajectory, no docker image, submit step, …) |

```bash
# Verify the findings an analyze run produced (marks each finding in the report):
traces analyze --last 1 --llm --verify-findings \
  --replay-corpus holdout=labels.json::prepared/ --verify-out ./receipts

# Verify findings recorded earlier (e.g. extracted from an eval result.json):
traces verify-findings --findings findings.json --out ./receipts \
  --steps normalized/<traj>/steps.json --image <replay-ready-image> --cwd /app
```

Findings are matched by the shape analysts emit: subject `incorrect-step-<n>` (or the wire form `incorrect-steps-<f>-<l>-…`), `metadata.block_first_step`, and `trace://<trajectory>/…` evidence refs.
Findings accusing the same step share one executed proof; each finding still gets its own receipt directory (`receipt.json` plus, when executed, `replay-verdict.json` and `report.md` with real stdout/stderr).
Verification is execution, not generation: no LLM is involved unless you pass `--fix-command`.
A missing sandbox is an error when any finding is replayable — verification never silently skips.
Sandbox setup, execution semantics, and honest limits are in [Replay verification](./replay-verify.md).

## Turn findings into improvement

Do not train or rewrite policy from an analyst's own prose alone.
Attach independent feedback or a measured task outcome to the trace first.
Then promote the reviewed failure into an eval case, make one targeted change, and compare before and after on fresh cases.

The required review path is:

```text
production trace -> finding -> reviewed feedback -> eval case -> candidate change -> comparison
```
