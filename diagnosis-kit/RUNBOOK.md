# Engagement runbook

Five working days, from the day usable traces arrive. Every command below was run
against this repository. Where a step is not yet proven end to end, it says so.

The `traces` binary is only on PATH when the package is installed. From a checkout,
substitute `./node_modules/.bin/tsx src/cli.ts` for `traces` in every command.

---

## Day 0 — before any data moves

Send `intake.md`. Do not accept traces until section 4 comes back signed, because
that section is what decides whether content may be read at all.

For metadata-only intake, give the customer the merged `traces` repository URL and its exact commit.
The export script imports other repository files and needs its locked dependencies.
They run these commands on their own machine before transfer, or use an equivalent metadata-only exporter:

```bash
git clone https://github.com/tangle-network/traces.git
cd traces
git checkout <kit-commit>
corepack pnpm install --frozen-lockfile
./node_modules/.bin/tsx diagnosis-kit/checks/scrub-export.ts raw.otlp.jsonl metadata-only.otlp.jsonl
```

The raw file stays with the customer.
Ask them to inspect retained span and tool names for privileged prose before sending the exported file.
If they cannot make that inspection, pause receipt until they remove those names or agree a different data scope.

Read the answer to "name the number that would have to move". If it is blank, the
engagement can still run, but say in the kickoff that you will propose the number
and that the before-and-after will be weaker for it.

## Day 1 — take delivery and find out what the trace can answer

Ask for OTLP JSONL. The standard preparation command accepts that format.
Convert any other source format to OTLP before using this runbook, and keep the
conversion output inside the engagement.

Create the engagement before receiving any trace.
Use `--no-third-party` if intake section 4 selected deterministic-only.
Use an opaque ID and a nonsensitive label; the label stays in the local engagement record.

```bash
# Add --no-third-party only when intake section 4 selected deterministic-only.
trace-mine engagement --id <id> --label "Customer agent" --days 30
ENGAGEMENT_DIR="${TRACE_MINE_CUSTOMER_STORE:-$HOME/diagnosis}/engagements/<id>"
mkdir -m 700 "$ENGAGEMENT_DIR/incoming" "$ENGAGEMENT_DIR/work"
```

Arrange delivery of the customer's metadata-only export directly to `"$ENGAGEMENT_DIR/incoming/spans.otlp.jsonl"`.
Do not accept the raw export under metadata-only intake.
Do not stage another operator-side copy outside this engagement directory.
If the customer delivered a separate copy earlier, inventory and delete it at handoff.

