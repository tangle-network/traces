# Diff two runs

[traces](../README.md#docs) › Diff two runs

`traces diff` pairs the steps of two runs of the same task and marks where they first stop agreeing.

```bash
traces diff runs/a/otlp runs/b/otlp                     # two OTLP exports
traces diff a.sdk-events.jsonl b.sdk-events.jsonl --kind TOOL   # any file convert reads; tool calls only
traces diff spans.otlp.jsonl#<trace id> other.jsonl --format json
traces diff run.otlp.jsonl#branch=arm-a run.otlp.jsonl#branch=arm-b    # two arms of one run
```

A side is a file or directory that holds one run, `file#<trace id>` for one run of several, or `file#branch=<id>` for one arm: the spans whose `agent.branch.id` or `agent.branch.arm` is `<id>` and have no matched ancestor (a root), and every span below them. Sibling arms can share a branch id or label; when `<id>` names more than one such root subtree, the command refuses (exit 2) and lists each root's span id, rather than silently comparing the union of both.
Steps pair by span id first, then by position with the same name and kind, then by name and kind anywhere.
One inserted step therefore does not mark every later step as changed.
Paired steps compare status, tool and model.
The first divergence is `changed`, `replaced`, `only-in-a`, `only-in-b` or `reordered`, with its reason, followed by every changed and unpaired step.
`--kind` keeps only steps of that span kind, so event noise in a raw stream does not decide the first divergence.
The diff is agent-eval's `diffSteps`; this command reads the runs and prints it.
It exits 0 when the runs agree on outcome, 1 when they diverge, 2 when a side cannot be read (including an ambiguous `#branch=` selector), and 3 when the steps line up with no divergence but there is no recorded outcome to call agreement: neither side has a step with a definitive OK/ERROR status (both are entirely UNSET, the common shape for a capture that failed before any status was written), or neither side has a TOOL step. That case's report and text output carry a `caveat` naming which reason applies; a CI or agent gate should treat exit 3 as unknown, not as a pass.
