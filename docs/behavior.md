# Behavior windows

[traces](../README.md#docs) › Behavior windows

`traces behavior` says what each agent did in each five-minute window of a run, from the contract spans any producer emits: one node per session, each window's category with a calibration certificate and its spans as evidence, failing streaks, stalls, record-only gaming flags, anomalies against the run's own node baseline, and who messaged whom.

```bash
traces behavior run/otlp/                                                        # a directory of one trace per node
traces behavior run.otlp.jsonl --format json | jq '.windows[] | select(.category == "looping")'
```

Recordings can mix explicit `session.id` values, native session IDs and agent boundaries in the OTLP parent tree. Behavior assigns each observed tool call to one node. A native session keeps its identity across input files. For a boundary with only span identity, its node ID contains both its trace ID and its span ID. Parent references can join sessions in different files. Each node keeps its session `id`. Its `agent_id` names the coordinating actor when the producer recorded a consistent binding. A missing or conflicting binding gives `null`. A fork’s inherited transcript belongs to the original session.

The JSON `coverage` gives the count of unique input spans, the tool calls actually attributed, and any known gaps in the selected sources. Two refs containing the same OTLP span count once. A run with no recorded calls cannot support a behavior verdict. A partial run can report what its sources cover. Text output names the same gaps. Naming a session also checks its workflow references. A time sweep covers sessions in the selected window.

Each span is classed by the policy `dl-ui-behavior-windows@1`: a model call (any span the trace contract classes LLM, such as `llm.turn`) and `message.assistant` are thinking, `user.prompt` inbound, a `file_change` or one-file edit tool (`Edit`, `Write`, `edit`, `write`; a tool name matches in any case, with or without `_` or `-`, under any MCP server) implementing or process_files (notes, plans, markdown, logs); a shell command is verifying (a test, bench, probe or timing run), building (`cargo build`, `check`, `clippy`), exploring (`cat`, `ls`, `grep`, `git log`, `diff`, `show`), implementing (`sed -i`, `apply_patch`, a redirect into a source file), integrating (`git commit`, `push`, `tag`), else running; a coordination call is reviewing (`observe_agent`, `read_journal`), exploring (`knowledge_read`, `knowledge_search`, a web search) or communicating (`steer_agent`, `spawn_worker`, `report_blocked`, `knowledge_record`); a call left as running takes the verify, edit or read reading `traces analyze` gives it, so a `pnpm test` verifies.

A window is implementing when a code edit fell in it, else verifying when a check ran, else the category with the most seconds: an event explains the time until the next one, at most 15 minutes.
A failing streak (one command failing three or more times in a row, ended only by its own success) makes its window looping; a gap of ten minutes or more with no span is idle, and a stall.
`windows[].span_ids` are the spans whose time the window holds; an idle window carries the span after which the node went quiet.

`calibration` is the shipped table, per class: the gold count, the held-out judge's AUC and confidence interval, the rule's own precision and recall, and `calibrated` when AUC is at least 0.80, the lower CI at least 0.70 and the gold count at least 10 (508 labeled windows, 201 held out, 2026-11-02).
Calibrated: implementing, verifying, exploring, communicating, idle. Not: reviewing (n=7), process_files (n=9), looping (n=0); the text prints `uncalibrated` beside them and every window carries its class's `calibrated`.
`flags[]` (`check_edit`, `test_delete`, `test_edited_to_pass`, `verification_capped`, `claim_without_reading`, each with node, time, span and detail) are record-only: no flag carries a severity above info, and a reader decides what one means.
`anomalies[]` are robust z-scores (median and MAD across the run's nodes) per metric (`calls_per_hour`, `fail_rate`, `idle_min`, `streaks`, `tokens_in` when known) at |z| of 2.5 or more, each with the node's session span; below four nodes with a value, z is null. `drift[]` counts tool calls, failed calls and active nodes per window.
`mail.edges[]` come from steer, spawn, observe and report_blocked calls, the harness's own spawn and message calls (Codex `spawn_agent`, `send_message`, `followup_task`; a Claude Code subagent) and `fleet send` commands (`from`, `to` is the worker id, task or recipient, `at`, `span`); a steer's `read_latency_min` is the recipient's next model turn after the send, null when the recipient is not in the run.

The JSON is `{ policy: { id, version, window_s }, run: { t0, t1, n_windows, spans }, nodes[], windows[], flags[], streaks[], stalls[], anomalies[], drift[], mail: { edges[], summary }, calibration }`; times are epoch seconds.
Exit 0 when it answered, 2 when no span is a tool call (`no tool spans; categories unavailable`) or the selection cannot be read; it never exits 1, since a flag is a record, not a verdict.

## A run's own records

A Runtime run directory, or its run id under a run root ([Refs](select.md#refs)), adds `run_record`, which is read from the run's records rather than its spans and printed above the windows:
who stopped it (the cancel request's time, source, operator and reason, and Runtime's acknowledgement), Runtime's terminal kind and reason, every play check (stage score, failing stage and the checker's reason) and submission, the settle record (wall, tokens with their status, compute and list dollars, model), and `quiet[]`: each node's last act (its last span other than the session span) in minutes before the stop, negative when it acted after it, beside the root stream's last event.
The stop is the first of the stop request, Runtime's settle and the settle record; a request that came after Runtime had settled the run is named. Values are printed as recorded, with no classification; a record that is present but unreadable is listed under `unread`.
A reopen starts a new generation of the run: a reopen keeps the request it lifts under `cancellations/reopened/` and the Runtime result of the generation it ends as `settles/<n>.json`. `generations[]` holds each generation's start, stop, Runtime result, checks, submissions and root stream; the other fields read the latest generation that stopped, and `stoppedAt` is when it did. Text prints each earlier generation on a line, then that one in full, where an act or stream event from before its reopen reads as none since the reopen; the progress, quiet and root-stream lines count only what came before the next reopen, and each reopen after the stop is printed with what has happened since. `reopens[]` and `stops[]` hold every reopen and cancel request. `state` is where the lifecycle log last moved the run. A node still open in a run that has ended ends at Runtime's settle (`endedAt`), not now.
Between generations the run was stopped, from a generation's end (its Runtime settle, else its stop) to the reopen: `run.stopped[]` holds each such time, and the text prints it on a line. That time is neither idle nor active. A session that spans it, such as a root whose first session the reopen resumed, has its gap cut there: each part on either side is idle, and a stall, only when it is ten minutes or more; an act explains no time past the stop; the node's `hours` leave it out and `stopped_min` holds it. A node left open at a stop ends there unless it acted after the reopen.
With no tool span, a run with records still exits 0: it prints the record and `categories: null` with the reason. `src/run-record.ts` names each record it reads.

A running run has no exported sessions yet: a settle exports each agent's native session to the run's OTLP. Until then, and for the executions a reopen starts after that export, an agent is read from the run's retained live stream (`evidence/live-stream/`, one file per execution), through the shared `sandbox.events` reader and the same projection as an exported session, under the node's journal identity and its parent's session. `facts` and `behavior` then read a running run as they read a settled one, with two differences listed under `coverage.unknowns`: the stream records tool calls and replies but no model calls (token usage is the Runtime journal's), and the Sandbox can drop events when its buffer overflows, which it records with a count; an agent whose stream dropped events has a lower bound on its tool calls. A running agent's record ends at the stream's last write. `src/adapters/runtime-live-streams.ts` reads the stream.

The behavior report and span tree show the producer’s node label when available. Two sessions can share a display label. Use their recorded IDs to follow parent links and attribute calls.

## `traces behavior --help`

```text
Usage: traces behavior <ref…> | --current | --last N | --since T [--window 5m] [--format text|json]
What each agent did per five-minute window: categories with a calibration certificate, failing streaks, stalls, gaming flags (record-only), anomalies against the run's own baseline, and who messaged whom.
One node per session id (else per agent boundary). A window is implementing on a code edit, else verifying on a check, else its longest category;
a failing streak makes it looping, a 10-minute gap idle. Exit 2 when no span is a tool call: categories need acts.
A Runtime run dir or run id adds its own records: who stopped it and why, its last check, each agent's quiet before the stop.

  --current           the caller's own session: CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID
  --last N            the N newest sessions by file mtime, never the caller's own
  --since T           every session with a record since T: 30m, 2h, 7d or an ISO time
  --cwd DIR           sessions recorded in DIR or under it, or in a worktree of its repo
  --harness ID        read only this harness; with a file ref, force its reader
  --latest-turn       only the latest task turn of a resumed Codex or Claude Code session
  --window T          the window length: 30s, 5m or 1h (default 5m)
  --format text|json  text (default): a line per node, then flags, anomalies, streaks, mail and the calibration table; json: the result

jq paths (--format json):
  .nodes[] | {id, label, by_cat, tool_calls, failed, streaks, idle_min}  each agent and its minutes per category
  .windows[] | select(.category == "looping") | {node, from, span_ids}   where an agent looped (or "idle"), with the spans
  .flags[] | {kind, node, at, span, detail}                              the gaming flags: record-only, never a severity
  .mail.summary                                                          who messaged whom: edges by kind, steers, read latency
  .run_record | {stop, checks: .checks[-1:], quiet}                      a run's stop, its last check, each agent's last act

Examples:
  traces behavior run/otlp/
  traces behavior run.otlp.jsonl --window 10m --format json | jq '.windows[] | select(.category == "looping")'
```
