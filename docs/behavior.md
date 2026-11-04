# Behavior windows

[traces](../README.md#docs) › Behavior windows

`traces behavior` says what each agent did in each five-minute window of a run, from the contract spans any producer emits: one node per session, each window's category with a calibration certificate and its spans as evidence, failing streaks, stalls, record-only gaming flags, anomalies against the run's own node baseline, and who messaged whom.

```bash
traces behavior run/otlp/                                                        # a directory of one trace per node
traces behavior run.otlp.jsonl --format json | jq '.windows[] | select(.category == "looping")'
```

A node is one `session.id`; its `session` span (else its earliest root) carries the label, parent, depth, state and model. A producer with one trace for the whole run is split at its agent boundaries, the tree `traces watch` prints.
Each span is classed by the policy `dl-ui-behavior-windows@1`: a model call (any span the trace contract classes LLM, such as `llm.turn`) and `message.assistant` are thinking, `user.prompt` inbound, a `file_change` or one-file edit tool (`Edit`, `Write`, `edit`, `write`; a tool name matches in any case, with or without `_` or `-`, under any MCP server) implementing or process_files (notes, plans, markdown, logs); a shell command is verifying (a test, bench, probe or timing run), building (`cargo build`, `check`, `clippy`), exploring (`cat`, `ls`, `grep`, `git log`, `diff`, `show`), implementing (`sed -i`, `apply_patch`, a redirect into a source file), integrating (`git commit`, `push`, `tag`), else running; a coordination call is reviewing (`observe_agent`, `read_journal`), exploring (`knowledge_read`, `knowledge_search`, a web search) or communicating (`steer_agent`, `spawn_worker`, `report_blocked`, `knowledge_record`); a call left as running takes the verify, edit or read reading `traces analyze` gives it, so a `pnpm test` verifies.

A window is implementing when a code edit fell in it, else verifying when a check ran, else the category with the most seconds: an event explains the time until the next one, at most 15 minutes.
A failing streak (one command failing three or more times in a row, ended only by its own success) makes its window looping; a gap of ten minutes or more with no span is idle, and a stall.
`windows[].span_ids` are the spans whose time the window holds; an idle window carries the span after which the node went quiet.

`calibration` is the shipped table, per class: the gold count, the held-out judge's AUC and confidence interval, the rule's own precision and recall, and `calibrated` when AUC is at least 0.80, the lower CI at least 0.70 and the gold count at least 10 (508 labeled windows, 201 held out, 2026-11-02).
Calibrated: implementing, verifying, exploring, communicating, idle. Not: reviewing (n=7), process_files (n=9), looping (n=0); the text prints `uncalibrated` beside them and every window carries its class's `calibrated`.
`flags[]` (`check_edit`, `test_delete`, `test_edited_to_pass`, `verification_capped`, `claim_without_reading`, each with node, time, span and detail) are record-only: no flag carries a severity above info, and a reader decides what one means.
`anomalies[]` are robust z-scores (median and MAD across the run's nodes) per metric (`calls_per_hour`, `fail_rate`, `idle_min`, `streaks`, `tokens_in` when known) at |z| of 2.5 or more, each with the node's session span; below four nodes with a value, z is null. `drift[]` counts tool calls, failed calls and active nodes per window.
`mail.edges[]` come from steer, spawn, observe and report_blocked calls (`from`, `to` is the worker id, `at`, `span`); a steer's `read_latency_min` is the recipient's next model turn after the send, null when the recipient is not in the run.

The JSON is `{ policy: { id, version, window_s }, run: { t0, t1, n_windows, spans }, nodes[], windows[], flags[], streaks[], stalls[], anomalies[], drift[], mail: { edges[], summary }, calibration }`; times are epoch seconds.
Exit 0 when it answered, 2 when no span is a tool call (`no tool spans; categories unavailable`) or the selection cannot be read; it never exits 1, since a flag is a record, not a verdict.

## `traces behavior --help`

```text
Usage: traces behavior <ref…> | --current | --last N | --since T [--window 5m] [--format text|json]
What each agent did per five-minute window: categories with a calibration certificate, failing streaks, stalls, gaming flags (record-only), anomalies against the run's own baseline, and who messaged whom.
One node per session id (else per agent boundary). A window is implementing on a code edit, else verifying on a check, else its longest category;
a failing streak makes it looping, a 10-minute gap idle. Exit 2 when no span is a tool call: categories need acts.

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

Examples:
  traces behavior run/otlp/
  traces behavior run.otlp.jsonl --window 10m --format json | jq '.windows[] | select(.category == "looping")'
```
