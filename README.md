# traces

> Point `traces` at the session logs your coding agent already writes to disk — Claude Code, Codex, OpenCode, Gemini, and more — and get failure-mode + efficiency findings. **Zero instrumentation.** A CLI *and* an SDK.

![traces analyzing a real Claude Code session](https://raw.githubusercontent.com/tangle-network/traces/main/docs/demo.gif)

[![npm](https://img.shields.io/npm/v/@tangle-network/traces.svg)](https://www.npmjs.com/package/@tangle-network/traces)
[![license](https://img.shields.io/npm/l/@tangle-network/traces.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@tangle-network/traces.svg)](https://nodejs.org)

It reads the transcripts your harness leaves on disk, reconstructs the run as spans, and reports where the agent got stuck, burned tokens, or stopped checking its own work — locally, with no API key and no cost for the deterministic pass.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [What it finds](#what-it-finds)
- [Supported harnesses](#supported-harnesses)
- [CLI reference](#cli-reference)
- [Live stream](#live-stream)
- [Improvement engine](#improvement-engine)
- [Session index](#session-index)
- [Policy-mining evidence](#policy-mining-evidence)
- [Upload to the Intelligence Platform](#upload-to-the-intelligence-platform)
- [External engines (bring your own)](#external-engines-bring-your-own)
- [Library (SDK)](#library-sdk)
- [Examples](#examples)
- [Develop](#develop)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/tangle-network/traces/main/install.sh | bash
traces --version

npx --yes @tangle-network/traces@latest analyze --harness claude-code --last 1  # run without installing
npm i -g @tangle-network/traces                                           # install manually
npm i @tangle-network/traces                                              # use it as a library
```

Requires Node ≥ 22.

## Quick start

```bash
traces analyze --harness claude-code --last 1
traces improve --harness claude-code --last 5 --dir .traces/improvement
traces watch --all
traces stream --all --no-spans
```

That's the command in the demo above. The **deterministic pass** — stuck loops, token growth, output decay, missing self-verification, tool monoculture — needs no API key and costs nothing.

Add `--llm` for the **agentic analysts** (failure-mode / knowledge-gap / knowledge-poisoning / improvement); they call OpenAI and respect `--budget <usd>`.

Every run also writes a **canonical OpenInference JSONL artifact**, so you can run external engines like [HALO](https://github.com/context-labs/halo) over it directly with `--analyzer halo` — see [External engines](#external-engines-bring-your-own). Analysis is never locked to one engine.

`traces improve` is the reviewable action path. It writes typed artifacts — findings, recommendations, evidence rows, claims, report, and before/after replay metadata — so another agent, CI job, or hosted product can consume the result without scraping prose.

## What it finds

The deterministic pass (free, no key) surfaces:

| Finding | Meaning |
|---|---|
| **Stuck loops** | the same tool called N× with identical args and no state change |
| **Monotonic input growth** | full history re-sent every step — context never compressed |
| **Output-length decay** | planning/reasoning per step shrinking as context grows |
| **No self-verification** | state-mutating actions never followed by an eval/inspect/check |
| **Tool monoculture / retry / error rates** | the shape of how the agent actually spent its calls |

`--llm` adds agentic analysts that read the conversation and cluster higher-order failure and improvement signals.

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

Every adapter captures the full conversation — the **user's prompt** and the **assistant's response** text, plus tool calls/results and token usage. (`github-copilot` is the one exception: its log format carries no user prompt.) Factory stores token totals in `.settings.json`, not per turn. Forge reads `/dump` JSON exports (live SQLite is a follow-up). ACP-only bridges may not persist a local transcript.

## CLI reference

```bash
traces list     --harness claude-code --last 20    # discover sessions
traces analyze  --harness codex --last 1           # $0 deterministic report
traces investigate --all --last 10 --out report.md  # typed findings + recommendations
traces improve --all --last 10 --dir .traces/improvement
traces analyze  --all --since 2026-06-18 --out report.md
traces convert  --harness claude-code --last 1 --otlp spans.jsonl   # OTLP only
traces index    --all --since 24h --out session-index.json
traces inspect  session-index.json --out inspection-report.md
traces evidence --harness codex --last 20 --out policy-evidence.jsonl
traces export   policy-evidence.jsonl --out spans.openinference.jsonl
traces watch    --all                              # live observer; loops + semantic findings
traces stream   --all --mode findings              # low-volume semantic feed
traces stream   --all --mode agent                 # findings + deterministic report events
traces stream   spans.openinference.jsonl --format openinference --no-spans
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
| `--dir <path>` | `improve`: write the full artifact pack to this directory |
| `--otlp <path>` | OTLP artifact path (also evidence provenance / dry-run upload preview) |
| `--format <kind>` | `export` / file `stream`: `auto`, `policy-evidence`, `sandbox-events`, or `openinference` |
| `--llm` / `--budget <usd>` | Enable agentic analysts (needs `OPENAI_API_KEY`) / cap their spend |
| `--config <path>` | `investigate` / `improve` / `stream`: load BYO analysts, live analysts, external analyzers, and proposal adapters |
| `--interval <s>` / `--window <m>` | `watch` / live `stream`: poll seconds (default 5) / active-session window minutes (default 30) |
| `--min-loop <n>` | Identical repeated calls before flagging a loop (default 3) |
| `--mode <kind>` | `stream`: `visualizer` (spans + findings), `findings` (low-volume), or `agent` (findings + reports) |
| `--replay` / `--once` | `stream`: scan once, then exit |
| `--no-spans` / `--no-findings` | `stream`: suppress raw span rows / finding rows |
| `--no-content` | `upload`: send metadata only — strip all prompt/response text |
| `--dry-run` / `--yes` | `upload`: preview without sending / skip the confirm prompt |

## Live stream

`traces watch` is the human terminal view.
It prints repeated-tool loops and semantic findings while a coding agent is still running.

`traces stream` is the machine feed.
It emits newline-delimited JSON events that a dashboard, art visualizer, local watcher, or hosted product can consume without scraping terminal prose.

```bash
traces stream --all
traces stream --all --mode findings
traces stream --all --mode agent --config traces.config.mjs
traces stream spans.openinference.jsonl --format openinference --no-spans
```

Live streaming emits `session`, `span`, `analysis_batch`, `finding`, and `tick` events; `--mode agent` also emits `report` events.
The semantic findings currently cover repeated failing commands, verification churn without code/config changes, completion claims without later verification, and high tool-error rates.
Use `--mode findings` when you want the low-volume meaning layer; keep `visualizer` for real-time views that need motion, timing, and tool-call texture.
Use `--mode agent` when another agent needs deterministic loop/tool-use reports alongside the findings.

## Improvement engine

`traces improve` turns observed sessions into a portable improvement packet:

```bash
traces improve --all --last 20 --dir .traces/improvement
```

The directory contains:

| File | Purpose |
|---|---|
| `findings.json` | typed `AnalystFinding[]`; finding ids, severity, evidence refs, recommended action, validation plan |
| `recommendations.json` | ranked actions derived from analyst, deterministic, and external findings |
| `evidence.jsonl` | one row per evidence ref, suitable for downstream mining |
| `claims.json` | compact claim list for review agents and dashboards |
| `report.md` | human-readable report rendered from the typed data |
| `replay-before-after.json` | baseline counts plus proposal-only replay metadata |

Bring your own analysts and proposal writer with a config file:

```bash
traces improve --last 5 --config examples/improvement-config.mjs --dir .traces/improvement
```

The config can export:

- `analysts`: deterministic or LLM analysts that implement the `agent-eval` `Analyst` contract
- `liveAnalysts`: deterministic online analysts that implement the `TraceLiveAnalyst` contract for `traces stream`
- `registry`: a prebuilt `AnalystRegistry`
- `externalAnalyzers`: HALO or any command/model adapter that reads the OTLP artifact
- `improvementAdapter`: a proposal writer that maps recommendations to patches, profile edits, prompts, or validation commands

`traces` does not apply patches or open PRs by default. The public engine produces reviewable artifacts; hosted products can decide how to deliver, approve, or apply them.

## Session index

`traces index` writes one general JSON catalog over the selected sessions.
It is meant for deeper investigation and joins with other local data, not for one specific workflow.

```bash
traces index --all --since 24h --out session-index.json
traces inspect session-index.json --out inspection-report.md
```

The index contains:

- selection metadata and aggregate totals
- one row per session with harness, session id, path, cwd, repo labels, and time bounds
- behavior metrics: spans, LLM turns, tool calls, tool errors, tokens, models, and tools
- signal summaries: stuck loops and tool error rate
- nearby context files for joins: `AGENTS.md`, `CLAUDE.md`, and `.evolve` JSONL / reflection artifacts, with markdown heading/ToC and JSONL key summaries

`traces inspect` reads that index back and prints ranked improvement findings over the sessions and nearby context.
It is intentionally read-only: it points to repeated-call loops, high tool-error sessions, missing repo attribution, long docs without Contents, invalid JSONL rows, and skill-run rows that cannot be joined back to a session.

## Policy-mining evidence

`traces` does **not** emit benchmark campaign cells. It emits normalized coding-agent session evidence that another system can mine.

```bash
traces evidence --all --since 24h --out policy-evidence.jsonl --otlp spans.otlp.jsonl
```

Each JSONL row is one session:

- session provenance: harness, session id, cwd, path, mtime
- repo labels: `tangle.subject.key`, `git.repository`, branch, commit
- behavior metrics: span counts, LLM turns, tool calls, errored tool calls, tokens, models, tool histogram
- mining signals: stuck loops and tool error rate
- provenance marker: `notCampaignCell: true`

That boundary matters. `agent-lab` campaign `cells.jsonl` says "arm X beat arm Y on task Z." `traces evidence` says "this real agent session had this repo/model/tool/failure shape." A downstream policy compiler can cluster these rows, propose candidate policies, then validate those policies in a separate eval campaign.

### Export existing evidence/events to OpenInference

If you already have compact evidence or Sandbox/OpenCode event captures on disk, convert them to the same OpenInference JSONL shape that `traces analyze --analyzer halo` uses:

```bash
traces export policy-evidence.jsonl --out spans.openinference.jsonl
traces export sandbox-events.json --format sandbox-events --out spans.openinference.jsonl
halo spans.openinference.jsonl --prompt "Analyze this trace slice" --max-turns 1
```

`traces export` accepts:

- compact `traces.policy_evidence.session` JSONL from `traces evidence`
- Sandbox/OpenCode JSON arrays with `start`, `raw`, `result`, `done`, and `error` events
- existing OpenInference JSONL, rewritten through the local redaction path

Run `traces export --help` for the full command reference.

## Upload to the Intelligence Platform

`upload` **redacts locally before anything leaves the machine**, dedups against already-uploaded sessions, and tags each with metadata (harness, cwd, git branch, host).

```bash
traces upload --since 24h --dry-run     # see exactly what would be sent — no network
traces upload --since 24h --no-content  # send metadata only — drop all prompt/response text
traces upload --since 24h               # send it
```

It needs `TANGLE_INGEST_URL` (or `TANGLE_ORCHESTRATOR_URL`), `TANGLE_INGEST_API_KEY` (or `TANGLE_API_KEY`), and `TANGLE_TENANT_ID`. Without them, `--dry-run` still works fully.

### Redaction scope — read this before uploading prose

Redaction is **best-effort regex** for *structured* secrets and credentials: API keys, GitHub/cloud tokens, JWTs, bearer headers, private-key blocks, `KEY=secret` assignments, and credentials embedded in URLs. It runs over every span attribute, including the captured prompt/response text.

It does **not** catch free-form PII — names, postal addresses, phone numbers in prose — which needs a context-aware model. Three postures, strongest first:

1. **`--no-content`** — upload metadata only (tool calls, tokens, timing, loop signal); no prose leaves the machine.
2. Run an ML PII scrubber (e.g. [`openai/privacy-filter`](https://github.com/openai/privacy-filter)) on the platform ingest side as defense-in-depth.
3. Default — regex redaction of structured secrets.

Always `--dry-run` first to see exactly what would be sent.

## External engines (bring your own)

`traces` hosts analysis engines and PII scrubbers it does **not** bundle — you install the tool, `traces` drives it over a thin command adapter. Same pattern for any future engine or model.

**Analyzers** run over the emitted OTLP artifact as peers to the built-in analysts:

```bash
traces analyze --last 1 --analyzer halo                         # run HALO too
traces analyze --last 1 --analyzer halo --analyzer-prompt "find token waste"
traces analyze --last 1 --analyzer halo --analyzer my-engine    # repeatable
```

Our OTLP artifact is **canonical OpenInference** (top-level `kind`, `resource`, `scope`), so HALO reads it directly — no conversion. HALO runs its *own* LLM (OpenAI client — set `OPENAI_BASE_URL` / `OPENAI_API_KEY`, or use HALO's provider); `--model` is forwarded to it. traces supplies the trace and drives the CLI; it doesn't pay for or configure HALO's model.

**Redactors** scrub prompt/response prose with an external PII model (catching names/addresses the regex pass can't), running *after* the built-in redaction:

```bash
# the command reads a JSON array of strings on stdin, writes the scrubbed array on stdout
traces upload --since 24h --dry-run --redactor "my-pii-scrubber"
```

In the SDK these are the `ExternalAnalyzer` and `Redactor` interfaces (`haloAnalyzer`, `commandAnalyzer`, `commandRedactor`, `applyRedactor`, `runExternalAnalyzers`). See [`examples/external-engines.ts`](./examples/external-engines.ts).

> For the built-in agentic analysts (`--llm`), set `OPENAI_API_KEY` — or point at any OpenAI-compatible gateway with `OPENAI_BASE_URL` (e.g. an internal router) to use a non-OpenAI key.

## Release automation

Merging to `main` publishes a patch release automatically:

1. The Publish workflow bumps `package.json` from `X.Y.Z` to `X.Y.(Z+1)`.
2. It commits `chore(release): vX.Y.(Z+1) [skip release]` back to `main`.
3. It pushes the matching `vX.Y.(Z+1)` tag.
4. The same workflow verifies the tag, builds, publishes to npm, and creates a GitHub release.
5. `pnpm check:package` proves the npm tarball contains the `traces` binary before release.

Minor releases are manual. Run the Publish workflow from GitHub Actions and choose `minor`; it publishes `X.(Y+1).0`. Use manual `patch` only when you need a patch release without merging a new code change.

## Library (SDK)

The CLI is a thin consumer of these exports.

| Export | Signature | Use |
|---|---|---|
| `analyzeSpans` | `(spans, { registry?, ai?, budgetUsd? }) → AnalyzeResult` | run analysts — built-in, or **your own** via `registry` |
| `runTraceInvestigation` | `(TraceInvestigationOptions) → TraceInvestigationResult` | typed findings, recommendations, claims, external analyzer output, and report |
| `runTraceImprovementLoop` | `(TraceImprovementOptions) → TraceImprovementResult` | writes the full improvement artifact pack and optional proposal output |
| `buildTraceFindingPacket` | `({ findings }) → TraceFindingPacket` | turn any `AnalystFinding[]` into recommendations, claims, and a report |
| `runTraceStoreInvestigation` | `({ traceStore }) → TraceStoreInvestigationResult` | run the same packet layer over a hosted/custom `TraceAnalysisStore` |
| `loadTracesConfig` | `(path?) → TracesConfig \| undefined` | load BYO analysts, external analyzers, and proposal adapters |
| `watchSessions` | `(ObserverOptions) → Promise<void>` | live observer; `onLoop` / `onReport` / `signal` / `adapters` |
| `streamSessions` | `(TraceStreamOptions) → Promise<void>` | live JSONL-ready event stream over active sessions |
| `traceStreamEventsFromSpans` | `(spans, opts?) → TraceStreamEvent[]` | replay an existing span list as stream events |
| `analyzeLiveBatch` | `(spans, opts?) → TraceLiveBatch` | compute semantic online findings for one batch |
| `classifyLiveActions` | `(spans) → TraceLiveAction[]` | classify spans once as read/edit/verify/claim/tool/other |
| `defaultTraceLiveAnalysts` | `TraceLiveAnalyst[]` | the built-in online analysts; extend or replace them |
| `collectSessionIndex` | `(ScanOptions) → TraceSessionIndex` | scan sessions and return a reusable JSON-ready catalog |
| `inspectSessionIndex` | `(TraceSessionIndex) → TraceInspectionReport` | rank improvement findings from an index without rescanning sessions |
| `buildPolicyEvidenceRecord` | `(ref, spans, opts?) → PolicyEvidenceRecord` | summarize one session for downstream policy mining |
| `collectPolicyEvidence` | `(ScanOptions) → PolicyEvidenceRecord[]` | scan harness sessions and emit policy-evidence rows |
| `exportTraceEvidenceFile` | `(path, opts?) → { format, spans, redactionCount }` | convert compact evidence/events/OpenInference files to redacted OpenInference spans |
| `scanSessions` | `(ScanOptions) → AsyncIterable<ScannedSession>` | the shared locate→parse iterator |
| `collectSessions` | `(CollectOptions) → SessionBatch[]` | redacted per-session batches for your own pipeline |
| `redactSpans` | `(spans, rules?) → { spans, report }` | PII/secret redaction (`TRACES_REDACTION_RULES`) |
| `planUpload` / `executeUpload` | `(…, { backend? }) → …` | redact + dedup + send to any sink |
| `selectAdapters` / `listAdapters` / `resolveAdapter` | adapter selection + the harness registry |
| `HarnessTraceAdapter` | interface (`locate` + `parse`) | implement to add a harness |
| `ExternalAnalyzer` / `Redactor` | `haloAnalyzer` / `commandAnalyzer` / `commandRedactor` | drive engines/models you install (not bundled) |

```ts
import { watchSessions, streamSessions, analyzeSpans, AnalystRegistry, makeFinding } from '@tangle-network/traces'

// Observe live sessions, feed findings anywhere (read-only, cancellable):
const c = new AbortController()
await watchSessions({ all: true, signal: c.signal, onLoop: (l) => alert(l.toolName, l.occurrences) })

// Feed a visualizer or dashboard:
await streamSessions({ all: true, signal: c.signal, includeSpans: false, onEvent: (event) => console.log(event) })

// Run your own analyst instead of the built-ins:
const registry = new AnalystRegistry()
registry.register({
  id: 'mine', description: '…', inputKind: 'trace-store', cost: { kind: 'deterministic' }, version: '1.0.0',
  async analyze() {
    return [makeFinding({ analyst_id: 'mine', area: 'custom', claim: '…', severity: 'info', evidence_refs: [], confidence: 0.9 })]
  },
})
await analyzeSpans(spans, { registry })
```

## Examples

Runnable, in [`examples/`](./examples):

| File | Shows |
|---|---|
| [`observe-and-alert.ts`](./examples/observe-and-alert.ts) | tail live sessions and alert on stuck loops |
| [`custom-analyst.ts`](./examples/custom-analyst.ts) | register and run your own analyst |
| [`improvement-config.mjs`](./examples/improvement-config.mjs) | plug in BYO analysts and proposal generation for `traces improve` |
| [`custom-backend.ts`](./examples/custom-backend.ts) | redact + dedup + upload to your own sink |
| [`register-harness.ts`](./examples/register-harness.ts) | add a new harness by implementing `HarnessTraceAdapter` |
| [`external-engines.ts`](./examples/external-engines.ts) | drive HALO + an external PII scrubber you install yourself |

## Develop

```bash
pnpm install
pnpm dev analyze --harness claude-code --last 1   # run from source via tsx
pnpm test
pnpm typecheck
pnpm build        # → dist/index.js (SDK) + dist/cli.js (bin) + .d.ts
```
