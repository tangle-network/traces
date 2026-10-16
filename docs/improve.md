# Improvement engine

[traces](../README.md#docs) › Improvement engine

`traces improve` is the reviewable action path.
It writes one typed result, one report, flattened evidence rows, and the canonical OTLP trace.
Each finding already contains the claim, evidence, recommended action, confidence, and validation plan.

`traces improve` turns observed sessions into a portable improvement packet:

```bash
traces improve --last 20 --dir .traces/improvement
```

The directory contains:

| File | Purpose |
|---|---|
| `result.json` | findings, actions, checks, execution facts, adoption data, and the chosen LLM analysis route |
| `evidence.jsonl` | one row per evidence ref, suitable for downstream mining |
| `report.md` | human-readable report rendered from the typed data |
| `traces.otlp.jsonl` | canonical trace used by the analysts and execution accounting |

Bring your own analysts with a config file:

```bash
traces improve --last 5 --config traces.config.mjs --dir .traces/improvement
```

The config can export:

- `analysts`: deterministic or LLM analysts that implement the `agent-eval` `Analyst` contract
- `liveAnalysts`: deterministic online analysts that implement the `TraceLiveAnalyst` contract for `traces stream`
- `registry`: a prebuilt `AnalystRegistry`

Traces does not pretend that an action is a measured candidate.
Use `agent-eval` to propose and compare candidate changes, `agent-runtime` to package an approved improvement, and `agent-interface` to represent profile edits.
