# traces

> What your coding agents did, where they wasted time, and whether a run passes: exact answers from the sessions Claude Code, Codex, OpenCode, Pi, Kimi and Factory already write to disk, or from the OTLP spans your own system emits. A CLI and an SDK.

![traces analyzing a real Claude Code session](https://raw.githubusercontent.com/tangle-network/traces/main/docs/demo.gif)

[![npm](https://img.shields.io/npm/v/@tangle-network/traces.svg)](https://www.npmjs.com/package/@tangle-network/traces)
[![license](https://img.shields.io/npm/l/@tangle-network/traces.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@tangle-network/traces.svg)](https://nodejs.org)

Every command except `ask` runs locally, with no key and no cost. Agents: run traces, never parse a session store yourself; the [`inspect-agent-traces`](skills/inspect-agent-traces/SKILL.md) skill maps each question to its command.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/tangle-network/traces/main/install.sh | bash
npm i @tangle-network/traces    # as a library
```

Requires Node 22 or later. `install.sh` refuses to overwrite another program's `traces` and names it. Coming from 0.x: [Migrate to 1.0](docs/migrate-1.0.md).

## Quick start

```bash
traces list --cwd . --last 5                     # which sessions ran here
traces facts --current                           # what this session did: turns, PRs, first failure, cost, $0
traces facts --since 30d --match 'pnpm test'     # did we already try X
traces analyze 019a3c7e                          # where it wasted time, ranked
traces check run.jsonl --contract contract.json  # fail CI when a run took a forbidden path
```

## Commands

| Job | Command | Page |
|---|---|---|
| Compare workflow topologies | `graphs` | [Graph corpus](docs/graphs.md) |
| Find a session | `list` | [Refs, selection and harnesses](docs/select.md) |
| What happened, exactly, for $0 | `facts` | [Session facts](docs/facts.md) |
| What went wrong, ranked, for $0 | `analyze` | [Analyze a session](docs/analyze.md) |
| A question facts cannot answer, with checked citations | `ask` | [Ask a question](docs/ask.md) |
| The one gate: contracts, conformance, share safety | `check` | [Check](docs/check.md) |
| Where two runs split | `diff` | [Diff two runs](docs/diff.md) |
| Live supervision of sessions or a run tree | `watch` | [Watch](docs/watch.md) |
| Hand spans to another tool | `convert` | [Convert](docs/convert.md) |
| Keep a session's evidence | `bundle` | [Session bundle](docs/bundle.md) |
| Send redacted sessions to Intelligence | `upload` | [Upload](docs/upload.md) |
| Which skills are used | `skills` | [Skill usage](docs/skills.md) |
| Span tools for an MCP client with no shell | `mcp` | [MCP server](docs/mcp.md) |

Each page embeds its command's `--help`, and `tests/docs-help.test.ts` holds them equal to the CLI.

```text
traces: what your agents did, where they wasted time, whether a run passes
Start here for one session: traces facts <ref> (25 lines); one field: add --format json | jq '<path>'

  Which graph topologies delivered?                traces graphs [--registry DIR]
  Which sessions ran?                              traces list [--cwd .] [--last N]
  What happened (turns, PRs, failure, cost)? $0    traces facts <ref> | --current | --since 1d
  Did we already try X / what was said? $0         traces facts <ref> | --since 30d --match '<re>'
  Where did it waste time or get interrupted? $0   traces analyze <ref>
  A question facts can't answer (model, $)         traces ask <ref> --question "…" --budget 1
  Does this run pass? (CI)                         traces check <ref> --contract c.json|conformance
  Is this safe to share?                           traces check <path> --share-safe
  Where did two runs diverge?                      traces diff <a> <b>
  What is happening right now?                     traces watch [<run-dir>] [--once]
  Keep a session's evidence                        traces bundle <ref> --out <dir> · bundle verify <dir>
  Hand spans to another tool                       traces convert <ref> --out <file>
  Ship sessions to Intelligence                    traces upload <ref>|--since T [--dry-run]
  Which skills are used?                           traces skills [--unused]
  Serve span tools over MCP                        traces mcp <ref>|--last N

ref: session id, or 8+ char unique prefix or suffix; session file; OTLP file/dir; bundle dir; run dir; store root
Select: --current  --last N  --since/--until 2h|1d|ISO  --cwd DIR  --harness ID  --latest-turn
Output: --format text|json|jsonl|junit|github  --out PATH  --no-content
Exit: 0 yes · 1 no (fail, diverged, unsafe) · 2 could not answer (stderr says why)
traces <command> --help for flags, jq paths and examples · moved from 0.x: traces help moved
```

## Library

```ts
import { computeSessionFacts, readOtlpInput } from '@tangle-network/traces'

const input = await readOtlpInput('spans.otlp.jsonl')   // or a directory
console.log(input.validation.capabilities)             // what this trace can answer
const [facts] = computeSessionFacts(input.spans)
```

The SDK is named functions and types, one engine per command: [Library (SDK)](docs/sdk.md). Runnable code is in [examples](examples/README.md).

## Docs

- **Commands:** the pages in the table above.
- **Reference:** [Library (SDK)](docs/sdk.md) · [Migrate to 1.0](docs/migrate-1.0.md) · [Parsers outside traces](docs/parsers.md)
- **Contribute:** [Develop and release](docs/develop.md): local setup, releases and how quality is measured
