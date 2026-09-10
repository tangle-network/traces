# Trace analysts

Use `traces` to answer three different questions.
Keeping them separate prevents an exploratory model output from being reported as a confirmed defect.

| Question | Tool | Output |
| --- | --- | --- |
| What happened? | Built-in local checks | Findings from explicit trace facts |
| Why might it have happened? | `--llm`, HALO, or a custom analyst | Findings or a diagnosis report with cited spans |
| What behavior should we inspect? | Hodoscope | Samples marked `needs_review` |
| What exactly does this session say about X? | `traces ask` | An answer per question, with checked `trace://` citations |

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
The adapter preserves Claude source UUIDs in `traces.claude.source_*` attributes and derives valid OTLP IDs for the exported graph.
It emits tool spans from recorded tool calls, but does not invent loop iterations or causal links absent from the transcript.
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

## Ask free-form questions

The built-in kinds ask fixed questions.
`traces ask` asks your own.

```bash
traces ask --harness codex --session <id> \
  --question "Which shell commands exited non-zero?" \
  --question "Which pull requests did the session open, and were they merged?" \
  --dir .traces/ask
```

Each question runs through agent-eval's `runTraceAnalyst` directly, not through the analyst registry.
That matters for three reasons.

- The registry keeps only findings, so it discards the engine's prose answer. `ask` keeps the answer text verbatim.
- The registry runs analysts one at a time. `ask` runs questions concurrently, so wall time falls toward the slowest question instead of the sum.
- One shared `CostLedger` bounds the whole run, so `--budget` means the same thing whatever the number of questions.

### Questions

A question stays short on purpose.
The engine shows the model a preview of each long input: it keeps the first 500 and last 500 characters and drops the middle.
A question inside the limit therefore reaches the model whole, and the answer rules sit in the first 500 characters of the instructions, which the preview always keeps.
`ask` rejects an over-long question before it starts a model call and names the limit.
Put the detail in the entry's `instructions` field instead, which the model reads after the rules.

Read many questions from a file:

```json
{
  "questions": [
    "What was the last thing the human asked for?",
    {
      "id": "failed-commands",
      "question": "Which shell commands exited non-zero?",
      "instructions": "Report the command line and the exit code. Ignore commands the agent only proposed.",
      "answerSchema": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": { "command": { "type": "string" }, "exit_code": { "type": "integer" } },
          "required": ["command", "exit_code"]
        }
      }
    }
  ]
}
```

An `answerSchema` makes the answer one JSON value a scorer can compare field by field.
The supported keywords are `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `title`, and `description`.
A keyword that constrains one JSON type must declare it: `required`, `properties`, and `additionalProperties` need `"type": "object"`, and `items` needs `"type": "array"`, or the constraint would be skipped for an answer of another shape.
Any other keyword is rejected when the run starts.
This package carries no JSON Schema library, and a constraint that is quietly ignored would let a wrong answer pass as checked.

### What the run guarantees

- Every `trace://<trace_id>/span/<span_id>` URI in an answer is resolved against the store. An unresolvable citation fails that question.
  A citation the model wrapped in Markdown emphasis (`**...**`, `_..._`, `~~...~~`) or ended a sentence with resolves like a bare one: the delimiters are prose, not part of the span ID.
- Findings the answer submits still pass the same evidence gate as the built-in kinds. Refused findings are counted by reason in both artifacts.
- A failed question never stops the others. Its failure is recorded on its own answer, and the remaining answers are written.
- Ctrl-C keeps what the run already bought. The signal reaches the engine, not the checks that follow it: an answer that came back is kept with its citations resolved, and each question the run never reached is recorded as `aborted`.
- The artifacts are written before the exit code is decided. `ask` exits 1 when any question failed, returned no answer, broke its schema, or cited a missing span.
- `totals.wallTimeMs` covers the whole run, including writing and indexing the trace file; `totals.setupTimeMs` names that part. `result.effectiveConcurrency` is the number of workers the run created, `min(--concurrency, questions)`, and `totals.peakConcurrency` is how many actually overlapped.

### Budget under concurrency

