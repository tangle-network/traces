# Analyze a session

[traces](../README.md#docs) › Analyze a session

`traces analyze` says what went wrong in the selected sessions, ranked, for $0. It calls no model: `traces ask` is the one command that spends.

```bash
traces analyze --current
traces analyze 019a3c7e --out analysis      # report.md and findings.json
traces analyze --since 1d --cwd .           # a table of the sessions with the most waste
```

## The text

At most 40 lines, in this order. A section with nothing to say is left out, and a fact the trace cannot support is never printed as 0.

1. Header: short id, harness, repo, window, active time and cost (list price, Router rates).
2. What was asked: the first human turn, and how many followed.
3. The first failure and its blame.
4. Failing commands (3 or more identical failures in a row) and rework (reruns, reverts).
5. Tool-error clusters: the session's own failed calls, by tool and first line of error.
6. Stalls of 10 minutes or more that no turn ended.
7. Interrupts and rejections, each quoted. Measured against labelled turns, none of these is called a correction.
8. Pull requests opened and merged.
9. Findings, HIGH first, with span ids.
10. How many questions the trace cannot answer, and where the list is.

The header and sections 3, 4, 6, 7 and 8 are the [facts](facts.md) sheet's numbers; analyze renders them and never counts them again. Several sessions put sections 2 to 8 in a table of the 15 with the most waste.

## Findings

| Finding | From | Severity |
|---|---|---|
| `same-failing-command` | a failing streak in the facts sheet | HIGH |
| `verification-without-change` | one check run 3 or more times with no edit between | MED (HIGH from 5) |
| `high-tool-error-rate` | half or more of the session's own tool calls failed | MED (HIGH from 75%) |
| `terminal-failure` | the session's root span ended in an error | HIGH |
| `monotonic-input-growth`, `output-length-decay` | agent-eval's behavioral analyst | HIGH, MED |
| `single-tool-dependency` | a run of 10 or more calls of one non-shell tool | MED |
| `no-self-verification` | 10 or more calls, none a check | LOW (0 of 1 held on real sessions) |

The first three are the rules `traces watch` runs live, so a finding means the same in both.

## For programs

`--format json` prints `facts`, `packet` (the finding packet ADC's Intelligence API reads), `measures`, `conformance` and `cannotAnswer` (every question the trace cannot answer, with the reason).
`measures.operating` pools the sessions' `modelCalls`, `guardRefusals` and `limitStop` ([facts](facts.md)): context per model call, reply latency by context band, guard refusals per 1,000 tool calls, and how many sessions, and how many of the terminal failures, ended on a limit notice. A sweep (`--since`) reads and reduces one session at a time, so a week of a busy host runs in a few gigabytes; agent-eval's behavioral analyst reads every selected trace.
`--out DIR` writes exactly `report.md` (every finding and every cannot-answer reason) and `findings.json` (the packet).
A Runtime run directory as the ref reports its supervision tree. Your own analysts run through the SDK: `analyzeSpans(spans, { registry })` ([sdk](sdk.md)).

## `traces analyze --help`

```text
Usage: traces analyze <ref…> | --current | --last N | --since T [flags]
What went wrong, ranked, for $0: failing commands, stalls, interrupts, findings, and what the trace cannot answer.
At most 40 lines; several sessions get a table of the 15 with the most waste. A Runtime run dir reports its tree.

  --current           the caller's own session: CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID
  --last N            the N newest sessions by file mtime, never the caller's own
  --since T           every session with a record since T: 30m, 2h, 7d or an ISO time
  --until T           close the --since window (exclusive); same forms
  --cwd DIR           sessions recorded in DIR or under it, or in a worktree of its repo
  --harness ID        read only this harness; with a file ref, force its reader
  --latest-turn       only the latest task turn of a resumed Codex or Claude Code session
  --format text|json  text (default, at most 40 lines) or json: facts, packet, measures, conformance, cannotAnswer
  --out DIR           write report.md and findings.json under DIR; stdout gets one summary line

jq paths (--format json):
  .packet.findings[] | {severity, subject, claim}  the findings, HIGH first
  .cannotAnswer[] | {analysis, reason}             what the trace cannot answer, and why
  .facts.sessions[0].measurements.waste            failing streaks, stalls, reverts

Examples:
  traces analyze --current
  traces analyze 019a3c7e --out analysis
  traces analyze --since 1d --cwd .
```
