# Diff two runs

[traces](../README.md#docs) › Diff two runs

`traces diff` names the first tool call where two runs of the same task split, and prints both calls.

```bash
traces diff 0199a1b2 0199c3d4                               # two sessions, by id, prefix or suffix
traces diff runs/a/otlp runs/b/otlp                         # two OTLP exports
traces diff a.sdk-events.jsonl b.sdk-events.jsonl           # any file convert reads, a Sandbox live stream included
traces diff spans.otlp.jsonl#<trace id> other.jsonl --format json
traces diff run.otlp.jsonl#branch=arm-a run.otlp.jsonl#branch=arm-b    # two arms of one run
```

A side is any ref that holds one run: a session id or unique 8+ character prefix or suffix, a session file, an OTLP file or directory, `file#<trace id>` for one run of several, or `file#branch=<id>` for one arm: the spans whose `agent.branch.id` or `agent.branch.arm` is `<id>` and have no matched ancestor (a root), and every span below them. When `<id>` names more than one such root subtree, the command refuses (exit 2) and lists each root's span id.

A run's steps are its tool calls, in containment order. Model calls and events are not steps: two runs never word a reply the same way, and that is not where they split.
Each call is compared by tool name, status and an argument fingerprint. The argument is the command a shell call ran, the file a file tool read or wrote, the files a patch touched, or else the call's whole input; the directory a call ran in is not part of it.
Before the fingerprint is taken, each run's own places become placeholders: its working directories (the recorded session cwd and every call's workdir) become `<cwd>`, the worktree that holds them `<worktree>`, temp directories `<tmp>`, and hex ids (UUIDs, and runs of 7+ hex digits that mix digits and letters) `<hex>`. Two runs of one play in two worktrees therefore agree wherever they did the same thing.

Calls pair by position with the same tool, then by tool anywhere (agent-eval's `diffSteps`); span ids pair calls only within one trace. The first divergence is `changed` (argument or status), `replaced` (a different tool), `only-in-a`, `only-in-b` or `reordered`. Text output prints both calls at that step, each normalized and clipped, and a count of the pairs after it. `--format json` holds every step with its normalized `text`; `.diff.firstDivergence.index` is 0-based.

It exits 0 when the runs agree, 1 when they diverge, and 2 when they could not be compared: a side cannot be read, or the calls line up with no difference but there is no outcome to call agreement on (neither run made a tool call, or no call on either side records an OK or ERROR status). With `--format json` that error is one JSON object on stderr with `code: no-outcome`. A CI or agent gate treats exit 2 as unknown, never as a pass.
