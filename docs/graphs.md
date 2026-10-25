# Graph corpus

[traces](../README.md#docs) › Graph corpus

`traces graphs` observes sessions through the existing readers and stores Runtime's `StoredGraph` and `GraphRunRecord`. The existing span-run tree owns execution boundaries: sessions, agents and recorded workflow phases become nodes. Parent edges retain containment without claiming delegation. Node tokens are exclusive: summing a parent and its children never counts a child's usage twice. Missing identity, timing, usage and relationships remain explicit unknowns.

```bash
traces graphs --since 7d --out corpus --runtime-module /path/to/runtime/dist/kernel.js
traces graphs --registry corpus --task-type bugfix --format json
```

A selection ingests one session tree at a time and byte-binds each selected source through the existing workflow reader. `--fleet-run ID` binds one named native session to an exact Fleet run; it never treats a reusable lane ID as a run. `--out DIR` chooses its registry; otherwise it uses local traces state. With no selection, the command queries `--registry DIR` or that default. A source fingerprint cache skips unchanged reader inputs; appended or replaced files and changed source directories invalidate it. The registry's source identity replaces an earlier observation rather than duplicating it.

Task type is explicit. A source's final message or successful tool result does not prove delivery: newly ingested sessions have unknown outcomes until an owner attaches independently checked merge or served-release evidence. Unknown outcomes are excluded from delivered-rate denominators and counted beside each group. Ranking uses delivered rate, median wall minutes, tokens and human messages; median minutes to merge stays null without a verified merge time. Run links accompany every group. Exact repository-qualified PR command references are retained as `pr-created-command` or `pr-merge-command` evidence; these are observations for an independent GitHub join, never delivery labels.

The currently pinned Runtime predates corpus ingestion. Until a compatible Runtime release is published, pass `--runtime-module` pointing to its exact built or packed **public** `dist/kernel.js`. A missing API exits 2 with an actionable setup error. Source PR merges do not publish packages. Observed graphs cannot become replay candidates.

`--discovery-index PATH` streams Discovery’s maintained `run-index.jsonl` or host run catalog. Directory locations reuse the existing Runtime supervisor reader and normalize its recorded nodes into the same spans. Named Runtime run directories use that reader too. Unavailable journals remain run containers with unknown topology and usage; a `winner` state does not establish software delivery. Missing start/registration timestamps stay unreadable, never replaced with index time. Driver usage excludes child-inclusive settlement totals, and absent channels remain unknown. No second journal parser or index is maintained.

Pi dynamic-workflow run JSON is detected by the existing file reader. Recorded agent calls, reported usage and timed tool observations enter the same span tree; phase names without phase clocks remain explicit coverage gaps. Claude Workflow journals enrich exact child transcript nodes and preserve recorded phase lifecycle spans. Script text alone does not establish execution.

`--since`/`--until` select overlapping activity; facts still cover each whole session. JSON reports the selection window, actual observation time and `accountingCutoffApplied:false`. Tokens are not an as-of-cut or weekly total.

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
  --fleet-run ID      bind one named native session to this exact Fleet run ID
  --discovery-index PATH ingest the Discovery run catalog through its existing run reader
  --registry DIR      query an existing Runtime graph registry
  --task-type TYPE    explicit feature, bugfix, consolidation, investigation or ops
  --shape DIGEST      filter an exact topology digest
  --runtime-module MODULE Runtime public module path or URL (default installed kernel)
  --out DIR           ingest into this Runtime registry (default local traces state)
  --format text|json  text (default) or json

jq paths (--format json):
  .groups[] | {taskType, topologyDigest, deliveredRate, medianMergeMs}  task type × topology; unknown stays null

Examples:
  traces graphs --since 7d --out corpus
  traces graphs --registry corpus --task-type bugfix --format json
```
