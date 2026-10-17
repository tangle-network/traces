# Parsers outside traces

[traces](../README.md#docs) › Parsers outside traces

The hill: agents and operators answer every question about an agent session with `traces` and never write a transcript parser. This census lists every hand-written session parser outside traces, the command that replaces it, and the step that deletes it. A consumer PR deletes a fork only when its row in [`bench/parity/forks.json`](../bench/parity/forks.json) passes its tolerance.

## How it ran (2026-10-17)

On each default branch after `git fetch`: `git grep -lE 'tool_use|response_item|event_msg' origin/<default> -- . ':!*test*' ':!*fixture*' ':!docs/*' ':!*.md' ':!*.json' ':!*.jsonl'`, then every hit read and classified. Branches: dotfiles `main` b9049ca, tangle-tools `main` 1cf9239, agent-dev-container `develop` ec55d0b319, discovery-lab `master` 8fbaa456c, agent-eval `main` 16307dc8, agent-runtime `main` 89b09c8b, agent-sdk `main` 08bf6e8, trustgate `main` f7f91bd (no hits).
`have claude project session parser` searched 198 repositories at their default branch and found nothing the grep missed. Two parsers (11, 12) read Kimi, Pi and OTLP files and match no pattern; they are listed by name.
80 hits: 33 parsers and 47 that are not. With the 2 found by name: **35 parsers today, 26 after the 1.0 consumer PRs (steps 22 to 30), 22 after 1.1.**

## Parsers

| # | Repo: path | What it reads | Retired by | Release (step) |
|---|---|---|---|---|
| 1 | dotfiles: `claude/skills/reflect/scripts/self-audit` | rework and rule breaches in Claude Code and Codex files | counts: `facts` waste (U4); rules: `check --contract` (U16) | 1.0 (23); 1.1 |
| 2 | dotfiles: `claude/tools/halo-extract.mjs` | HALO profile measures | `facts` (U4) | 1.0 (23) |
| 3 | dotfiles: `claude/tools/wf-status` | Claude Code workflow runs | `watch` on workflow runs (U17) | 1.1 |
| 4 | dotfiles: `claude/tools/skill_ledger/core.py` | PRs, human turns, tokens per skill run | `facts <session_id>` (U2, U3, U4) | 1.0 (23) |
| 5 | dotfiles: `claude/skills/voice-ledger/scripts/multi_extract.py` | every harness's turns | `facts --format jsonl` (U2, U3) | 1.0 (23) |
| 6 | dotfiles: `claude/analysis/wait-loss/scan_waits.py` | gaps between records | `facts` stalls (U4) | 1.x |
| 7 | dotfiles: `claude/analysis/wait-loss/loss.py` | wait loss per session | `facts` stalls (U4) | 1.x |
| 8 | tangle-tools: `trace-insights/mine/analyst/extract.mjs` | turns for the meta-analyst | `facts --format jsonl` (U3) | 1.0 (25) |
| 9 | tangle-tools: `trace-insights/trace_insights/claude_adapter.py` | Claude Code to spans | `convert` | 1.0 (25) |
| 10 | tangle-tools: `trace-insights/trace_insights/codex_adapter.py` | Codex to spans | `convert` | 1.0 (25) |
| 11 | tangle-tools: `trace-adapters/adapt.py` | Kimi and Pi wire logs to spans | `convert` | 1.0 (25) |
| 12 | tangle-tools: `trace-adapters/flatten.py` | collector OTLP files to rows | OTLP refs (U10) | 1.0 (25) |
| 13 | tangle-tools: `fleet/recurrence.py` | Codex homes: tokens, topics | `facts --format json` (U2, U3) | 1.0 (25) |
| 14 | tangle-tools: `dispatch-eval/extract.py` | dispatch rows | `facts` | 1.x |
| 15 | tangle-tools: `lineage/lineage_collect.py` | the lineage graph | `facts` | 1.x |
| 16 | tangle-tools: `trace-insights/mine/outputs/distill/harvest.py` | distilled turns | `facts --format jsonl` | 1.x |
| 17 | agent-runtime: `src/runtime/codex-rollout-store.ts` | Codex rollouts as spend receipts | one parser (U18) | 1.1 |
| 18 | tangle-tools: `fleet/deliver.py` | acknowledgements in agent records | `facts --match` | 1.x |
| 19 | tangle-tools: `fleet/messages.py` | delivery evidence in session records | `facts --match` | 1.x |
| 20 | tangle-tools: `lineage/lineage_outcomes.py` | Bash calls and results per session | `facts` | 1.x |
| 21 | tangle-tools: `lineage/lineage_timeline.py` | Claude Code and Codex timelines | `facts --format jsonl` | 1.x |
| 22 | tangle-tools: `lineage/lineage_workflows.py` | workflow lifecycle journals | `watch` on workflow runs (U17) | 1.1 |
| 23 | tangle-tools: `fleet/weather.py` | Codex rollouts per day | `facts --since` | 1.x |
| 24 | tangle-tools: `trace-archive/catalog.py` | tool and turn counts for the archive catalog | `list --format json`, `facts` over a store root | 1.x |
| 25 | discovery-lab: `runner/readout-transcripts.mjs` | each agent's steps from retained sessions | `facts --format jsonl` | 1.x |
| 26 | discovery-lab: `runner/skill-usage.mjs` | skill use in retained sessions | `facts` `measurements.skills` | 1.x |
| 27 | discovery-lab: `runner/scorecard.mjs` | tool calls and tokens from run streams and archives | `convert`, `facts` | 1.x |
| 28 | discovery-lab: `tools/trace-assess/science.mjs` | its assessor's required Bash calls | `check --contract` | 1.x |
| 29 | discovery-lab: `tools/trace-assess/pdf-source.mjs` | its assessor's required Read call | `check --contract` | 1.x |
| 30 | discovery-lab: `reports/fleet-observability/coverage.mjs` | Task spawns in run records | `facts` subagents | 1.x |
| 31 | discovery-lab: `experiments/wait-cost-smoke/measure.mjs` | a director's per-turn usage | `facts` tokens and stalls | 1.x |
| 32 | agent-dev-container: `products/sandbox/evals/src/local-agent-sessions.ts` | local Claude Code and Codex sessions for evals | `convert`, `facts` | 1.x |
| 33 | agent-eval: `src/contract/intake/code-agent-session.ts` | Claude Code and Codex records for contracts | harness-sessions, as U18 does for traces | 1.x |
| 34 | agent-eval: `src/contract/intake/code-agent-observation.ts` | the same, as observations | harness-sessions | 1.x |
| 35 | agent-eval: `src/supervisor-run/claude-code-reader.ts` | Claude Code supervision trees (U17 extends it) | harness-sessions | 1.x |

The 1.0 consumer PRs retire 2, 4, 5 and 8 to 13 (9 parsers) and the counting half of 1: 35 − 9 = 26. 1.1 retires 1 (rules), 3, 17 and 22: 22 remain, each a 1.x consumer PR for its owner after its parity row passes.
Against the spec's expectation (23 today, 8 after 1.0, 5 after 1.1): this census read seven repositories instead of two, and found 13 parsers no step yet retires (23 to 35), and 5 of the 6 candidates are parsers (18 to 22).

## Read and not a parser

- dotfiles `claude/hooks/secret_scan.py`: a PostToolUse hook's payload, not a store. tangle-tools `fleet/research_observer.py`: the output of its own `claude -p` runs.
- discovery-lab `tools/profile-ablation-report.mjs` (a comment), `reports/fleet-understanding-20261003/index.html` (a report page), `research/raw/sources/disco-research-*.txt` (source text), `prereg/factory-portfolio-20260929/sources/phony/…/{metrics,scorecard}.ts` (a frozen copy of another product), `reports/research-frontier-continuation-20260909/…/capture_usage.py` (a script inside frozen report evidence).
- agent-dev-container: the 18 files under `packages/sdk-provider-*`, `packages/sdk-telemetry/src/sse-parser.ts`, four under `products/sandbox/sdk/src`, `products/sandbox/cli/src/commands/agent-connect.ts`, `products/platform/api/src/lib/openai-compatible-backend.ts`, `products/intelligence/api/src/routes/proxy.ts` and `products/sandbox/evals/src/auto-optimization.ts` drive a harness's live stream or a model API's `tool_use` blocks.
- agent-eval `examples/_shared/openai-compatible-owner.ts` and `src/campaign/external-optimizer-anthropic.ts`; agent-runtime `scripts/lib/full-capacity-acceptance.mjs`, `src/runtime/profile-chat-client.ts`, `src/runtime/sandbox-events.ts` and `src/runtime/supervise/trace-source.ts`; agent-sdk `packages/agent-core` (3 files): live streams and model API blocks. agent-sdk `packages/harness-sessions/src/formats/*`: the shared reader itself.

## Definition differences

- **Tokens of a session with no usage record.** `fleet/recurrence.py` reports 0; `traces facts` reports `tokens.input: null` with its reason, because unknown is null, never 0. On the parity row of 2026-10-08..14 this is the whole disagreement (14 of 16 files equal; 2 Claude Code sessions with no usage record). It is a definition, not a defect: recurrence should read `null` as unknown when it moves to `facts` (step 25).
- **Commands in a Codex code-mode script.** `self-audit` counts each `cmd` inside an `exec` script; `facts` waste counts each tool call's script. Search rows (`--match`) split scripts into single commands.
