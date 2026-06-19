# traces

Point it at your coding-agent session traces and get **failure-mode + efficiency findings** — without instrumenting anything. It reads the logs your harness already writes to disk.

Built for the recurring problem: agents loop, re-send their whole history, stop verifying their own work, and get stuck. `traces` surfaces that from the trace, deterministically.

```bash
npx @tangle-network/traces analyze --harness claude-code --last 1
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
traces list     --harness claude-code --last 20      # discover sessions
traces analyze  --harness codex --last 1             # $0 deterministic report
traces analyze  --all --since 2026-06-18 --out report.md
traces convert  --harness claude-code --last 1 --otlp spans.jsonl   # OTLP only → HALO
traces analyze  --harness claude-code --last 1 --llm  # +agentic (needs OPENAI_API_KEY)
traces watch    --all                                 # live observer: notify on stuck loops (read-only)
traces upload   --since 1h --dry-run                  # redact + dedup + preview, no network
traces upload   --since 24h                           # upload last day to the Intelligence Platform
```

### Options

| Flag | Meaning |
|---|---|
| `--harness <id>` | Harness or alias (default: `claude-code`) |
| `--all` | Sweep every known harness |
| `--last <n>` | Most-recent N sessions |
| `--session <path>` | Analyze one explicit session file |
| `--cwd <dir>` | Filter sessions by working directory |
| `--since <t>` | `upload`: window — `30m`/`2h`/`7d` or ISO (default 24h); `analyze`: ISO cutoff |
| `--out <path>` | Write report to a file |
| `--otlp <path>` | OTLP artifact path (also the dry-run upload preview) |
| `--llm` | Enable agentic RLM analysts (needs `OPENAI_API_KEY`) |
| `--budget <usd>` | USD cap for agentic analysts |
| `--dry-run` | `upload`: redact + dedup + preview, do not send |
| `--yes`, `-y` | `upload`: skip the confirmation prompt |
| `--interval <s>` / `--window <m>` | `watch`: poll interval / active-session window |
| `--min-loop <n>` | Identical repeated calls before flagging a loop (default 3) |

**Upload** redacts PII/secrets *before anything leaves the machine*, dedups against already-uploaded sessions, and tags each session with metadata (harness, cwd, git branch, host). It needs the platform env: `TANGLE_INGEST_URL` (or `TANGLE_ORCHESTRATOR_URL`), `TANGLE_INGEST_API_KEY` (or `TANGLE_API_KEY`), `TANGLE_TENANT_ID`. Without them, `--dry-run` still works fully.

## Use as a library

The CLI is a thin layer over an exported SDK — build your own tooling on top:

```ts
import {
  watchSessions, collectSessions, analyzeSpans, executeUpload,
  AnalystRegistry, makeFinding, listAdapters,
} from '@tangle-network/traces'
```

**Observe live sessions** and feed findings into your own system (read-only, cancellable):

```ts
const controller = new AbortController()
await watchSessions({
  all: true,
  signal: controller.signal,
  onLoop: (loop) => alertSlack(`stuck loop: ${loop.toolName} ×${loop.occurrences} in ${loop.sessionId}`),
  onReport: (ref, report) => metrics.record(ref.harness, report.toolUse),
})
```

**Run your OWN analysts** (any agent/detector) instead of the built-ins — register against the
[`@tangle-network/agent-eval`](https://www.npmjs.com/package/@tangle-network/agent-eval) `AnalystRegistry`:

```ts
const registry = new AnalystRegistry()
registry.register({
  id: 'my-detector', description: '…', inputKind: 'trace-store',
  cost: { kind: 'deterministic' }, version: '1.0.0',
  async analyze(store, ctx) { /* your logic */ return [makeFinding({ /* … */ })] },
})
const { result } = await analyzeSpans(spans, { registry })
```

**Collect redacted batches** to feed a vector store / fine-tune corpus / another pipeline:

```ts
const batches = await collectSessions({ all: true, sinceMs: Date.now() - 3_600_000 })
//        → [{ ref, spans /* redacted */, redaction }]
```

**Upload to your own backend** (anything implementing `ingestTraces`), not just Tangle:

```ts
await executeUpload(plan, { backend: { async ingestTraces(spans, key) { /* POST anywhere */ return { accepted: spans.length } } } })
```

**Register a new harness** — implement `HarnessTraceAdapter` (`locate` + `parse`) and pass it via
`adapters: [...]` to `watchSessions`/`collectSessions`, or drop a file in `src/adapters/`.

## Develop

```bash
pnpm install
pnpm dev analyze --harness claude-code --last 1   # run from source via tsx
pnpm test
pnpm typecheck
pnpm build        # → dist/index.js (SDK) + dist/cli.js (bin) + .d.ts
```
