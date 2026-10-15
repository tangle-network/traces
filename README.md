# traces

> Point `traces` at any agent trace — OTLP spans your own system emits, or the session logs Claude Code, Codex, OpenCode, Pi, Kimi, Factory and Gemini already write to disk. Get failure-mode and efficiency findings, exact session facts, and a straight answer about what the trace cannot tell you. A CLI *and* an SDK.

![traces analyzing a real Claude Code session](https://raw.githubusercontent.com/tangle-network/traces/main/docs/demo.gif)

[![npm](https://img.shields.io/npm/v/@tangle-network/traces.svg)](https://www.npmjs.com/package/@tangle-network/traces)
[![license](https://img.shields.io/npm/l/@tangle-network/traces.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@tangle-network/traces.svg)](https://nodejs.org)

The deterministic pass runs locally, with no API key and no cost.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/tangle-network/traces/main/install.sh | bash
npm i @tangle-network/traces    # as a library
```

Requires Node ≥ 22. To run without installing: `npx --yes @tangle-network/traces@latest analyze --last 1`.

## Quick start

```bash
traces analyze --harness claude-code --last 1               # where your last session got stuck or wasted tokens
traces facts   --harness claude-code --last 1 --format text # tool calls, turns, PRs, first failure: exact, $0
traces analyze --otlp spans.otlp.jsonl                      # spans from your own system, no adapter
traces check   run.jsonl --contract contract.json           # fail CI when a run took a forbidden path
```

## What do you want to do?

| Goal | Command | Guide |
|---|---|---|
| Find failure modes and waste in a session | `analyze` | [Analyze a session](docs/analyze.md) |
| Get exact facts, each citing its spans | `facts` | [Session facts](docs/facts.md) |
| Ask your own questions, with checked citations | `ask` | [Ask questions](docs/ask.md) |
| Gate CI on the path a run took | `check` | [Gate CI on a trace contract](docs/check.md) |
| Read spans from a system you own | `validate`, `--otlp` | [Integrate your own system](docs/integrate.md) |
| Watch sessions or a run tree while they run | `watch`, `stream` | [Watch and stream](docs/live.md) |
| Find where two runs diverge | `diff` | [Diff two runs](docs/diff.md) |
| Give an agent read-only trace tools | `mcp` | [MCP server](docs/mcp.md) |
| Write a reviewable improvement packet | `improve` | [Improvement engine](docs/improve.md) |
| Count which skills get used | `skills` | [Skill usage](docs/skill-usage.md) |
| Keep one session's evidence after the logs rotate | `bundle` | [Session bundle](docs/bundle.md) |
| Export rows for mining or OpenInference | `index`, `evidence`, `export` | [Index, evidence and export](docs/evidence.md) |
| Upload, or check files before sharing | `upload`, `verify-safe` | [Upload and share safely](docs/upload.md) |
| Prove a finding by replaying it | `replay-verify`, `verify-findings` | [Replay verification](docs/replay-verify.md) |

The common commands and flags are in the [CLI reference](docs/cli.md). `traces --help` lists every command and option, and `traces <command> --help` prints that command's own flags.

## Two ways in

| | Use when | How |
|---|---|---|
| **Emit the contract** | You control the system | Emit [`@tangle-network/agent-trace-contract`](https://github.com/tangle-network/agent-sdk/tree/main/packages/agent-trace-contract) spans, then `traces analyze --otlp <file\|dir>` |
| **Adapters** | You do *not* control the format | `traces analyze --harness <id>` reads a coding agent's own session store; see [Supported harnesses](docs/harnesses.md) |

Emitting the contract is the supported way to integrate a new system. Adapters are the legacy edge: each one translates a format nobody standardised. If you can choose, choose `--otlp`.

## Library

```ts
import { analyzeSpans, readOtlpInput, renderValidation } from '@tangle-network/traces'

const input = await readOtlpInput('spans.otlp.jsonl')   // or a directory
console.log(renderValidation(input.validation, { subject: 'spans.otlp.jsonl', spans: input.spans }))
if (input.validation.ok) await analyzeSpans(input.spans)
```

The CLI is a thin consumer of the SDK. The main exports are in [Library (SDK)](docs/sdk.md), and [`src/index.ts`](src/index.ts) is the complete list. Runnable code is in [examples](examples/README.md).

## Docs

- **Guides:** the pages in the table above.
- **Reference:** [CLI](docs/cli.md) · [Library (SDK)](docs/sdk.md) · [Supported harnesses and session selection](docs/harnesses.md) · [Trace analysts](docs/trace-analysts.md) (engines, custom analysts, benchmarks) · [Agent skills](docs/agent-skills.md)
- **Contribute:** [Develop and release](docs/develop.md) (local setup, releases, the audit benchmark)
