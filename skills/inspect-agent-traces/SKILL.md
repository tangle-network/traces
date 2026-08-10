---
name: inspect-agent-traces
description: Inspect real agent workflows with the published Traces CLI and export cited local findings.
---

# Inspect agent traces

Use the deterministic CLI first.
Keep inspection local and read-only.

## Choose the way in

If the trace is already OTLP (a system that emits `@tangle-network/agent-trace-contract`
spans, or any conforming exporter), read it directly. No adapter is involved.

```bash
traces validate spans.otlp.jsonl          # what can this trace answer? exit 1 on error findings
traces analyze --otlp spans.otlp.jsonl --out .traces/current.md
traces analyze --otlp results/sessions --out .traces/all.md   # a directory of exports
```

Use `--harness` only for coding agents whose on-disk format we do not control.
Those adapters are the legacy edge, not the way to integrate a system you own.

A run directory holds the span export beside raw event, stream and SDK logs that are
also `*.jsonl`. Only the OTLP files are read; the rest are listed with what they hold.
An `otlp/` subdirectory, when present, is read on its own.

Any section headed `inputs incomplete`, or carrying an `Inputs incomplete` line above
its table, is computed from a field the trace does not carry everywhere. Report those
numbers as uncaptured, never as zero spend. The `trace conformance` section at the top
names every such capability once; the markers repeat it where the number actually is.

For a loop trace, read `round-over-round convergence` (did round N+1 improve on N) and
`steering chain` (which verdict caused which retry) before drawing any conclusion about
whether the agent was making progress.

## Select the workflow

```bash
traces --version
traces list --harness codex --cwd "$PWD"
traces analyze --harness codex --current --latest-turn --workflow \
  --out .traces/current.md
```

- Use `--current` for the active Codex session.
- Use `--session <id-or-path>` to pin a listed session.
- Use `--latest-turn` for the current task in a resumed Codex or Claude Code session.
- Use `--workflow` to include workers linked by stable parent and child IDs.
- Use `--max-workflow-sessions <n>` only when the default 100-file bound is insufficient.
- For Claude Code, use `--harness claude-code --session <path> --latest-turn`; nested subagents are included.

Never join agents by display name or timestamp when Traces reports missing or conflicting IDs.

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
It does not edit an agent, repository, memory store, or knowledge base.

Write one session's durable evidence directory for a later reader:

```bash
traces bundle --harness claude-code --session <id-or-path> --out .traces/bundle
```

`bundle` copies the transcript, the derived report and spans, the `.evolve` ledger rows inside the session window, and a `manifest.json` with a SHA-256 per file.
It spends no model call.
A missing transcript stops the assembly.
An absent optional input is recorded in `manifest.absent` with the probed path.

## Pick the view for the reader

That bundle is the FULL view (`manifest.view: "full"`), and it holds the whole session transcript.
Never give it to a writer that must not see an earlier conclusion: the transcript holds the text of every file the session wrote, so a check for the earlier report FILE passes while its CONTENT is still readable.

Project the writer's copy instead:

```bash
traces bundle-view .traces/bundle --view evidence-only --out .traces/writer
```

That view carries `derived/session-index.json`, `derived/evidence.jsonl`, and the structured `ledger/` records.
It excludes the transcripts, the report, the spans, and every prose ledger file by name, with rules and hashes in `manifest.excluded`.
Before writing, it compares each carried file against each excluded file for shared 8-word runs of prose, and drops any file that repeats one.
`manifest.view` names which copy you hold.

## Report

- State the source (`--otlp <path>` or the harness), selected task boundary, session and span counts, and integrity warnings.
- State which capabilities the trace could not support, and name the analyses that reported nothing because of it.
- Cite each finding with its exact `trace://` reference.
- Mark missing outcome, cost, token, skill, or relationship data as unknown.
- Do not infer task success from a completion message.
- Do not infer skill use from reading a `SKILL.md`.
- Do not upload traces unless explicitly requested.

## Then consider

- Use `build-trace-analyst` when deterministic findings cannot answer a repeated trace question.
- Use `autopsy` when the result is empty, surprising, or suspiciously strong.
