# Session index, evidence and export

[traces](../README.md#docs) › Session index, evidence and export

## Session index

`traces index` writes one general JSON catalog over the selected sessions.
It is meant for deeper investigation and joins with other local data, not for one specific workflow.

```bash
traces index --all --since 24h --out session-index.json
traces inspect session-index.json --out inspection-report.md
```

The index contains:

- selection metadata and aggregate totals
- one row per session with harness, session id, path, cwd, repo labels, and time bounds
- behavior metrics: spans, LLM turns, tool calls, tool errors, tokens, models, and tools
- signal summaries: stuck loops and tool error rate
- nearby context files for joins: `AGENTS.md`, `CLAUDE.md`, and `.evolve` artifacts — the JSONL ledgers, `scorecard.json` / `current.json`, reflections, `handoffs/` plus the flat `handoff-*.md` convention, and `progress.md` — with markdown heading/ToC and JSONL key summaries

`traces inspect` reads that index back and prints ranked improvement findings over the sessions and nearby context.
It is intentionally read-only: it points to repeated-call loops, high tool-error sessions, missing repo attribution, long docs without Contents, invalid JSONL rows, and skill-run rows that cannot be joined back to a session.

## Policy-mining evidence

`traces` does **not** emit benchmark campaign cells. It emits normalized coding-agent session evidence that another system can mine.

```bash
traces evidence --all --since 24h --out policy-evidence.jsonl --otlp-out spans.otlp.jsonl
```

Each JSONL row is one session:

- session provenance: harness, session id, cwd, path, mtime
- explicit-session source binding: `provenance.sourceSha256` over every adapter-declared input file, including Claude worker and metadata files
- repo labels: `tangle.subject.key`, `git.repository`, branch, commit
- behavior metrics: span counts, LLM turns, tool calls, errored tool calls, tokens, models, tool histogram
- mining signals: stuck loops and tool error rate
- provenance marker: `notCampaignCell: true`

That boundary matters. `agent-lab` campaign `cells.jsonl` says "arm X beat arm Y on task Z." `traces evidence` says "this real agent session had this repo/model/tool/failure shape." A downstream policy compiler can cluster these rows, propose candidate policies, then validate those policies in a separate eval campaign.

## Export existing evidence or events to OpenInference

If you already have compact evidence or event captures on disk, convert them to the same OpenInference JSONL shape that `traces analyze --analyzer halo` uses:

```bash
traces export policy-evidence.jsonl --out spans.openinference.jsonl
traces export sandbox-events.json --format sandbox-events --out spans.openinference.jsonl
traces export trajectory.json --format chat-trajectory --out spans.openinference.jsonl
halo spans.openinference.jsonl --prompt "Analyze this trace slice" --max-turns 1
```

`traces export` accepts:

- compact `traces.policy_evidence.session` JSONL from `traces evidence`
- JSON arrays with `start`, `raw`, `result`, `done`, and `error` events. A tool call becomes one span, keyed by its message part id, however many events report on that part. The Sandbox SDK records each call as a `message.part.updated` event and again as the harness's raw `tool_use` event. The span takes its start from the part's first event, its final state from the last, and `ERROR` if any event reported one. The root span's `traces.event.tool_part_updates_merged` counts the events folded in.
- existing OpenInference JSONL, rewritten through the local redaction path
- chat message arrays and objects with a `messages` array

Run `traces export --help` for the full command reference.
