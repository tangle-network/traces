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
| `pi` | `~/.pi/agent/sessions/<cwd>/*.jsonl` | verified |
| `kimi` (`kimi-code`) | `~/.kimi/sessions/<cwd hash>/<session id>/wire.jsonl` | verified |
| `factory` (`factory-droids`, `droid`) | `~/.factory/sessions/<cwd>/*.jsonl` + `.settings.json` sidecar | verified |

Every adapter captures the conversation stored in one session file: the **user's prompt** and the **assistant's response** text, plus tool calls/results and token usage.
Claude Code, Codex, current OpenCode, Pi, Kimi, and Factory read native records through [`@tangle-network/harness-sessions`](https://github.com/tangle-network/agent-sdk/tree/main/packages/harness-sessions); traces adds conversation and workflow spans over its model and tool calls. Historical OpenCode JSON sessions remain readable through the older adapter because their IDs do not overlap the SQLite store. Kimi's wire log has no served-model field, so its model remains unknown rather than being guessed.
Claude Code's nested subagent files are folded into the parent trace.
Claude Code's stream-json output also records the tools the harness offered the model and whether the run failed.
The root span keeps them as `gen_ai.tool.definitions` and `run.status`, so a trace contract can check what the harness enforced.
Exported native-session span IDs derive deterministically from the session and record IDs.
The adapter preserves Claude source UUIDs in `traces.claude.source_*` attributes and derives valid OTLP IDs for the exported graph.
The Claude transcript proves turns and tool calls, but does not prove loop iterations or causal links, so those fields remain absent.
Codex stores each worker in a separate session file; a named session brings the workers it spawned.
Factory stores token totals in `.settings.json`, not per turn.
ACP-only bridges may not persist a local transcript.

## Choose sessions

Every harness is read unless `--harness` names one.
A named session (a ref or `--current`) and a `--last` selection bring each session's spawned children, up to 100: the named session is `sessions[0]`, and each child follows it in the order it started, with `parentSessionId`. No number of the named session includes a child's. A child named alone is read without its parent.
`--latest-turn` keeps a long-lived resumed Codex or Claude Code session scoped to its most recent task and the workers spawned from that task.

`--last` follows recent file activity across every harness and never selects the caller's own session (`CODEX_THREAD_ID`, else `CLAUDE_CODE_SESSION_ID`).
`--current` is that session; on a harness that sets neither variable, `traces list --cwd . --last 1` names it.
Omit `--latest-turn` when the full history of a resumed session is the intended unit.
In a window, `--last` or a machine-wide selection, a session that cannot be read is skipped and named in `selection.unreadSessions` with its reason; a named session that cannot be read exits 2.
Children are found by session ID, or by the task path a child records beside its parent's ID, never by timestamps or worker names.
Missing files, duplicate IDs, contradictory parents, and cycles are reported explicitly.
Claude Code subagent files are already folded into their parent trace, so a Claude session reads as one session.
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
