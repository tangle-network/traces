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
traces analyze spans.otlp.jsonl --out .traces/current.md
traces analyze results/sessions --out .traces/all.md   # a directory of exports
```

A session id, an 8+ character prefix or suffix, or a session file is a ref too; integrate systems you own through OTLP.

Directories read only OTLP files, preferring an `otlp/` subdirectory; other JSONL logs are listed separately.

Report `Inputs incomplete` values as uncaptured, never zero spend.
The `trace conformance` section lists missing capabilities.

For loops, inspect `round-over-round convergence` and `steering chain` before judging progress.

## Select the workflow

```bash
traces --version
traces list --harness codex --cwd "$PWD"
traces facts --current --latest-turn --format text --out .traces/current-facts.txt
```

- Use `--current` for the active Codex or Claude Code session.
- Pass a listed session's id, 8+ character prefix or suffix, or path as the ref to pin it.
- Use `--latest-turn` for the current task in a resumed Codex or Claude Code session.
- A named session brings its workers, linked by stable parent and child IDs, up to 100.

Never join agents by display name or timestamp when Traces reports missing or conflicting IDs.
Read facts before full transcripts or analysis.
Check parent and worker counts against the task being investigated.
Run `analyze` only for questions the facts sheet cannot answer:

```bash
traces analyze --current --latest-turn --out .traces/current.md
```

For moved evidence, keep byte-identical transcripts and record their source paths and hashes.
Preserve Claude's `<session UUID>/subagents/workflows/<run ID>` subtree beside the copied parent JSONL file.
Restore missing child files from the source; rewriting recorded paths loses the original evidence.
Check current branches, edits, commits, and PRs before reporting unfinished work; transcripts describe past actions.

## Export

Write normalized OpenInference spans for another tool:

```bash
traces convert --current --latest-turn --out .traces/current.otlp.jsonl
```

Write the deterministic review as files:

```bash
traces analyze --current --latest-turn --out .traces/analysis
```

It writes `report.md` and `findings.json`, and edits no agent, repository, memory store, or knowledge base.

Preserve a session for later inspection:

```bash
traces bundle <id-or-path> --out .traces/bundle
traces bundle verify .traces/bundle
```

`bundle` copies transcripts, spans, the facts sheet, and the session-window git log with per-file SHA-256 hashes.
It uses no model calls.
Missing transcripts stop assembly; optional missing inputs appear in `manifest.absent`.
A bundle directory is a ref: `traces facts .traces/bundle --no-content` reads its evidence without the session's own words.

## Ask your own question

`traces ask --last 1 --question "<text>" --budget 2 --dir .traces/ask` spends model calls and resolves answer citations.

## Report

- State the ref and harness, selected task boundary, session and span counts, and integrity warnings.
- Name missing capabilities and analyses affected by them.
- Cite each finding with its exact `trace://` reference.
- Mark missing outcome, cost, token, skill, or relationship data unknown.
- Do not infer task success from a completion message.
- Do not infer skill use from reading a `SKILL.md`.
- Do not upload traces unless explicitly requested.

## Then consider

- Write an analyst with the SDK (`examples/custom-analyst.ts`) when deterministic findings cannot answer a repeated trace question.
- Use `autopsy` when the result is empty, surprising, or suspiciously strong.
