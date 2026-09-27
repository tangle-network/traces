---
name: inspect-agent-traces
description: Inspect real agent workflows with the published Traces CLI and export cited local findings.
---

# Inspect agent traces

Use the deterministic CLI first; keep inspection local and read-only.

## Choose the way in

Read conforming OTLP directly, including `@tangle-network/agent-trace-contract` exports.

```bash
traces validate spans.otlp.jsonl          # exit 1 on error findings
traces analyze --otlp spans.otlp.jsonl --out .traces/current.md
traces analyze --otlp results/sessions --out .traces/all.md   # a directory of exports
```

Use `--harness` for native coding-agent formats; integrate systems you own through OTLP.

Directories read only OTLP files, preferring an `otlp/` subdirectory; other JSONL logs are listed separately.

Report `Inputs incomplete` values as uncaptured, never zero spend.
The `trace conformance` section lists missing capabilities.

For loops, inspect `round-over-round convergence` and `steering chain` before judging progress.

## Select the workflow

```bash
traces --version
traces list --harness codex --cwd "$PWD"
traces facts --harness codex --current --latest-turn --workflow \
  --format text --out .traces/current-facts.txt
```

- Use `--current` for the active Codex session.
- Use `--session <id-or-path>` to pin a listed session.
- Use `--latest-turn` for the current task in a resumed Codex or Claude Code session.
- Use `--workflow` to include workers linked by stable parent and child IDs.
- Use `--max-workflow-sessions <n>` only when the default 100-file bound is too small.
- For Claude Code, use `--harness claude-code --session <path> --latest-turn`; nested subagents are included.

Never join agents by display name or timestamp when Traces reports missing or conflicting IDs.
Read facts before full transcripts or analysis.
Check parent and worker counts against the task being investigated.
Run `analyze` only for questions the facts sheet cannot answer:

```bash
traces analyze --harness codex --current --latest-turn --workflow \
  --out .traces/current.md
```

For moved evidence, keep byte-identical transcripts and record their source paths and hashes.
Preserve Claude's `<session UUID>/subagents/workflows/<run ID>` subtree beside the copied parent JSONL file.
Restore missing child files from the source; rewriting recorded paths loses the original evidence.
Check current branches, edits, commits, and PRs before reporting unfinished work; transcripts describe past actions.

## Export

Write normalized OpenInference spans for another tool:

```bash
traces convert --harness codex --current --latest-turn --workflow \
  --otlp-out .traces/current.otlp.jsonl
```

Write the complete deterministic review packet:

```bash
traces improve --harness codex --current --latest-turn --workflow \
  --dir .traces/improvement
```

`improve` writes findings, evidence, a report, and spans.
It edits no agent, repository, memory store, or knowledge base.

Preserve a session for later inspection:

```bash
traces bundle --harness claude-code --session <id-or-path> --out .traces/bundle
```

`bundle` copies transcripts, report, spans, and session-window `.evolve` rows with per-file SHA-256 hashes.
It uses no model calls.
Missing transcripts stop assembly; optional missing inputs appear in `manifest.absent`.

## Pick the view for the reader

The full bundle includes transcripts containing prior reports, even when report files are removed.
For a writer who must not see earlier conclusions, project an evidence-only copy:

```bash
traces bundle-view .traces/bundle --view evidence-only --out .traces/writer
```

This retains the session index, evidence JSONL, and structured ledger records.
It excludes transcripts, reports, spans, prose ledgers, and files repeating an eight-word passage from excluded prose.
Check `manifest.view` and the rules and hashes in `manifest.excluded`.

## Ask your own question

`traces ask --last 1 --question "<text>" --budget 2 --dir .traces/ask` spends model calls and resolves answer citations.

## Report

- State the source (`--otlp <path>` or the harness), selected task boundary, session and span counts, and integrity warnings.
- Name missing capabilities and analyses affected by them.
- Cite each finding with its exact `trace://` reference.
- Mark missing outcome, cost, token, skill, or relationship data unknown.
- Do not infer task success from a completion message.
- Do not infer skill use from reading a `SKILL.md`.
- Do not upload traces unless explicitly requested.

## Then consider

- Use `build-trace-analyst` when deterministic findings cannot answer a repeated trace question.
- Use `autopsy` when the result is empty, surprising, or suspiciously strong.
