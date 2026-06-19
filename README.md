# tangle-traces

Point it at your coding-agent session traces and get **failure-mode + efficiency findings** — without instrumenting anything. It reads the logs your harness already writes to disk.

Built for the recurring problem: agents loop, re-send their whole history, stop verifying their own work, and get stuck. `tangle-traces` surfaces that from the trace, deterministically.

```bash
npx tangle-traces analyze --harness claude-code --last 1
```

## What it does

1. Reads a harness's native session log (no OpenTelemetry setup required).
2. Normalizes it to OTLP-JSONL — the shape the [`@tangle-network/agent-eval`](https://www.npmjs.com/package/@tangle-network/agent-eval) analyst suite *and* [HALO](https://github.com/context-labs/halo) consume.
3. Runs the analysts and writes a markdown report.

The deterministic pass (token-growth, output-decay, tool-monoculture, missing self-verification) needs **no API key and costs nothing**. Add `--llm` for the agentic RLM analysts (failure-mode / knowledge-gap / knowledge-poisoning / improvement).

## Supported harnesses

Covers the coding-agent CLIs in the agent-dev-container nix profile. "Verified" = parser exercised against real on-disk sessions; "fixture" = parser exercised against a schema-accurate fixture (no local sessions to test); see the test suite.

| Harness (aliases) | Reads from | Status |
|---|---|---|
| `claude-code` (`claudish`, `openclaw`, `nanoclaw`) | `~/.claude/projects/<cwd>/*.jsonl` (+ subagent sidechains) | verified |
| `codex` (`codex-acp`) | `~/.codex/sessions/**/rollout-*.jsonl` | verified |
| `opencode` | `~/.local/share/opencode/storage/` | verified |
| `gemini` (`gemini-cli`) | `~/.gemini/tmp/<hash>/chats/session-*.json` | verified |
| `pi` | `~/.pi/agent/sessions/<cwd>/*.jsonl` | verified |
| `factory` (`factory-droids`, `droid`) | `~/.factory/sessions/<cwd>/*.jsonl` + `.settings.json` sidecar | locate verified, parse fixture |
| `qwen` (`qwen-code`) | `~/.qwen/projects/<cwd>/chats/*.jsonl` | fixture |
| `amp` | `~/.local/share/amp/threads/T-*.json` | fixture |
| `github-copilot` (`copilot`) | `~/.copilot/session-state/<id>/events.jsonl` | fixture |
| `forge` (`forgecode`) | `/dump` JSON exports (live `~/.forge/.forge.db` SQLite is a follow-up) | fixture |

Notes: Factory's token totals live in the `.settings.json` sidecar (no per-turn usage). Forge's primary store is SQLite; v1 reads its dependency-free `/dump` exports. ACP-only bridges (`claude-agent-acp`) may not persist a local transcript at all.

Adding a harness is one file implementing `HarnessTraceAdapter` (`locate` + `parse`) in `src/adapters/`.

## Commands

```bash
tangle-traces list     --harness claude-code --last 20      # discover sessions
tangle-traces analyze  --harness codex --last 1             # $0 deterministic report
tangle-traces analyze  --all --since 2026-06-18 --out report.md
tangle-traces convert  --harness claude-code --last 1 --otlp spans.jsonl   # OTLP only → HALO
tangle-traces analyze  --harness claude-code --last 1 --llm  # +agentic (needs OPENAI_API_KEY)
```

### Options

| Flag | Meaning |
|---|---|
| `--harness <id>` | Harness or alias (default: `claude-code`) |
| `--all` | Sweep every known harness |
| `--last <n>` | Most-recent N sessions |
| `--session <path>` | Analyze one explicit session file |
| `--cwd <dir>` | Filter sessions by working directory |
| `--since <iso>` | Only sessions modified since this time |
| `--out <path>` | Write report to a file |
| `--otlp <path>` | OTLP artifact path |
| `--llm` | Enable agentic RLM analysts (needs `OPENAI_API_KEY`) |
| `--budget <usd>` | USD cap for agentic analysts |

## Develop

```bash
pnpm install
pnpm dev analyze --harness claude-code --last 1   # run from source via tsx
pnpm test
pnpm typecheck
pnpm build        # → dist/cli.js (the published bin)
```
