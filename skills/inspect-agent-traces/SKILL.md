---
name: inspect-agent-traces
description: Inspect real agent workflows with the published Traces CLI and export cited local findings.
---

# Inspect agent traces

Use the deterministic CLI first.
Keep inspection local and read-only.

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
  --otlp .traces/current.otlp.jsonl
```

Write the complete deterministic review packet:

```bash
traces improve --harness codex --current --latest-turn --workflow \
  --dir .traces/improvement
```

`improve` writes findings, evidence, a report, and spans.
It does not edit an agent, repository, memory store, or knowledge base.

## Report

- State the harness, selected task boundary, session and span counts, and integrity warnings.
- Cite each finding with its exact `trace://` reference.
- Mark missing outcome, cost, token, skill, or relationship data as unknown.
- Do not infer task success from a completion message.
- Do not infer skill use from reading a `SKILL.md`.
- Do not upload traces unless explicitly requested.

## Then consider

- Use `build-trace-analyst` when deterministic findings cannot answer a repeated trace question.
- Use `autopsy` when the result is empty, surprising, or suspiciously strong.
