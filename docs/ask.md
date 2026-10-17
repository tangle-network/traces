# Ask questions

[traces](../README.md#docs) › Ask questions

`traces ask` answers free-form questions about the selected sessions.
Each question becomes its own recursive investigation over the same trace, and the questions run at the same time under one budget.

```bash
traces ask <id> \
  --question "Which shell commands exited non-zero, and what were they?" \
  --question "What was the last thing the human asked for?" \
  --budget 1 --out .traces/ask
```

`--budget` is required: it is the most the run may spend.
Each question spends at most the smaller of `--budget` and $2 within 1,800 s, and 4 questions run at once.
Those are Discovery's values, and they are code defaults, not flags.

Ask many questions from a file, and hold an answer to a shape a scorer can compare.
The file is a JSON array of entries, or an object with a `questions` array:

```bash
traces ask --last 3 --questions questions.json --budget 2 --out .traces/ask
```

```json
[
  "Which pull requests did this session open?",
  {
    "id": "merged-prs",
    "question": "Which pull requests were merged?",
    "instructions": "Count only merges the trace records, not merges the agent said it would do.",
    "answerSchema": { "type": "array", "items": { "type": "integer" } }
  }
]
```

An entry is a question string, or an object with `question` and an optional `id`, `instructions`, and `answerSchema`.

An `answerSchema` makes the answer one JSON value a scorer can compare field by field.
The supported keywords are `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `title`, and `description`.
A keyword that constrains one JSON type must declare it: `required`, `properties`, and `additionalProperties` need `"type": "object"`, and `items` needs `"type": "array"`, or the constraint would be skipped for an answer of another shape.
Any other keyword is rejected when the run starts.
This package carries no JSON Schema library, and a constraint that is quietly ignored would let a wrong answer pass as checked.

## Keep questions short

A question stays short on purpose.
The engine shows the model a preview of each long input: it keeps the first 500 and last 500 characters and drops the middle.
A question inside the limit therefore reaches the model whole, and the answer rules sit in the first 500 characters of the instructions, which the preview always keeps.
`ask` rejects an over-long question before it starts a model call and names the limit.
Put the detail in the entry's `instructions` field instead, which the model reads after the rules.

## What it writes

With `--out DIR`, the command writes two artifacts there, and stdout gets one summary line.
Without it, the report goes to stdout, or with `--format json` every answer as one JSON object:

| File | Contents |
|---|---|
| `answers.json` | per question: the answer text, the parsed answer, every citation with whether it resolves, accepted findings, evidence-gate rejections by reason, model calls, tool calls, cost with provenance, and latency |
| `report.md` | the same run as readable Markdown: a summary line, a per-question table, then each answer with its citation and rejection notes |

## Why it does not use the analyst registry

Each question runs through agent-eval's `runTraceAnalyst` directly, not through the analyst registry.
That matters for three reasons.

- The registry keeps only findings, so it discards the engine's prose answer. `ask` keeps the answer text verbatim.
- The registry runs analysts one at a time. `ask` runs questions concurrently, so wall time falls toward the slowest question instead of the sum.
- One shared `CostLedger` bounds the whole run, so `--budget` means the same thing whatever the number of questions.

## What the run guarantees

- Every question receives the deterministic [session-facts sheet](facts.md) as prepared context, before its first model call. It costs nothing and answers the counting questions the bounded trace tools cannot.
- Every `trace://<trace_id>/span/<span_id>` URI in an answer is resolved against the store. An unresolvable citation fails that question.
  A citation the model wrapped in Markdown emphasis (`**...**`, `_..._`, `~~...~~`) or ended a sentence with resolves like a bare one: the delimiters are prose, not part of the span ID.
- Findings the answer submits still pass the same evidence gate as the built-in kinds. Refused findings are counted by reason in both artifacts.
- A failed question never stops the others. Its failure is recorded on its own answer, and the remaining answers are written.
- Ctrl-C keeps what the run already bought. The signal reaches the engine, not the checks that follow it: an answer that came back is kept with its citations resolved, and each question the run never reached is recorded as `aborted`.
- The artifacts are written before the exit code is decided. `ask` exits 2 with `code: partial` when any question failed, returned no answer, broke its schema, or cited a missing span; `answers.json` still holds every answer.
- `totals.wallTimeMs` covers the whole run, including writing and indexing the trace file; `totals.setupTimeMs` names that part. `result.effectiveConcurrency` is the number of workers the run created, `min(4, questions)`, and `totals.peakConcurrency` is how many actually overlapped.
- One question's investigation has 1,800 s. A question that runs out fails alone.

- **Cost.** Each cost carries its provenance: `observed` from a provider receipt, `estimated` from token counts, or `uncaptured`. An uncaptured cost stays null; it never becomes zero.

`ask` is the one command that calls a model: it needs `TANGLE_API_KEY` (or `OPENAI_API_KEY`, with `OPENAI_BASE_URL` for any other OpenAI-compatible endpoint) and the DSPy bridge.
With `uv` installed, nothing else: `ask` runs `uvx --from agent-eval-rpc[dspy]==<its agent-eval version> python -m agent_eval_rpc.dspy_rlm_bridge`.
`TRACES_PYTHON` instead names a Python that has that version of `agent-eval-rpc[dspy]` installed.
A missing key or bridge exits 2 with `code: setup` before any session is read, naming each one, and nothing is spent.

## When the model endpoint refuses

Every model call goes through the engine's model proxy to the endpoint, and the bridge sees any refusal as an HTTP 502 (`BadGatewayError`).
So `ask` sorts each refusal where it happens, by the endpoint's status and its error code:

| Refusal | What `ask` does |
|---|---|
| Busy, rate limited or briefly down: 408, 425, 429, 5xx (a billing outage, an upstream rate limit), or no connection | Retries that call, waiting 2 s, then twice as long each time up to 60 s, for 10 attempts (about 5 minutes) within the question's deadline. A refused call was not served, so the wait costs nothing. |
| The key: 401, 402, 403 | Stops every question at that call and exits 2 with `code: auth`. |
| The model: not in the key's allow-list, not found, no trusted price (a 503 that no retry clears), or a completion from a model other than the one asked for | Stops every question at that call and exits 2 with `code: model`. Pass the provider-qualified id the endpoint serves, such as `zai/glm-5.3`. |
| Anything else | Fails that question alone. |

A model `ask` has no price for exits 2 with `code: model` before any call, because the run could not bound its spend.

## Budget under concurrency

`--budget` is the ceiling shared by every question; each question's provider ceiling is the smaller of it and $2.
The ledger reserves each model call's maximum charge before the call runs, and releases the unused part when the call settles.
Two consequences follow.

- A budget below one call's reservation refuses the run before any model call, rather than failing every question.
- A budget that admits fewer concurrent reservations than the questions running at once still runs, and the report carries a warning naming how many concurrent calls it covers.

A question the ledger refuses is reported as `budget-refused`, and the answers already produced are kept.
That kind is decided from the accounting, not only from the error text.
The refusal happens inside the model proxy, behind the DSPy bridge, whose HTTP error handling can replace the Node error with its own message.
So a failed question is reported as `budget-refused` whenever the shared ledger's settled spend left less than one model call's reservation at the time it failed and nothing else in the failure names its cause.
A failure whose own text names its cause keeps that cause: a bridge version mismatch stays `error`, so the reinstall hint still prints, and an empty answer from the bridge stays `no-answer`.
The message itself is kept verbatim on the answer.

## SDK

```ts
import { analysisEngineFromEnv, runTraceQuestions } from '@tangle-network/traces'

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
if (!result.ok) process.exitCode = 2
```

`result.questions[i].answer` is the engine's prose, unedited.
`result.totals` carries the wall time, the summed question time, the peak concurrency, and the cost with its provenance.
