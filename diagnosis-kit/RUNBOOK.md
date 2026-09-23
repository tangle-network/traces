# Engagement runbook

Five working days, from the day usable traces arrive. Every command below was run
against this repository. Where a step is not yet proven end to end, it says so.

The `traces` binary is only on PATH when the package is installed. From a checkout,
substitute `./node_modules/.bin/tsx src/cli.ts` for `traces` in every command.

---

## Day 0 — before any data moves

Send `intake.md`. Do not accept traces until section 4 comes back signed, because
that section is what decides whether content may be read at all.

Read the answer to "name the number that would have to move". If it is blank, the
engagement can still run, but say in the kickoff that you will propose the number
and that the before-and-after will be weaker for it.

## Day 1 — take delivery and find out what the trace can answer

Ask for OTLP JSONL. If the customer runs one of the adapters, their own store works
instead. If they emit something else, `--format` reads policy-evidence,
sandbox-events, openinference, intelligence-spans and chat-trajectory.

```bash
traces validate customer/spans.otlp.jsonl
```

`validate` never throws on a foreign trace. It reports conformance, then a capability
table: token-accounting, cost-attribution, tool-usage, loop-convergence,
tree-comparison, steering-chain, latency-analysis, each available or not with the
trace's own reason.

**That table is the first thing you send the customer, on day 1, before any analysis.**
It tells them what their instrumentation can and cannot support. Half the value of the
engagement is often here, and delivering it early makes the rest credible. If four of
seven capabilities are unavailable, say so that day rather than at the end.

## Day 1 — enforce the data boundary

`--no-content` is an **upload** flag. It does not gate local analysis, and this kit
never uploads customer traces anywhere, so it is not the control you need.

Strip content on receipt instead, before anything reads the spans:

```ts
import { readOtlpInput, redactSpans, TRACES_REDACTION_RULES } from '@tangle-network/traces'
import { stripContent } from './checks/metadata-only.js'

const spans = await readOtlpInput('customer/spans.otlp.jsonl')
const { spans: metadataOnly, dropped } = stripContent(spans.spans)
const { spans: scrubbed, report } = redactSpans(metadataOnly, TRACES_REDACTION_RULES)
// Report dropped, report.redactionCount and report.byRule in the appendix.
```

Under the metadata-only default, `stripContent` drops every content key recognized by the shared diagnosis filter.
It also drops tool argument aliases, structured attribute values, tool I/O digests, lengths, MIME types, provenance, `tool.args_captured`, and free-form error and status messages.
The kit's `run-checks.ts` uses this same helper before redaction or analysis.
It reports argument-based stuck-loop and follow-up comparisons as skipped when arguments were removed, instead of treating distinct calls as identical.
Without content opt-in, failure follow-ups still count, but whether the agent adapted its arguments remains unknown.

If the customer opted into content, keep the values, run `redactSpans`, and then compose
`applyRedactor()` with an external PII redactor on top. The doc comment on `src/redact.ts`
is explicit that regex alone does not catch names, addresses or account numbers in prose.

## Day 2 — the deterministic pass

```bash
traces analyze --otlp customer/scrubbed.otlp.jsonl --out work/analysis.md
```

Costs nothing and calls no model. It produces the conformance table, the capability
matrix, an explicit "analyses skipped and why" section, execution facts, token usage and
cost coverage. Read "skipped and why" first; it is the honest boundary of the diagnosis.

For the reviewable artifact pack, with `result.json`, `evidence.jsonl`, `report.md` and
the OTLP trace beside them:

```bash
traces improve --otlp customer/scrubbed.otlp.jsonl --dir work/improvement
```

## Day 3 — the measurable check

This is the part the customer re-runs themselves, and the reason the report is worth
paying for. `fromOtelSpans` turns spans into runs; `analyzeRuns` scores them.

```ts
import { analyzeRuns, fromOtelSpans } from '@tangle-network/agent-eval/contract'

const runs = fromOtelSpans({ spans: scrubbed })
const report = await analyzeRuns({ runs })
// report.n, report.composite.mean, report.cost.mean, report.recommendations
```

`checks/` holds the set to start from. Add one check per symptom the customer named in
intake section 2, so every complaint has a number attached to it.

