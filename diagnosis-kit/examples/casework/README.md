# Worked example

## What this is, and what it is not

The kit was run end to end against a real agent session on this machine, producing
`sample-checks-output.json`. That file is a genuine `run-checks.ts` result, not a mock.

It is **not** a Casework run. Casework has never executed an evaluation campaign:
`docs/eval-proof.json` in the legal-underwriting-agent repository reads
`"status": "pending_first_campaign"`. There are no Casework sessions on disk to diagnose.
Running one costs money and needs sandbox credentials, so it is a decision for Drew, not
something this kit should trigger on its own.

The example therefore proves the pipeline, and documents the Casework seam for whoever
runs the first campaign.

## What the real run showed

Eight spans from one session. The result is a good advertisement for selling the coverage
table on day one, because the headline is how little the trace could answer:

| | |
|---|---|
| Capabilities available | 2 of 7 |
| Secrets redacted | 1 |
| Content attributes dropped | 0 (none present) |
| Stuck loops found | 0 across 1 run |

The five unavailable capabilities each came with the trace's own reason, not a guess. For
example, loop-convergence was unavailable because no spans carry `agent.loop.iteration`,
and steering-chain because no spans carry links, so causality between rounds was never
recorded.

**That is the sellable finding.** A customer whose traces support two of seven
capabilities cannot be diagnosed deeply, and telling them so on day one, with the reason
per capability, is worth more than a confident report built on absent data. It also names
their next move: instrument the missing attributes, then come back.

## Reproducing it

```bash
cd /home/drew/code/traces
./node_modules/.bin/tsx src/cli.ts convert --harness codex --last 1 --otlp-out /tmp/real.otlp.jsonl
./node_modules/.bin/tsx diagnosis-kit/checks/run-checks.ts /tmp/real.otlp.jsonl
```

Substitute any harness the adapters cover. `traces list --all` shows what is on the box.

## The Casework seam, for the first campaign

Casework writes a raw sandbox event array, not OTLP:

- `eval/production-executor.ts:182` writes `sandbox-events.json` into the run directory
- runs land under `.artifacts/eval/runs/<ISO timestamp>/<cellId>/`

The traces package reads that shape directly with `--format sandbox-events`, converting
each event to a span (`src/file-export.ts`). So the sequence once a campaign has run is:

```bash
traces convert <runDir>/<cellId>/sandbox-events.json --format sandbox-events --otlp-out casework.otlp.jsonl
./node_modules/.bin/tsx diagnosis-kit/checks/run-checks.ts casework.otlp.jsonl
```

This path is read from the source and has not been executed, because no input file
exists. Treat it as unverified until the first campaign produces one.

Running that campaign needs `EVAL_KEY_BUDGET_USD` set to a verified platform key cap and
either `SANDBOX_API_KEY` or `EVAL_TRIAL_CREDENTIALS_JSON`, and it spends real money:

```bash
EVAL_DATASET=eval/fixtures/smoke.json node eval/cli.mjs
```
