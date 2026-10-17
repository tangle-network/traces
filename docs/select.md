# Refs, selection and harnesses

[traces](../README.md#docs) › Refs, selection and harnesses

Every reading command takes refs, or a selection, and the same flags choose sessions everywhere.
`traces list` finds a session: one row per session, newest first, across every harness, never the caller's own.

```bash
traces list --cwd . --last 5
traces facts 019a3c7e                 # a ref list printed
```

## Refs

A ref is sniffed, so no flag names its type:

- an existing path, read by its content: a harness session file (its store root decides the harness, else its first record), a Sandbox live stream (`"backend":"codex"` envelopes, read as `codex-exec`), a sandbox-events recording, contract OTLP-JSONL, standard OTLP/JSON (`resourceSpans`, one document or one envelope per line), `claude -p` stream-json, OpenInference JSONL, a directory of OTLP files, a bundle directory, a Runtime run directory, or a **store root**: a directory that holds harness stores the way a home does, such as a trace archive's `/mnt/traces/<host>/home`;
- otherwise a session id, or a unique prefix or suffix of 8 or more characters, looked up across every harness. An ambiguous ref exits 2 with `code: ambiguous` and lists the candidates.

`file#<traceId>` and `file#branch=<id>` name one run of several. `--harness` with a file ref forces that reader.

## Selection

A reading command needs a ref, `--current`, `--last N` or `--since T`; `--cwd`, `--harness`, `--until` and `--latest-turn` only narrow. `list` defaults to `--last 20`, `watch` to `--since 30m`, `skills` to `--since 30d`.

- `--current` is the caller's own session: `CODEX_THREAD_ID` (Codex) wins, else `CLAUDE_CODE_SESSION_ID`. On Pi, OpenCode or Kimi, `traces list --cwd . --last 1` names it.
- `--last N` is the N session files with the newest mtime, never the caller's own session.
- `--since T` / `--until T` select every session with a record in the window (`30m`, `2h`, `7d`, or an ISO time).
- `--cwd DIR` matches the cwd the session recorded, on a path boundary; a live worktree of the same repo; or, for Codex, the recorded repo of a removed worktree.
- `--latest-turn` keeps a resumed Codex or Claude Code session to its latest task and the workers spawned from it.

A named session brings its spawned children, up to 100: it is `sessions[0]`, each child follows with `parentSessionId`, and no number of the named session includes a child's.
In a window, `--last` or a machine-wide selection, a session that cannot be read is skipped and named in `selection.unreadSessions`; a named ref that cannot be read exits 2 with `code: unreadable`.

## Harnesses

| Harness | Reads from |
|---|---|
| `claude-code` | `~/.claude/projects/<cwd>/*.jsonl` and subagent sidechains, or a `claude -p --output-format stream-json` file |
| `codex` | every Codex home: `~/.codex` and `~/.codex-*` siblings, `$CODEX_HOME`, and `~/.config/agent-accounts/codex/<account>`, each with `sessions/` and `archived_sessions/` |
| `codex-exec` | a `codex exec --json` file or a Sandbox live stream (a file ref) |
| `opencode` | `~/.local/share/opencode/opencode.db`, read in place, and older `storage/` JSON sessions |
| `pi`, `kimi`, `factory` | their session stores under the home |

Native stores are read through [`@tangle-network/harness-sessions`](https://github.com/tangle-network/agent-sdk/tree/main/packages/harness-sessions); `--latest-turn` uses traces' own Claude Code and Codex readers until one parser lands (1.1), and `tests/dual-path.test.ts` holds the two equal.
Claude Code subagent files fold into their parent trace; Codex workers are sessions of their own, joined by the session id or task path a child records.
Unknown is null with its reason, never 0: Kimi's wire log has no served model, so its model stays unknown.

## `traces list --help`

```text
Usage: traces list [<store-root>] [--last N | --since T] [--cwd DIR] [--harness ID] [--format text|json]
Find a session: one row per session, newest first, across every harness, never the caller's own.

  --last N            the N newest sessions (default 20)
  --since T           every session with a record since T: 30m, 2h, 7d or an ISO time
  --cwd DIR           sessions recorded in DIR or under it, or in a worktree of its repo
  --harness ID        only this harness's sessions
  --format text|json  text (default), or json with id, path, bytes and parent id

jq paths (--format json):
  .sessions[].ref                       the short ref any command takes
  .sessions[] | {id, cwd, firstPrompt}  which session is which
  .selection.unreadSessions             sessions that could not be read, and why

Examples:
  traces list --cwd . --last 5
  traces list --since 1d --harness codex
  traces list --format json | jq -r '.sessions[0].id'
```
