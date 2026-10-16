# Export to OpenInference

[traces](../README.md#docs) › Export to OpenInference

If you already have event captures on disk, convert them to contract OTLP-JSONL, the OpenInference span shape every traces command reads:

```bash
traces convert sandbox-events.json --out spans.otlp.jsonl
```

`traces convert` sniffs its input and accepts:

- JSON arrays with `start`, `raw`, `result`, `done`, and `error` events. A tool call becomes one span, keyed by its message part id, however many events report on that part. The Sandbox SDK records each call as a `message.part.updated` event and again as the harness's raw `tool_use` event. The span takes its start from the part's first event, its final state from the last, and `ERROR` if any event reported one. The root span's `traces.event.tool_part_updates_merged` counts the events folded in.
- existing OpenInference JSONL, rewritten through the local redaction path
- a Sandbox live stream (`"backend":"codex"` envelopes), read as `codex-exec`; `--harness codex-exec` forces that reader

Without `--out` the spans go to stdout. Run `traces convert --help` for the full command reference.

The 0.x `index`, `inspect`, `evidence` and `export` commands are removed: `traces list --format json` lists sessions, `traces analyze <ref>` ranks findings, `traces facts <ref> --format json` states each session's numbers, and `traces convert` converts. `traces help moved` prints every replacement.