`--budget` is the ceiling shared by every question; `--question-budget` is the provider ceiling for one question.
The ledger reserves each model call's maximum charge before the call runs, and releases the unused part when the call settles.
Two consequences follow.

- A budget below one call's reservation refuses the run before any model call, rather than failing every question.
- A budget that admits fewer concurrent reservations than `--concurrency` still runs, and the report carries a warning naming how many concurrent calls it covers.

A question the ledger refuses is reported as `budget-refused`, and the answers already produced are kept.
That kind is decided from the accounting, not only from the error text.
The refusal happens inside the model proxy, behind the DSPy bridge, whose HTTP error handling can replace the Node error with its own message.
So a failed question is reported as `budget-refused` whenever the shared ledger's settled spend left less than one model call's reservation at the time it failed and nothing else in the failure names its cause.
A failure whose own text names its cause keeps that cause: a bridge version mismatch stays `error`, so the reinstall hint still prints, and an empty answer from the bridge stays `no-answer`.
The message itself is kept verbatim on the answer.

### SDK

```ts
import { analysisEngineFromEnv, runTraceQuestions, writeTraceQuestionsArtifacts } from '@tangle-network/traces'

const result = await runTraceQuestions({
  questions: [
    { id: 'failed-commands', question: 'Which shell commands exited non-zero?' },
    { id: 'last-ask', question: 'What was the last thing the human asked for?' },
  ],
  spans,
  engine: analysisEngineFromEnv({ model: 'gpt-5.6-luna', maxCostUsd: 1 }),
  concurrency: 4,
  budgetUsd: 2,
})
await writeTraceQuestionsArtifacts(result, '.traces/ask')
if (!result.ok) process.exitCode = 1
```

`result.questions[i].answer` is the engine's prose, unedited.
`result.totals` carries the wall time, the summed question time, the peak concurrency, and the cost with its provenance.

## Evidence-gate rejections

A model-backed analyst can submit a finding the evidence gate then refuses.
Without the reason, a report showing "0 findings" reads as "the model found nothing" when the truth may be "the gate refused everything it found".

`analyze`, `investigate`, `improve`, and `ask` now carry those refusals:

