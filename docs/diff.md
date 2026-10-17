# Diff two runs

[traces](../README.md#docs) › Diff two runs

`traces diff` names the first tool call where two runs of the same task split, and prints both calls.

```bash
traces diff 0199a1b2 0199c3d4                                         # two sessions
traces diff run.otlp.jsonl#branch=arm-a run.otlp.jsonl#branch=arm-b    # two arms of one run
```

A run's steps are its tool calls in containment order; model calls are not steps, since two runs never word a reply alike.
Each call compares by tool, status and argument: the command a shell call ran, the file a file tool touched, or the call's input.
First each run's own places become placeholders (its cwd and worktree, temp dirs, and hex ids), so two runs of one play in two worktrees agree wherever they did the same thing.
The first divergence is `changed`, `replaced`, `only-in-a`, `only-in-b` or `reordered`; `--format json` holds every step, and `.diff.firstDivergence.index` is 0-based.
Exit 0 agree, 1 diverge, 2 could not compare (a side unreadable, or no call records an outcome); a gate treats 2 as unknown, never as a pass.

## `traces diff --help`

```text
Usage: traces diff <a> <b> [--format text|json]
Where two runs of one task split: the first tool call that differs, with both calls.
A side is a session id or 8+ char prefix or suffix, a session file, OTLP, file#<trace id> or file#branch=<id>.
Calls compare by tool, status and argument (the command, the file, or the input), after each run's
cwd, worktree, temp dirs and hex ids become <cwd>, <worktree>, <tmp> and <hex>. Model calls are not compared.
Exit 0 agree, 1 diverge, 2 could not compare: a side cannot be read, or neither records an outcome.

  --format text|json  text (default) or json

jq paths (--format json):
  .diff.firstDivergence                   where and how the runs first split (index is 0-based)
  .a.steps[.diff.firstDivergence.a].text  A's call at that step, normalized

Examples:
  traces diff 0199a1b2 0199c3d4
  traces diff passing.otlp.jsonl failing.otlp.jsonl
  traces diff run.otlp.jsonl#branch=a run.otlp.jsonl#branch=b --format json
```