For a repeat engagement, record to a scorecard and diff it. `diffScorecard` runs a Welch
t-test and returns `improved | regressed | flat | new`, which is what "no regressions"
has to mean if the claim is going to survive the customer checking it.

## Day 3 — the model pass, if the customer allowed it

Skip this entirely when intake section 4 came back as deterministic-only. Everything
above and below still runs; what the customer loses is model-written findings, not the
measurement.

Run it through `trace-mine`, not through the library. The CLI is what carries retention
and expiry, and its isolation test proves a customer run cannot reach an internal sink,
call GitHub, or send secrets to the model. Those properties are the engagement's safety
story and they do not exist if you call the function directly.

```bash
trace-mine engagement --id <id> --label "<customer words>" --days 30   # creates ~/diagnosis/engagements/<id>/
cp customer/scrubbed.otlp.jsonl ~/diagnosis/engagements/<id>/bundle/
trace-mine diagnose --id <id>
```

It reads only `~/diagnosis/engagements/<id>/bundle/*.jsonl`, accepting flat spans or OTLP,
and writes only `report/findings.json` and `report/diagnosis.json`. The findings document
validates against `templates/findings.schema.json`.

For a customer who refused third-party model processing in intake section 4:

```bash
trace-mine engagement --id <id> --label "<customer words>" --days 30 --no-third-party
cp customer/scrubbed.otlp.jsonl ~/diagnosis/engagements/<id>/bundle/
trace-mine diagnose --id <id>
```

That runs deterministic mode and makes no model call at all.

Expiry is not optional. Every engagement carries `expiresAt`, a purge runs at 05:30, and
`retain: true` is set only on the customer's written request. If you find yourself wanting
to skip the expiry, you are about to keep a customer's traces without their consent.

The library path, `diagnoseSpans` from `@tangle-network/agent-eval/diagnosis`, exists and
this repository pins a version that has it. Use it for building tooling, not for running
an engagement, because it gives you the engine without the retention and isolation that
make the engagement safe.

The engine populates `coverage.capabilities` from the trace's own validator rather than
from the model, marks every finding `observed` or `inferred`, sets `measure.denominator`
whenever there is a measure, and rejects evidence span ids that do not resolve instead of
guessing them. Those four properties are what make the report checkable, so if a future
version drops one, the report has to change with it.

Requires agent-eval 0.185.0 or later, which this repository now pins. Verified against
the published package on a real session: the document validates against
`templates/findings.schema.json`, all seven capabilities are reported, and `notes` comes
back empty for a customer subject as the contract requires.

A customer context carrying `topology` throws by design. That field is for internal
mining runs and passing it on a customer engagement is a bug, not a shortcut.

`model.usage` tokens of `null` mean unknown, not zero. Do not print a zero cost from a
null; say the cost was not reported.

## Day 4 — write the page

Fill `templates/report.md`. One page. The rules that matter:

- Answer the question from intake section 2 in the first five lines, before methodology.
- Second person throughout. "Your agent", not "the customer's agent".
- Every number carries the command that produced it, so they can reproduce it.
- What you could not see goes on page one, not in an appendix.
- End with the decision they have to make, not with a summary of findings.

Then read it back as the buyer and ask the five gate questions in
`~/company/gtm/personas/customer-facing-commercial-reviewer.md`. Ship only on five yeses.

## Day 5 — hand over and delete

Send the report, the checks, and the raw artifact pack. The checks are theirs to keep
and re-run; that is the deliverable that outlives the engagement.

Delete their traces unless they asked in writing for them to be kept. Confirm the
deletion in the handover mail, naming what was deleted.

---

## Known limits of this runbook

- The `--llm` agentic analyst path needs `TANGLE_API_KEY` and the Python
  `agent-eval-rpc[dspy]` extra. Unverified here. The deterministic pass needs neither
  and is what days 2 and 3 rely on.
- `traces improve` was read from source and docs, not executed, because it writes files.
  Run it once against a throwaway input before the first paid engagement.
- Casework has never run a campaign, so the worked example in `examples/casework/`
  documents the seam rather than a completed run. See its README.
