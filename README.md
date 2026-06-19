# traces

Analyze your coding-agent session logs for failure modes — stuck loops, token bloat, dropped self-verification — with zero instrumentation. It reads the logs your harness (Claude Code, Codex, OpenCode, …) already writes to disk.

`traces` is a CLI and an SDK: run it ad-hoc, or build on it.

## Install

```bash
npm i -g @tangle-network/traces     # the `traces` CLI
npx @tangle-network/traces analyze  # or run without installing
npm i @tangle-network/traces        # or use it as a library
```

## Quick start

```bash
traces analyze --harness claude-code --last 1
```

```
# Trace report — claude-code · 1 session · 2,429 spans

## Stuck loops
- `bash` ×7 with identical args in 48s   (same git status retried, no state change)

## Tool use
- 1,204 tool calls · duplicate-call 22% · retry 6% · error 8%
```

The deterministic pass (stuck loops, token growth, tool monoculture, missing self-verification) needs no API key and costs nothing. Add `--llm` for the agentic analysts (failure-mode / knowledge-gap / knowledge-poisoning / improvement); they call OpenAI and respect `--budget`.

The written OTLP-JSONL artifact also feeds [HALO](https://github.com/context-labs/halo) (`halo spans.jsonl -p "diagnose"`) — analysis is never locked to one engine.

## Supported harnesses

"Verified" = tested against real sessions; "fixture" = tested against schema-accurate fixtures (no real sessions available).

| Harness (aliases) | Reads from | Status |
|---|---|---|
| `claude-code` (`claude`, `claudish`, `openclaw`, `nanoclaw`) | `~/.claude/projects/<cwd>/*.jsonl` (+ subagent sidechains) | verified |
| `codex` (`codex-acp`) | `~/.codex/sessions/**/rollout-*.jsonl` | verified |
| `opencode` | `~/.local/share/opencode/storage/` | verified |
| `gemini` (`gemini-cli`) | `~/.gemini/tmp/<hash>/chats/session-*.json` | verified |
| `pi` | `~/.pi/agent/sessions/<cwd>/*.jsonl` | verified |
| `factory` (`factory-droids`, `droid`) | `~/.factory/sessions/<cwd>/*.jsonl` + `.settings.json` sidecar | locate verified, parse fixture |
| `qwen` (`qwen-code`) | `~/.qwen/projects/<cwd>/chats/*.jsonl` | fixture |
| `amp` | `~/.local/share/amp/threads/T-*.json` | fixture |
| `github-copilot` (`copilot`) | `~/.copilot/session-state/<id>/events.jsonl` | fixture |
| `forge` (`forgecode`) | `/dump` JSON exports | fixture |

Factory stores token totals in `.settings.json`, not per turn. Forge reads `/dump` JSON exports (live SQLite is a follow-up). ACP-only bridges may not persist a local transcript.

## Commands

```bash
traces list     --harness claude-code --last 20    # discover sessions
traces analyze  --harness codex --last 1           # $0 deterministic report
traces analyze  --all --since 2026-06-18 --out report.md
traces convert  --harness claude-code --last 1 --otlp spans.jsonl   # OTLP only
traces watch    --all                              # live observer; notify on stuck loops
traces upload   --since 1h --dry-run               # redact + dedup + preview, no network
traces upload   --since 24h                        # upload last day to the Intelligence Platform
```

| Flag | Meaning |
|---|---|
| `--harness <id>` | Harness or alias (default: `claude-code`) |
| `--all` | Every known harness |
| `--last <n>` | Most-recent N sessions |
| `--session <path>` | One explicit session file |
| `--cwd <dir>` | Filter by working directory |
| `--since <t>` | `upload`: window — `30m`/`2h`/`7d` or ISO (default 24h); `analyze`: ISO cutoff |
| `--out <path>` | Write the report to a file |
| `--otlp <path>` | OTLP artifact path (also the dry-run upload preview) |
| `--llm` / `--budget <usd>` | Enable agentic analysts (needs `OPENAI_API_KEY`) / cap their spend |
| `--interval <s>` / `--window <m>` | `watch`: poll seconds (default 5) / active-session window minutes (default 30) |
| `--min-loop <n>` | Identical repeated calls before flagging a loop (default 3) |
| `--dry-run` / `--yes` | `upload`: preview without sending / skip the confirm prompt |

`upload` redacts PII/secrets locally before anything leaves the machine, dedups against already-uploaded sessions, and tags each with metadata (harness, cwd, git branch, host). It needs `TANGLE_INGEST_URL` (or `TANGLE_ORCHESTRATOR_URL`), `TANGLE_INGEST_API_KEY` (or `TANGLE_API_KEY`), and `TANGLE_TENANT_ID`; without them, `--dry-run` still works.

## Use as a library

The CLI is a thin consumer of these exports. Full runnable examples in [`examples/`](./examples).

| Export | Signature | Use |
|---|---|---|
| `analyzeSpans` | `(spans, { registry?, ai?, budgetUsd? }) → AnalyzeResult` | run analysts — built-in, or **your own** via `registry` |
| `watchSessions` | `(ObserverOptions) → Promise<void>` | live observer; `onLoop` / `onReport` / `signal` / `adapters` |
| `collectSessions` | `(CollectOptions) → SessionBatch[]` | redacted per-session batches for your own pipeline |
| `redactSpans` | `(spans, rules?) → { spans, report }` | PII/secret redaction (`TRACES_REDACTION_RULES`) |
| `planUpload` / `executeUpload` | `(…, { backend? }) → …` | redact + dedup + send to any sink |
| `listAdapters` / `resolveAdapter` | `() → […]` / `(id) → adapter` | the harness registry |
| `HarnessTraceAdapter` | interface (`locate` + `parse`) | implement to add a harness |

```ts
import { watchSessions, analyzeSpans, AnalystRegistry, makeFinding } from '@tangle-network/traces'

// Observe live sessions, feed findings anywhere (read-only, cancellable):
const c = new AbortController()
await watchSessions({ all: true, signal: c.signal, onLoop: (l) => alert(l.toolName, l.occurrences) })

// Run your own analyst instead of the built-ins:
const registry = new AnalystRegistry()
registry.register({ id: 'mine', description: '…', inputKind: 'trace-store', cost: { kind: 'deterministic' }, version: '1.0.0',
  async analyze() { return [makeFinding({ analyst_id: 'mine', area: 'custom', claim: '…', severity: 'info', evidence_refs: [], confidence: 0.9 })] } })
await analyzeSpans(spans, { registry })
```

Add a new harness: implement `HarnessTraceAdapter` and pass it via `adapters: [...]` to `watchSessions`/`collectSessions`, or drop a file in `src/adapters/`. See [`examples/register-harness.ts`](./examples/register-harness.ts).

## Develop

```bash
pnpm install
pnpm dev analyze --harness claude-code --last 1   # run from source via tsx
pnpm test
pnpm typecheck
pnpm build        # → dist/index.js (SDK) + dist/cli.js (bin) + .d.ts
```