```bash
traces validate "$ENGAGEMENT_DIR/incoming/spans.otlp.jsonl"
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

`--no-content` controls the `traces` upload command.
This kit does not use that command; the flag does not control `trace-mine` model processing.

Strip content into the engagement's bundle before analysis:

```bash
./node_modules/.bin/tsx diagnosis-kit/checks/prepare-bundle.ts "$ENGAGEMENT_DIR"
```

The command refuses an incoming file that still has content-bearing attributes or structured secrets.
Delete that file and request a new customer-side export if it refuses.
On success, it writes `bundle/spans.flat.jsonl` with mode 0600.
Record its span count, dropped attribute names and redaction counts in the appendix.
The raw incoming file remains inside the engagement until close deletes both.

Under the metadata-only default, `stripContent` drops every content key recognized by the shared diagnosis filter.
It also drops tool argument aliases, structured attribute values, tool I/O digests, lengths, MIME types, provenance, `tool.args_captured`, and free-form error and status messages.
The kit's `run-checks.ts` uses this same helper before redaction or analysis.
It reports argument-based stuck-loop and follow-up comparisons as skipped when arguments were removed, instead of treating distinct calls as identical.
Without content opt-in, failure follow-ups still count, but whether the agent adapted its arguments remains unknown.

This command refuses content opt-in.
For an opted-in engagement, run a separately approved content and PII redaction flow before analysis.
The redaction core alone does not catch names, addresses or account numbers in prose.

## Day 2 — the deterministic pass

```bash
traces analyze --otlp "$ENGAGEMENT_DIR/bundle/spans.flat.jsonl" --out "$ENGAGEMENT_DIR/work/analysis.md" --otlp-out "$ENGAGEMENT_DIR/work/analysis.otlp.jsonl"
```

Costs nothing and calls no model. It produces the conformance table, the capability
matrix, an explicit "analyses skipped and why" section, execution facts, token usage and
cost coverage. Read "skipped and why" first; it is the honest boundary of the diagnosis.

Keep every analysis artifact under `"$ENGAGEMENT_DIR/work"`.
The standard deterministic pass does not call `traces improve`, which can load a local
`traces.config.*` and invoke external analyzers.

## Day 3 — the measurable check

This is the check set the customer can re-run themselves.
Run it against the prepared bundle and keep its measured output with the report.

```bash
./node_modules/.bin/tsx diagnosis-kit/checks/run-checks.ts "$ENGAGEMENT_DIR/bundle/spans.flat.jsonl" > "$ENGAGEMENT_DIR/work/checks.json"
```

`checks/` holds the set to start from. Add one check per symptom the customer named in
intake section 2, so every complaint has a number attached to it.

For a repeat engagement, record to a scorecard and diff it. `diffScorecard` runs a Welch
t-test and returns `improved | regressed | flat | new`, which is what "no regressions"
has to mean if the claim is going to survive the customer checking it.

## Day 3 — the diagnosis pass

Run this pass for either intake choice.
An engagement created with `--no-third-party` runs the deterministic engine with zero model calls.
The other mode adds model-written findings.

Run it through `trace-mine`, which carries retention and expiry.
Its isolation test checks that the customer caller does not reach internal sinks or GitHub,
and that tested content and structured-secret values stay out of the model prompt.
Inspect retained metadata before third-party processing; span names can contain sensitive prose.

```bash
trace-mine diagnose --id <id>
```

It reads only `"$ENGAGEMENT_DIR/bundle"/*.jsonl`, accepting flat spans or OTLP,
and writes only `report/findings.json` and `report/diagnosis.json`. The findings document
validates against `templates/findings.schema.json`.
In metadata-only mode, the model receives a fixed label and no free-form intake focus.
Span names and other remaining metadata still need inspection for customer prose.

Expiry is not optional.
Every engagement carries `expiresAt`, and a purge runs at 05:30.
The 30-day expiry in the commands above is a fallback, not the handoff deletion date.
Close the engagement when you deliver its report.
Set `retain: true` only on the customer's written request.

The library path, `diagnoseSpans` from `@tangle-network/agent-eval/diagnosis`, exists and
this repository pins a version that has it. Use it for building tooling, not for running
an engagement, because it gives you the engine without the retention and isolation that
make the engagement safe.

The engine populates `coverage.capabilities` from the trace's own validator rather than
from the model, marks every finding `observed` or `inferred`, sets `measure.denominator`
whenever there is a measure, and rejects evidence span ids that do not resolve instead of
guessing them. Those four properties are what make the report checkable, so if a future
version drops one, the report has to change with it.

Requires agent-eval 0.185.0 or later; this repository now pins 0.186.2. Verified against
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

Send the report, the checks, and the sanitized artifact pack. The checks are theirs to keep
and re-run; that is the deliverable that outlives the engagement.

Delete the engagement unless the customer asked in writing to keep it:

```bash
trace-mine close --id <id> --dry-run
trace-mine close --id <id>
```

Confirm that the returned action is `deleted` and that its directory is absent.
The supported customer transport keeps its temporary model prompt under that directory,
so close also removes a prompt left by a killed model call.
Check for any operator-side trace copies created outside the engagement and delete them.
Finish every preparation, analysis and check process before close; none may still write into this engagement.
If close reports an operation lock, wait for the diagnosis to finish.
Close and purge automatically reclaim locks whose recorded owner process is provably gone.
If recovery still refuses, inspect the lock owner and process identity before retrying; do not remove an unverified active lock.
Name the deleted incoming trace, bundle, work files, report and temporary prompt in the handover mail.
Inspect `/tmp/trace-mine-prime-*` from any runs made before the engagement-local transport deployed.
Check ownership and active processes before removing a legacy prompt copy.

---

## Known limits of this runbook

- The `--llm` agentic analyst path needs `TANGLE_API_KEY` and the Python
  `agent-eval-rpc[dspy]` extra. Unverified here. The deterministic pass needs neither
  and is what days 2 and 3 rely on.
- Casework has never run a campaign, so the worked example in `examples/casework/`
  documents the seam rather than a completed run. See its README.
