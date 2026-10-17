# Trace analysts

Use `traces` to answer three different questions.
Keeping them separate prevents an exploratory model output from being reported as a confirmed defect.

| Question | Tool | Output |
| --- | --- | --- |
| What happened? | Built-in local checks | Findings from explicit trace facts |
| Why might it have happened? | `traces ask`, or your own analyst through `analyzeSpans({ registry })` | Findings with cited spans |
| What exactly does this session say about X? | `traces ask` | An answer per question, with checked `trace://` citations |
| What does this session state, exactly and for free? | `traces facts` | A deterministic facts sheet, no model call |

## Start here

```bash
# Free local checks over the active Codex coordinator and connected workers.
traces analyze --harness codex --current --latest-turn

# Limit a resumed Claude Code session to its latest task and subagents.
traces analyze <path> --harness claude-code --latest-turn

# Keep the report and the finding packet as files.
traces analyze --harness codex --last 5 --out analysis

# A question that needs judgment: the one command that calls a model, with a spending limit.
traces ask --harness codex --last 5 --question "Why did the first check fail?" --budget 0.50
```

Which sessions these commands select, how a named session brings its spawned children, and how `--latest-turn` narrows it, is in [Choose sessions](./harnesses.md#choose-sessions).

`traces analyze <ref> --out DIR` writes exactly `report.md` and `findings.json`; see [Analyze a session](./analyze.md).
`traces convert <ref> --out <file>` writes the OpenInference spans any other tool can read.

## Ask free-form questions

`traces ask` asks your own questions instead of the built-in kinds. See [Ask questions](./ask.md).

## Session facts

`traces facts` computes the deterministic facts sheet, and `traces ask` hands it to the model as prepared context. See [Session facts](./facts.md).

## Evidence-gate rejections

A model-backed analyst can submit a finding the evidence gate then refuses.
Without the reason, a report showing "0 findings" reads as "the model found nothing" when the truth may be "the gate refused everything it found".

`ask` carries those refusals:

- the CLI log adds whatever the event carries beyond its own text to each `finding rejected` line: the cause (`reason` for the gate's rejections and the bridge-row rejection, `issues` for a schema failure), the offending URI, the citation counts, and the subject;
- `answers.json` holds the counts per question and reason.

The common reasons are an excerpt the cited span does not contain, a span the trace does not hold, and too few distinct citations for the kind.

## Codex tool outcomes

Both function and custom tool outputs use the same status parser.
Explicit exit codes, error flags, and runner headers determine tool status.
Explicit failure takes precedence when structured fields conflict.
Text such as `error:`, `ENOENT`, or `command failed` inside stdout does not determine status.
An unmatched call, running process, or output without trustworthy status remains `UNSET`.
A recorded `wait_agent` timeout is a completed poll, not proof that the agent finished.
Tool output remains in `output.value`, with the existing size limit and truncation receipt.

Error and retry counts use explicit failures.
Successful follow-up counts require explicit success; unknown follow-up outcomes remain `null` in the detailed report.
The runtime span projection leaves its optional status absent for `UNSET` spans.
Use the execution report for terminal run outcomes.
The older runtime store's required run status cannot represent unknown and is not completion evidence.

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

Run it through the SDK, which builds the in-memory store and runs the registry over it:

```ts
import { analyzeSpans } from '@tangle-network/traces'
const { result } = await analyzeSpans(spans, { registry })
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

## Turn findings into improvement

Do not train or rewrite policy from an analyst's own prose alone.
Attach independent feedback or a measured task outcome to the trace first.
Then promote the reviewed failure into an eval case, make one targeted change, and compare before and after on fresh cases.

The required review path is:

```text
production trace -> finding -> reviewed feedback -> eval case -> candidate change -> comparison
```
