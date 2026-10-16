# Analyze a session

[traces](../README.md#docs) › Analyze a session

`traces analyze` reads sessions or OTLP spans and reports where the agent got stuck, burned tokens, or stopped checking its own work.

The **deterministic pass** checks stuck loops, token growth, output decay, missing self-verification, tool failures, and human corrections.
Each supported issue is returned as a finding with evidence, an action, confidence, and a validation plan.
It needs no API key and costs nothing.

Add `--llm` for the **agentic analysts**. `traces` first uses free local signals to choose the smallest useful set: a failure review always runs, while knowledge and edit reviews run only when failures, repeated calls, or corrective feedback support them. They call OpenAI and respect `--budget <usd>`.

Every run also writes a **canonical OpenInference JSONL artifact**.
To hand spans to another tool, write them with `traces convert <ref> --out <file>` and run the tool on that file.

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

## Model-backed analysts

Use the local checks by default.
Add a model-backed engine only when the question needs semantic judgment.

```bash
traces analyze --last 1
traces analyze --last 1 --llm --budget 0.50
```

To ask your own question instead of the built-in kinds, use [`traces ask`](ask.md).

Read [Trace analysts](./trace-analysts.md) for the output contract and a minimal custom analyst ([`examples/custom-analyst.ts`](../examples/custom-analyst.ts)).

> The built-in agentic analysts (`--llm`) run on the Tangle router by default: set `TANGLE_API_KEY`.
> `OPENAI_API_KEY` alone targets OpenAI instead, and `OPENAI_BASE_URL` overrides the endpoint for any other OpenAI-compatible gateway.
> `--llm` also needs a Python interpreter with `agent-eval-rpc[dspy]` installed, because agent-eval's model-backed analysts run through the DSPy RLM engine out of process; set `TRACES_PYTHON` to choose the interpreter.
> The bridge protocol is version-locked: install the exact version matching this package's `@tangle-network/agent-eval` dependency (`pip install "agent-eval-rpc[dspy]==$(npm view @tangle-network/traces dependencies.@tangle-network/agent-eval)"`) — a skewed bridge kills every agentic analyst at startup.
> When `--llm` was requested and every agentic analyst fails, `analyze`/`investigate`/`improve` still write the deterministic report, then exit 1 with each analyst's underlying error.
> Every deterministic command — `list`, `analyze` without `--llm`, `convert`, `index`, `inspect`, `export`, `evidence`, `stream`, `watch`, `analyze --supervisor-run-dir` — needs neither a key nor Python.
