# 2.0.2

- `traces behavior <ref…> [--window 5m] [--format text|json]`: what each agent did per five-minute window, for any agent-trace-contract producer: a category per window (exploring, implementing, verifying, building, integrating, running, process files, reviewing, communicating, inbound, thinking, idle, looping) with the calibration certificate per class (policy `dl-ui-behavior-windows@1`), failing streaks, stalls, five record-only gaming flags, robust-z anomalies against the run's own nodes, drift per window, and who messaged whom with the recipient's read latency. Exit 2 when no tool spans exist. `behaviorFromSpans`, `classifySpan` and `renderBehaviorText` are exported for the SDK ([behavior](behavior.md)).

This release uses the [local merge gate and existing tag publication path](develop.md).
