# Graph corpus

[traces](../README.md#docs) › Graph corpus

`traces graphs` observes sessions through the existing readers and stores Runtime's `StoredGraph` and `GraphRunRecord`. Each session and folded child is a node; recorded delegation links become edges. Node tokens are exclusive: summing a parent and its children never counts a child's usage twice. Missing identity, timing, usage and relationships remain explicit unknowns.

```bash
traces graphs --since 7d --out corpus --runtime-module /path/to/runtime/dist/kernel.js
traces graphs --registry corpus --task-type bugfix --format json
```

A selection ingests one session tree at a time. `--out DIR` chooses its registry; otherwise it uses local traces state. With no selection, the command queries `--registry DIR` or that default. A source fingerprint cache skips unchanged reader inputs; appended or replaced files and changed source directories invalidate it. The registry's source identity replaces an earlier observation rather than duplicating it.

Task type is explicit. A source's final message or successful tool result does not prove delivery: newly ingested sessions have unknown outcomes until an owner attaches independently checked merge or served-release evidence. Unknown outcomes are excluded from delivered-rate denominators and counted beside each group. Ranking uses delivered rate, median wall minutes, tokens and human messages; median minutes to merge stays null without a verified merge time. Run links accompany every group.

The currently pinned Runtime predates corpus ingestion. Until a compatible Runtime release is published, pass `--runtime-module` pointing to its exact built or packed **public** `dist/kernel.js`. A missing API exits 2 with an actionable setup error. Source PR merges do not publish packages. Observed graphs cannot become replay candidates.

## `traces graphs --help`

```text
Usage: traces graphs [<ref…> | --current | --last N | --since T] [flags]
Ingest session graphs, or rank a Runtime corpus by delivery, wall minutes, tokens and human messages.

  --current           the caller's own session: CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID
  --last N            the N newest sessions by file mtime, never the caller's own
  --since T           every session with a record since T: 30m, 2h, 7d or an ISO time
  --until T           close the --since window (exclusive); same forms
  --cwd DIR           sessions recorded in DIR or under it, or in a worktree of its repo
  --harness ID        read only this harness; with a file ref, force its reader
  --latest-turn       only the latest task turn of a resumed Codex or Claude Code session
  --registry DIR      query an existing Runtime graph registry
  --task-type TYPE    explicit feature, bugfix, consolidation, investigation or ops
  --shape DIGEST      filter an exact task digest or topology digest
  --runtime-module MODULE Runtime public module path or URL (default installed kernel)
  --out DIR           ingest into this Runtime registry (default local traces state)
  --format text|json  text (default) or json

jq paths (--format json):
  .groups[] | {taskType, topologyDigest, deliveredRate, medianMergeMinutes}  task type × topology; unknown stays null

Examples:
  traces graphs --since 7d --out corpus
  traces graphs --registry corpus --task-type bugfix --format json
```
