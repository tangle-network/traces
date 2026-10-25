# Watch live sessions and run trees

[traces](../README.md#docs) › Watch

`traces watch` runs the analyze rules on every session active in the last 30 minutes, on every harness, while the agents still run: a command that failed 3 or more times in a row, a check rerun 3 or more times with no edit between, and half or more of a session's tool calls failing.
Sessions are read every 5 s and the window slides, so a feed left running never goes blind. A session that cannot be read is skipped and named.

```bash
traces watch --once                  # one pass over every active session
traces watch --since 2h --cwd .      # this repo's sessions of the last two hours, live
traces watch --format jsonl          # the machine feed
```

Text prints one line per new finding:

```
10:06:00 HIGH a11a1a11 claude-code same-failing-command: `pnpm test` failed 3× in a row (5 min). (spans t1, t2, …)
```

## The `traces.stream` envelope

`--format jsonl` prints the same events the text renders, at `schemaVersion` 1. It is a stable API: [`watch-jsonl.v1.example.jsonl`](./watch-jsonl.v1.example.jsonl) is the CLI's output on a fixture, and `tests/watch-jsonl-contract.test.ts` holds it and the fields consumers read.

| `kind` | When | Fields |
|---|---|---|
| `traces.stream.session` | the first pass that reads a session | `session` (`harness`, `sessionId`, `cwd`, `path`), `spanCount`, `startedAt`, `endedAt` |
| `traces.stream.span` | with `--spans`, a span is new or its end/status changes | `session`, `span` (the complete OTLP-JSONL record) |
| `traces.stream.finding` | the first pass that finds it | `finding`: `ruleId`, `fingerprint`, `severity`, `claim`, `action`, `check`, `evidence`, `session`, `observedAt` |
| `traces.stream.tick` | the end of every pass | `sessions`, `newSpans`, `findings`, `unreadSessions` |

Use `--spans` with `--format jsonl` to include new or changed spans in the convert contract.
A later span event with the same `span_id` replaces the prior record.

Every event also carries `schemaVersion`, `event` and `generatedAt`. Custom live rules go through the SDK: `streamSessions({ extraAnalysts })`.

## A run tree

`traces watch <run-dir>` tails one run that fans work out to other agents: per node its status, runtime, authored budget and actual spend, at any depth. It is plain stdout, so it works over SSH, in a CI log and through a pipe. A run tree is read every 2 s until its result lands, and a run that ended with an error exits 1.

```bash
traces watch runs/my-run --once
traces watch traces.otlp.jsonl       # spans only, from any emitter with parent span ids
```

Two sources sit behind it, and the output names which number came from which: OTLP spans (tree shape, wall time, tokens, cost when priced) and agent-runtime's `spawn-journal.jsonl` (authored budget, settled spend, blocking questions, steers, the result).
A node's own driving and the work it delegated are separate lines, and an unpriced turn reads `cost unknown`, never `$0.0000`. `traces analyze <run-dir>` writes the full report.

## `traces watch --help`

```text
Usage: traces watch [<id…> | <store-root>] [--since T] [--once]  |  watch <run-dir|span file> [--once]
Live supervision: what the analyze rules find in every session active in the last 30 minutes, or one run tree.
Sessions are read every 5 s; a run tree every 2 s, until its result lands (exit 1 when the run ended with an error).
A run dir or span file prints its tree as text, and its findings with --format jsonl.

  --since T           sessions active in the last T (default 30m; it slides with time), or since an ISO time
  --cwd DIR           sessions recorded in DIR or under it, or in a worktree of its repo
  --harness ID        only this harness's sessions; with a file ref, force its reader
  --once              one pass, then exit
  --spans             with --format jsonl: also a span event for each new or changed span, reading every 1 s for live views
  --format text|jsonl text (default): a line per new finding, or the run tree; jsonl: the traces.stream events

jq paths (--format jsonl):
  select(.event == "finding") | .finding | {severity, ruleId, claim}  each new finding
  select(.event == "tick") | .unreadSessions                          sessions a pass could not read, and why
  select(.event == "span") | .span                                    with --spans: each new or changed span, in the OTLP-JSONL contract

Examples:
  traces watch --once
  traces watch runs/my-run --once
  traces watch --since 2h --format jsonl
  traces watch <id> --format jsonl --spans
```
