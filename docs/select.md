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

- an existing path, read by its content: a harness session file (its records identify the format and its store distinguishes shared formats), a Sandbox live stream (`"backend":"codex"` envelopes, read as `codex-exec`), a sandbox-events recording, contract OTLP-JSONL, standard OTLP/JSON (`resourceSpans`, one document or one envelope per line), `claude -p` stream-json, OpenInference JSONL, a directory of OTLP files, a tree of harness session files (each read by its content, anything else in it skipped, and an earlier byte-prefix copy of a session under the same name dropped), a bundle directory, a Runtime run directory, or a **store root**: a directory that holds harness stores the way a home does, such as a trace archive's `/mnt/traces/<host>/home`;
- a **run id**: the name of a Runtime run directory under a configured run root, such as `traces behavior claim-queens-cube-20261117a` on a host whose runs live in `/mnt/traces/discovery-runs`;
- otherwise a session id, or a unique prefix or suffix of 8 or more characters, looked up across every harness. An ambiguous ref exits 2 with `code: ambiguous` and lists the candidates.

Run roots and remotes come from `TRACES_RUN_ROOTS` (directories joined by `:`) and `TRACES_REMOTES` (SSH hosts, comma or space separated), else from `${XDG_CONFIG_HOME:-~/.config}/traces/config.json`, which `install.sh --run-root DIR --remote HOST` writes. A bare ref that names no path, run or session here runs, argv unchanged, on each remote in turn over SSH (`ssh -o BatchMode=yes`, or `TRACES_SSH`) until one holds it; that host reads its own records, and its output and exit code are the command's. A remote that ssh cannot reach or that has no traces installed is skipped and named if none answers. `--out` writes on this machine, so a ref only a remote holds refuses it.

`file#<traceId>` and `file#branch=<id>` name one run of several. `--harness` with a file ref selects a compatible reader. A conflicting recording exits 2 as `unreadable`, even when it was copied into the selected harness’s directory. Pi and Prime share a recording format. Their native stores distinguish them; for a loose Prime recording, pass `--harness prime`.

Use `traces facts 'recordings.sqlite#session=ses_example'` to read an exact native session from an OpenCode, Hermes or OpenClaw database, including a relocated copy with its SQLite sidecars. The same ref works with `analyze` and `watch`. A multi-session database without the selector reports its harnesses and available IDs as `ambiguous`; conflicting or unrelated SQLite stores are refused rather than read as OpenCode. NanoClaw's inbound/outbound pair and a one-session database can be named directly. A raw bundle includes every required database and available SQLite sidecar.

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
| `hermes` | `~/.hermes/state.db`: its multi-session catalog and messages |
| `openclaw` | `~/.openclaw/agents/main/agent/openclaw-agent.sqlite`: its own multi-session transcript events, never Claude's store |
| `nanoclaw` | `~/.nanoclaw/data/v2-sessions/*/<id>/{inbound,outbound}.db`: one metadata-only message session per pair, never Claude's store |
| `prime` | `~/.prime-provider/prime-agent-dirs/**/sessions/*.jsonl`, in Prime's Pi record layout with Prime's own session identity |
| `pi`, `kimi`, `factory`, `grok` | their session stores under the home |

Native stores are read through [`@tangle-network/harness-sessions`](https://github.com/tangle-network/agent-sdk/tree/main/packages/harness-sessions)' reader registry. Traces keeps the display names `kimi` and `factory` and the SDK's canonical names and aliases; a newly registered SDK reader needs no manual Traces alias. `--latest-turn` uses traces' own Claude Code and Codex readers until one parser lands (1.1), and `tests/dual-path.test.ts` holds the two equal.
Claude Code subagent files fold into their parent trace; Codex workers are sessions of their own, joined by the session id or task path a child records. An older Claude-format file still reads as `claude-code` from its own records, independently of any app name.
Unknown is null with its reason, never 0: Kimi's wire log and NanoClaw's message stores have no served model, so their models stay unknown.

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
