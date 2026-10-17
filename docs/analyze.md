# Analyze a session

[traces](../README.md#docs) › Analyze a session

`traces analyze` says what went wrong in the selected sessions, ranked, for $0.
It calls no model and needs no key: `traces ask` is the one command that spends.

```bash
traces analyze --current
traces analyze 019a3c7e --out analysis      # report.md and findings.json
traces analyze --since 1d --cwd .           # a table of the sessions with the most waste
```

## The text

At most 40 lines, in this order. A section with nothing to say is left out, and a fact the trace cannot support is never printed as 0.

1. Header: short id, harness, repo, the window and its length, active time, cost (list price, Router rates).
2. What was asked: the first human turn, and how many followed.
3. The first failure and its blame.
4. Failing commands (a command that failed 3 or more times in a row) and rework (commands rerun, reverts).
5. Tool-error clusters: the session's own failed calls, by tool and first line of error.
6. Stalls of 10 minutes or more that no turn ended.
7. Interrupts and rejections: turns typed after an interrupt, after a rejected tool call, or right after a completion claim, each quoted. Measured against labelled turns, a reply after a claim is a correction at about the base rate, so none of these is called a correction.
8. Unverified completion claims: a claim made after an edit with no test, build, typecheck or lint since.
9. Pull requests opened and merged.
10. Findings, HIGH first, each with span ids.
11. How many questions the trace cannot answer, and where the list is.

Sections 3, 4, 6, 7 and 9 and the header are the facts sheet's numbers ([`traces facts`](facts.md)); analyze renders them and never counts them again.
Several sessions put sections 2–9 in a table of the 15 with the most waste.

## Findings

| Finding | From | Severity |
|---|---|---|
| `same-failing-command` | a failing streak in the facts sheet | HIGH |
| `verification-without-change` | one check command run 3 or more times with no edit between | MED (HIGH from 5) |
| `high-tool-error-rate` | half or more of the session's own tool calls failed | MED (HIGH from 75%) |
| `completion-claim-without-verification` | section 8 | LOW: 0 of 9 held on real sessions |
| `terminal-failure` | the session's root span ended in an error | HIGH |
| `monotonic-input-growth`, `output-length-decay` | agent-eval's behavioral analyst | HIGH, MED |
| `single-tool-dependency` | agent-eval; a run of 10 or more calls of one non-shell tool | MED |
| `no-self-verification` | agent-eval; 10 or more calls, none a check by name or by command | LOW: 0 of 1 held on real sessions |

The first four are the rules `traces watch` runs on live sessions (`src/pipelines.ts`), so a finding means the same in both.

## For programs

`--format json` prints one object: `facts` (the facts sheet of every session), `packet` (the finding packet ADC's Intelligence API reads), `measures` (stuck loops, failure clusters, tool use and errors, failure follow-ups, unverified claims), `conformance`, and `cannotAnswer` (every question the trace cannot answer, with the reason).

```bash
traces analyze 019a3c7e --format json | jq '.packet.findings[] | {severity, subject, claim}'
traces analyze 019a3c7e --format json | jq '.cannotAnswer[] | {analysis, reason}'
```

`--out DIR` writes exactly `report.md` (the text, every finding in full, and every cannot-answer reason) and `findings.json` (the packet). No span copy is written: `traces convert <ref> --out <file>` hands spans to another tool.

A Runtime run directory as the ref reports its supervision tree; with `--out DIR` it is written to `DIR/report.md`.

## Your own analysts

Run your analysts through the SDK: `analyzeSpans(spans, { registry })` runs an agent-eval `AnalystRegistry` over the spans in memory ([`examples/custom-analyst.ts`](../examples/custom-analyst.ts)).
