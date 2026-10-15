# Supported harnesses

[traces](../README.md#docs) › Supported harnesses

Adapters are the **legacy edge**: they exist for coding agents whose on-disk format we do not
control, and each is a translation from a proprietary session store onto the span model. They are
not the way to integrate a system you own — for that, [emit the contract](integrate.md).

"Verified" = tested against real sessions; "fixture" = tested against schema-accurate fixtures (no real sessions available).

| Harness (aliases) | Reads from | Status |
|---|---|---|
| `claude-code` (`claude`, `claudish`, `openclaw`, `nanoclaw`) | `~/.claude/projects/<cwd>/*.jsonl` (+ subagent sidechains), or an explicit `claude -p --output-format stream-json --verbose` JSONL file | verified |
| `codex` (`codex-acp`) | `~/.codex/sessions/**/rollout-*.jsonl` | verified |
| `codex-exec` (`codex-json`) | explicit `codex exec --json` JSONL file | fixture |
| `opencode` | `~/.local/share/opencode/opencode.db` (shared reader), plus historical `storage/` JSON sessions (legacy reader) | verified |
| `gemini` (`gemini-cli`) | `~/.gemini/tmp/<hash>/chats/session-*.json` | verified |
| `pi` | `~/.pi/agent/sessions/<cwd>/*.jsonl` | verified |
| `kimi` (`kimi-code`) | `~/.kimi/sessions/<cwd hash>/<session id>/wire.jsonl` | verified |
| `factory` (`factory-droids`, `droid`) | `~/.factory/sessions/<cwd>/*.jsonl` + `.settings.json` sidecar | verified |
| `qwen` (`qwen-code`) | `~/.qwen/projects/<cwd>/chats/*.jsonl` | fixture |
| `amp` | `~/.local/share/amp/threads/T-*.json` | fixture |
| `github-copilot` (`copilot`) | `~/.copilot/session-state/<id>/events.jsonl` | fixture |

Every adapter captures the conversation stored in one session file: the **user's prompt** and the **assistant's response** text, plus tool calls/results and token usage.
Claude Code, Codex, current OpenCode, Pi, Kimi, and Factory read native records through [`@tangle-network/harness-sessions`](https://github.com/tangle-network/agent-sdk/tree/main/packages/harness-sessions); traces adds conversation and workflow spans over its model and tool calls. Historical OpenCode JSON sessions remain readable through the older adapter because their IDs do not overlap the SQLite store. Kimi's wire log has no served-model field, so its model remains unknown rather than being guessed.
Claude Code's nested subagent files are folded into the parent trace.
Claude Code's stream-json output also records the tools the harness offered the model and whether the run failed.
The root span keeps them as `gen_ai.tool.definitions` and `run.status`, so a trace contract can check what the harness enforced.
Exported native-session span IDs derive deterministically from the session and record IDs.
The adapter preserves Claude source UUIDs in `traces.claude.source_*` attributes and derives valid OTLP IDs for the exported graph.
The Claude transcript proves turns and tool calls, but does not prove loop iterations or causal links, so those fields remain absent.
Codex stores each worker in a separate session file; add `--workflow` to resolve the connected coordinator and worker files.
`github-copilot` is the one exception: its log format carries no user prompt.
Factory stores token totals in `.settings.json`, not per turn.
ACP-only bridges may not persist a local transcript.

## Choose sessions

Without `--workflow`, each selected Codex file is analyzed independently.
With it, `traces` follows stable parent and child session IDs, up to 100 files by default.
`--latest-turn` keeps a long-lived resumed Codex or Claude Code session scoped to its most recent task and the workers spawned from that task.

Use `--max-workflow-sessions <n>` to set a different bound.

`--last` follows recent file activity and may select a child session in multi-agent work.
Use `--harness codex --current --latest-turn --workflow` for the invoking Codex turn plus its connected workers.
Omit `--latest-turn` when the full history of a resumed session is the intended unit.
Workflow expansion follows session IDs, never timestamps or worker names.
For a latest Codex child, it selects the last parent task that structurally spawned or targeted that child ID, then includes only workers referenced by that parent task.
This requires the parent log to record the child ID on a spawn, send, follow-up, or lifecycle event and to associate that event with a stable turn ID.
If either field is absent, the workflow is reported incomplete instead of widening to the parent's full history.
Missing files, duplicate IDs, contradictory parents, and cycles are reported explicitly.
Claude Code subagent files are already folded into their parent trace, so `--workflow` normally resolves one Claude session file.
With `--latest-turn`, ordinary Claude subagents are selected by their parent tool call ID.
Claude Workflow subagents are selected by the run ID and transcript directory returned by the parent `Workflow` call.
Each Workflow child attaches to the latest matching call that started before the child.
Task selection then keeps only children attached to calls in that task.
Returned directories from another resumed Claude session are included in parsing and source hashes.
For a copied Claude session, preserve `<session UUID>/subagents/workflows/<run ID>` beside the parent JSONL file.
Recorded native `.claude/projects/<project>/<session UUID>/subagents/workflows/<run ID>` paths resolve to that copied subtree when outside the selected store.
Copy every referenced Workflow directory, including runs stored under another resumed session UUID.
The original transcript stays unchanged, and child attribution uses its recorded Workflow identity.
Missing copied directories, conflicting source bindings, and symlinks that change the copied session or run identity stop parsing.
Copied Workflow directories contain regular transcript and metadata files; symlink entries stop parsing.
Missing or conflicting Workflow identities stop the parse instead of widening the selected history.
Cross-harness parent/child trees are not inferred.
For a reproducible report, run `traces list` first and pass its session ID with `--session`.
Ephemeral `codex exec --json` output has no discovery location, so select its file with `--harness codex-exec --session <path>`.
The adapter rejects empty, incomplete, or other JSONL formats instead of emitting zero-valued session evidence.