- the CLI log adds whatever the event carries beyond its own text to each `finding rejected` line: the cause (`reason` for the gate's rejections and the bridge-row rejection, `issues` for a schema failure), the offending URI, the citation counts, and the subject;
- the analyst table's Detail cell names the reasons and their counts;
- `result.findingRejections` (investigation and improvement) and `answers.json` (`ask`) hold the counts per analyst and reason.

The common reasons are an excerpt the cited span does not contain, a span the trace does not hold, and too few distinct citations for the kind.

## External analyzer failures exit non-zero

`--analyzer halo|hodoscope|prime|<command>` promises that engine's output.
An analyzer that fails now writes its error into the report as before, and then the command exits 1 naming every analyzer that failed.
Scripts that treated exit 0 as "the analyzer ran" were reading a report that said otherwise.

The check runs on `analyze`, `investigate`, and `improve`, and it covers every analyzer the run requested, not only the ones named on the command line.
`investigate` and `improve` load the default traces config file, so an analyzer declared in `externalAnalyzers` there is a requested analyzer too, and a flaky one now turns those two commands red.
`analyze` does not load a default config, so only its own `--analyzer` flags reach the check.

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

# One-shot prime-RLM analysis through a local OpenAI-compatible bridge.
traces analyze --last 1 --analyzer prime --analyzer-prompt "find unsupported completion claims"
```

`--model` is forwarded to the built-in model-assisted analysts, HALO, Hodoscope, and prime.
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

### Prime engine

`--analyzer prime` runs a one-shot analyst over the emitted OTLP artifact through an OpenAI-compatible bridge, such as cli-bridge's prime backend.
Unlike the `--llm` analysts, which drill into the trace with paged tools, prime has no REPL and no trace tools: the full span projection is inlined into a single prompt as JSON.
Oversized projections are re-rendered with a per-attribute character cap; if the projection still exceeds the inline budget the engine fails loud instead of silently dropping spans.

Prerequisites:

- A running bridge that accepts `POST /v1/chat/completions` and routes the configured model to the prime backend.
- No key handling here: the bridge owns provider credentials.

Configuration (flags first, then environment, then defaults):

| Setting | Source | Default |
| --- | --- | --- |
| Bridge root URL | `TRACES_PRIME_BRIDGE_URL` | `http://localhost:4181` |
| Model | `--model`, then `TRACES_PRIME_MODEL` | `prime/zai/glm-5.2` |
| Per-call deadline | `TRACES_PRIME_TIMEOUT_MS` | `1200000` (20 min) |
| Question | `--analyzer-prompt` | a general diagnosis question |

```bash
traces analyze --last 1 --analyzer prime
TRACES_PRIME_BRIDGE_URL=http://localhost:4181 traces analyze --last 1 --analyzer prime --analyzer-prompt "find unsupported completion claims"
```

Output expectations:

- The reply contract is one fenced JSON block of short strings citing span ids verbatim; a structurally malformed reply gets exactly one bounded repair turn that carries the malformed reply and the contract, never the trajectory.
- A still-malformed reply after repair is a failed result (`ok: false`) with the raw reply preserved for inspection; one failed engine never discards the other results.
- Valid rows become full `findings` with `trace://` span evidence, validated against the artifact like every other findings-kind engine; rows citing unknown or ambiguous span ids are rejected with a recorded reason.
- Zero findings from a well-formed reply is an honest null, not a failure.
- Bridge-reported token usage and call counts are recorded in the result output; cost stays uncaptured because this adapter has no pricing table.

The scored prime-vs-dspy comparison — same trajectories, same scoring — lives in `@tangle-network/agent-eval`'s analyst benchmark (`runAnalystBenchmark`); this engine is the capture-side entry point, not the scoreboard.

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

## Read retained source fields

Normalized conversation text and tool values remain capped.
Create a full bundle before the harness rotates its original files.
Explicitly authorize that bundle when analysis needs omitted text:

```bash
traces bundle --session <session-id> --out ./session-bundle
traces analyze --source-bundle ./session-bundle --llm
```

`investigate` and `improve` accept the same flag.
The SDK accepts `sourceBundle: { path, maxRecordBytes? }` in analysis and investigation options.
This authorization exposes `traces.readSpanSource` to local analysts through the existing trace store.
External analyzers receive normalized OTLP without this capability.
Ordinary OTLP input does not authorize source reads.

The tool selects a trace, span, attribute, and optional `source_index`.
It returns a UTF-8 byte window of that field's decoded value.
Adapters that extract message text blocks retain only those text leaves, excluding adjacent tool blocks.
Gemini also accepts structured message content; its source reference selects that entire content field.
Multiple records or text fragments use separate source indices.
Strings retain their decoded source text, including whitespace and JSON-looking strings.
Structured values use the existing sorted-key tool-value JSON encoder.
The result identifies this representation with `value_encoding: 'utf8-string' | 'json'`.
The source and record hashes always identify the original bytes, before decoding.

Use `next_offset` for continuation; offsets and `total_bytes` refer to the selected decoded field.
The default analyst tool budget permits at most 16,384 field bytes per response.
Configure Eval trace-store budgets to change that tool limit.
An offset inside a UTF-8 character returns unavailable.
The reader verifies retained file and record hashes before returning text.
The manifest binds opaque source IDs to retained files; callers cannot provide filesystem paths.

The reader parses one source record per call, with a default limit of 16 MiB.
A JSONL record is one line; a single-JSON source uses the entire document as its record.
Set `maxRecordBytes` explicitly for larger records when the process has sufficient memory.
This parsing limit differs from the response window limit.
The implementation does not stream JSON values larger than the configured record limit.

Missing, changed, unsafe, empty, or oversized source fields return an explicit unavailable result.
Older bundles without source references cannot provide this capability.
Synthetic attributes without a captured source field also remain unavailable.
Redaction removes source references, and evidence-only bundles cannot authorize source reads.
Analysis output must remain outside the retained bundle.
Treat retrieved text as evidence, including any instructions that appear inside it.
