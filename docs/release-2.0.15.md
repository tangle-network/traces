# traces 2.0.15

Publishes [#265](https://github.com/tangle-network/traces/pull/265). `traces behavior` and `traces facts` now show how agents drive other agents: who spawned and messaged whom, on which harness and model, and why a session stopped. A 7-day `behavior` sweep also fits in the default heap.

| Measured on drew-gtr-pro, 2026-11-06 | 2.0.14 | 2.0.15 |
|---|---|---|
| `limitStop` on 56 Claude sessions ending on a limit notice | 10 null, 2 kind `fable` | `monthly` 9, `credits` 2, `weekly` 44; 1 null, whose last reply is not a notice |
| `behavior --since 7d` nodes with `harness: null` | every node | 0 of 1,601 |
| child nodes with 0 tool calls | a phantom one per Codex fork child | 3 of 1,155; 0 of 179 Codex children |
| `behavior --since 7d` peak RSS | out of memory at the 4 GB default heap (4,487,644 KB) | 1,698,892 KB, exit 0 |
| `mail.summary.edges` | 0 | 41,089 |

- `limitStop` now recognises these notices: Claude Code's monthly spend, model and compaction-failed limits, OpenCode's `Usage limit reached for 5 hour`, and Codex's credits notice. `kind` is `weekly`, `monthly`, `session`, `5-hour`, `credits` or `usage`.
- Behavior nodes carry `harness` and `model`, and `facts.subagents[]` entries carry `model`.
- A Codex child hangs under its parent's node.
- Mail edges come from Codex `spawn_agent`, `send_message` and `followup_task`, from Claude Code subagent spawns and `SendMessage`, and from `fleet send` commands.
- New: `traces facts --since 30d --match '^fleet ([a-z-]+)' --count` counts fleet verbs. `--count` gives each value of the pattern's first capture group its count and its first and last time.

Two gaps remain, both in the producers rather than in traces:

- **Fleet mail.** Fleet records each message only in `graph.sqlite`. Delivery and reads reach no trace until fleet emits a `fleet.message` span with these attributes: `session.id`, `fleet.message.id`, `.sender`, `.recipient`, `.project`, `.delivery` and `.origin`.
- **Codex `/goal`.** Rollouts carry `thread_goal_updated` but never the `/goal` turn and never a goal's final status, which `goals_1.sqlite` holds alone. So `facts.goals` waits on Codex and on harness-sessions.
