# Analyze a session

[traces](../README.md#docs) › Analyze a session

`traces analyze` reads sessions or OTLP spans and reports where the agent got stuck, burned tokens, or stopped checking its own work.

The **deterministic pass** checks stuck loops, token growth, output decay, missing self-verification, tool failures, and human corrections.
Each supported issue is returned as a finding with evidence, an action, confidence, and a validation plan.
It needs no API key and costs nothing.

Add `--llm` for the **agentic analysts**. `traces` first uses free local signals to choose the smallest useful set: a failure review always runs, while knowledge and edit reviews run only when failures, repeated calls, or corrective feedback support them. They call OpenAI and respect `--budget <usd>`.

Every run also writes a **canonical OpenInference JSONL artifact**.
Use it with [HALO](https://github.com/context-labs/halo), [Hodoscope](https://github.com/ManifoldRG/hodoscope), or any command that reads the file.
See [Model-backed and external analysts](#model-backed-and-external-analysts) below.

## What it finds

The deterministic pass (free, no key) surfaces:

| Finding | Meaning |
|---|---|
| **Stuck loops** | the same tool called N× with identical args and no state change |
| **Monotonic input growth** | full history re-sent every step; context never compressed |
| **Output-length decay** | planning/reasoning per step shrinking as context grows |
| **No self-verification** | state-mutating actions never followed by an eval/inspect/check |
| **Tool mix / retry / error rates** | repeated, retried, and failed tool calls |

`--llm` adds agentic analysts that read the conversation and cluster higher-order failure and improvement signals. They receive the compact deterministic findings first, then share their earlier findings with later analysts. With `traces improve`, the selected analysts and reasons are saved in `result.json` and the report, so another agent can reuse the packet without rereading the raw trace.

## Model-backed and external analysts

Use the local checks by default.
Add a model-backed engine only when the question needs semantic judgment or behavior discovery.

```bash
traces analyze --last 1
traces analyze --last 1 --llm --budget 0.50
traces analyze --last 1 --analyzer halo --analyzer-prompt "find token waste"
traces analyze --all --last 20 --analyzer hodoscope
traces analyze --last 1 --analyzer prime
traces analyze --last 1 --analyzer my-installed-command
```

To ask your own question instead of the built-in kinds, use [`traces ask`](ask.md).

HALO returns a diagnosis report.
Hodoscope samples distinct behaviors and marks every sample `needs_review`.
Prime posts the full span projection to an OpenAI-compatible bridge (`TRACES_PRIME_BRIDGE_URL`, default `http://localhost:4181`) and returns validated findings with span evidence.
An arbitrary command returns a raw report unless its SDK adapter explicitly parses a stricter output type.

Read [Trace analysts](./trace-analysts.md) for the output contract, a minimal custom analyst, and labeled benchmark setup.

In the SDK these are the `ExternalAnalyzer` and `Redactor` interfaces (`haloAnalyzer`, `hodoscopeAnalyzer`, `primeAnalyzer`, `commandAnalyzer`, `commandRedactor`, `applyRedactor`, `runExternalAnalyzers`).
See [`examples/external-engines.ts`](../examples/external-engines.ts).

> The built-in agentic analysts (`--llm`) run on the Tangle router by default: set `TANGLE_API_KEY`.
> `OPENAI_API_KEY` alone targets OpenAI instead, and `OPENAI_BASE_URL` overrides the endpoint for any other OpenAI-compatible gateway.
> `--llm` also needs a Python interpreter with `agent-eval-rpc[dspy]` installed, because agent-eval's model-backed analysts run through the DSPy RLM engine out of process; set `TRACES_PYTHON` to choose the interpreter.
> The bridge protocol is version-locked: install the exact version matching this package's `@tangle-network/agent-eval` dependency (`pip install "agent-eval-rpc[dspy]==$(npm view @tangle-network/traces dependencies.@tangle-network/agent-eval)"`) — a skewed bridge kills every agentic analyst at startup.
> When `--llm` was requested and every agentic analyst fails, `analyze`/`investigate`/`improve` still write the deterministic report, then exit 1 with each analyst's underlying error.
> A requested `--analyzer` behaves the same way: its error is written into the report, and `analyze` then exits 1 naming every external analyzer that failed.
> Every deterministic command — `list`, `analyze` without `--llm`, `convert`, `index`, `inspect`, `export`, `evidence`, `stream`, `watch`, `analyze --supervisor-run-dir` — needs neither a key nor Python.
