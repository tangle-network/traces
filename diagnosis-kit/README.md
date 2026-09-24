# Agent diagnosis kit

A fixed-scope engagement: you give us read access to your agent's traces, we tell you
where it is losing time, money and correctness, and we hand you a one-page report plus
the checks that prove whether a fix worked.

Price: $2,500. Duration: five working days from the day traces arrive.

This directory holds everything needed to run one engagement. It adds no new analysis
code. It drives the `traces` CLI and `agent-eval` that already exist in this repository,
and it exists so that the sequence, the data boundary and the deliverable are written
down once instead of being reinvented per customer.

## What the buyer gets

1. A one-page report. `templates/report.md` is the shape.
2. The checks behind every number, so they can re-run them on their own machine.
3. A written statement of what we could not see.

Point 3 is not a disclaimer. It is the part that makes the other two trustworthy.

## The data boundary

**Metadata-only by default.** Span names, timings, token counts, costs, tool names,
model ids, error statuses and the trace shape. No prompt or response content.
The customer removes content on their own machine before transfer.
The operator rejects a received file that still contains recognized content fields or structured secrets.

Content capture requires the customer to opt in, in writing, per engagement.

The reason is specific rather than legal boilerplate. `src/redact.ts` in this repository
redacts structured secrets well: GitHub tokens, JWTs, bearer headers, AWS keys, Slack
tokens, private-key blocks, credentials in URLs, config and shell assignments. Its own
doc comment states the limit plainly, and we repeat it to customers rather than hiding it:

> this is best-effort regex for structured secrets and credentials. It does NOT catch
> free-form PII — names, postal addresses, phone numbers, account numbers in prose

A law firm's trace carries client matters in exactly those prose fields. A diagnosis that
runs on metadata and says what it could not see is a stronger position than one that
quietly ingested privileged content. If metadata proves too thin to find anything, that is
a finding we report, not a reason to widen capture.

Customer traces stay in a separate engagement store on the operator's host.
They do not enter internal trace mining, GitHub issues, or a training corpus.
With third-party processing enabled, the diagnosis sends filtered spans through our router to the model provider.
The metadata-only model receives a fixed label and no free-form intake question.
Check span names and other retained metadata for sensitive prose before model processing.
The operator deletes the engagement after handoff with `trace-mine close --id <id>`.
The daily purge deletes expired engagements if the handoff close did not run.
Written customer consent is required to retain traces past the engagement.
The internal trace pipeline keeps its own storage and issue filer.

## Running an engagement

`RUNBOOK.md` is the operator's sequence, with the exact commands.
`intake.md` is what the customer fills in before anything is captured.
`checks/` holds the agent-eval check set that produces the measurable before and after.
`examples/casework/` is a complete worked engagement against one of our own agents.

## Scope limits, stated before the sale

- We diagnose what the trace records. A defect that leaves no trace is invisible to us,
  and `traces validate` reports which capabilities a given trace cannot support.
- Metadata cannot show reasoning quality. It shows cost, latency, loops, tool failure
  rates, retry storms and convergence. Prompt-level quality work needs content opt-in.
- Five days is a diagnosis, not a remediation. Fixes are a separate engagement.
