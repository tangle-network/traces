# CLI reference

[traces](../README.md#docs) › CLI reference

The common commands and flags. `traces --help` lists every command, and `traces <command> --help` prints that command's own flags, jq paths and examples.
A ref names what to read: a session id or an 8+ character unique prefix or suffix, a session file, an OTLP file or directory, a bundle or Runtime run directory, or a store root.
A reading command needs a ref, `--current`, `--last N` or `--since T`; `--cwd` and `--harness` only narrow.

```bash
traces list     --cwd . --last 20                  # one row per session: ref, harness, last activity, turns, cwd, first prompt
traces analyze  <id>                               # pin one ref printed by `list`, on any harness
traces analyze  --current                          # this session (Codex or Claude Code), with its spawned children
traces analyze  --current --latest-turn            # current turn plus the workers it spawned
traces analyze  <path> --harness claude-code --latest-turn  # a session file; latest task plus its subagents
traces analyze  --last 10 --out analysis          # report.md and findings.json under analysis/
traces ask      <id> --question "Which commands failed?" --budget 1
traces facts    <id>                               # the deterministic facts sheet, $0
traces facts    --since 2026-10-14 --until 2026-10-15  # every session with a record that day, that day's turns
traces skills   --since 30d                        # skill use across every local session, incremental, $0
traces diff     run-a.otlp.jsonl run-b.otlp.jsonl  # where two runs of one task first diverge
traces mcp      spans.otlp.jsonl                   # read-only trace tools for an MCP client
traces analyze  --since 2026-06-18 --format json  # facts, findings, measures, conformance, what it cannot answer
traces check    spans.otlp.jsonl --contract c.json --format junit > c.xml  # exit 0 pass, 1 fail, 2 could not decide
traces check    spans.otlp.jsonl --contract conformance  # what the trace can answer; exit 1 only when it is not a trace
traces check    results/sessions --contract conformance > conformance.md  # a whole directory of exports
traces analyze  spans.otlp.jsonl                   # analyse foreign OTLP, no adapter
traces analyze  results/sessions --out analysis
traces convert  --harness claude-code --last 1 --out spans.jsonl   # contract OTLP-JSONL; stdout without --out
traces list     --format json                      # one row per session, with id, path and parent id
traces bundle   <id|path> --out bundle-dir         # one session's durable evidence dir
traces bundle verify bundle-dir                    # every file against its manifest SHA-256
traces facts    bundle-dir --no-content            # a bundle is a ref; this is its evidence without its words
traces convert  sandbox-events.json --out spans.otlp.jsonl  # sandbox events and live streams are sniffed
traces watch                                       # live findings in every session active in the last 30 min
traces watch    --once --format jsonl              # one pass, as traces.stream events
traces watch    runs/my-run                        # live run tree: status, budget, driver vs child spend
traces watch    runs/my-run --once                 # one snapshot, then exit
traces watch    traces.otlp.jsonl                  # any OTLP span file, any emitter
traces analyze  runs/my-run                        # the full tree report
traces upload   --since 1h --dry-run               # redact + dedup + preview, no network
traces upload   --since 24h                        # upload last day to the Intelligence Platform
traces check    bundle-dir --share-safe            # SAFE / SAFE_WITH_WARNINGS / UNSAFE (exit 1) / UNKNOWN (exit 2)
traces help moved                                  # every 0.x command and flag 1.0 removed, and its replacement
```

| Flag | Meaning |
|---|---|
| `--harness <id>` | Read only this harness; the default is every harness. With a file ref, force that harness's reader |
| `--last <n>` | The N sessions with the newest file mtime, never the caller's own |
| `--current` | The caller's own session: `CODEX_THREAD_ID` (Codex) wins, else `CLAUDE_CODE_SESSION_ID` (Claude Code) |
| `--latest-turn` | Limit a resumed Codex or Claude Code session to its latest task turn |
| `--cwd <dir>` | Sessions recorded in `<dir>` or under it on a path boundary, in a live worktree of its repository, or in a removed worktree whose recorded repository (Codex) is its |
| `--since <t>` | `30m`/`2h`/`7d` before now, or an ISO date. Commands that select sessions read those modified at or after it; `upload`: its window; `facts`: opens a time window, see [Session facts](facts.md) |
| `--until <t>` | `facts`: closes the time window (exclusive), same forms as `--since` |
| `--out <path>` | Write the output to a file; stdout gets one summary line. `convert`: the OTLP file; `upload --dry-run`: the redacted preview (nothing is written without it); `check`: a directory for the evidence of each trace that did not pass; `analyze`: a directory for `report.md` and `findings.json` |
| `--dir <path>` | `ask`: write `answers.json` + `report.md` there (without it, the report goes to stdout only) |
| `--contract <file>` | `check`: gate on a declarative trace contract (JSON), or on `conformance`; repeatable |
| `--share-safe` | `check`: gate on whether each path is safe to share, read as bytes |
| `--known-secret-env <name>` | `check --share-safe`: also fail on this variable's value, in any encoding; repeatable |
| `--format <kind>` | Output: `text` or `json` on `list`, `facts`, `analyze`, `check`, `diff`, `bundle verify` and `skills`, and on `convert`'s `--out` summary line; `check` also takes `junit` and `github`. The input is sniffed |
| `--budget <usd>` | `ask`: one ceiling shared by every question. `analyze` calls no model |
| `--question <text>` | `ask`: one question, repeatable. Kept short so the engine sees it whole |
| `--questions <file>` | `ask`: JSON array of questions: strings, or `{ id?, question, instructions?, answerSchema? }` |
| `--question-budget <usd>` | `ask`: provider ceiling for ONE question; `--budget` is the ceiling shared by all of them |
| `--question-timeout <seconds>` | `ask`: wall-clock deadline for ONE question's investigation (default 600); raise it for questions over many large sessions |
| `--concurrency <n>` | `ask`: questions running at once (default 4) |
| `--once` | `watch`: one pass (or one run-tree snapshot), then exit |
| `--no-content` | One metadata-only rule (`src/metadata-only.ts`): `facts` omits conversation, commands, paths and assignment text; `convert` and `upload` drop prompts, replies, tool input and output, error text, working directories, branch names and subagent briefs from every span |
| `--dry-run` / `--yes` | `upload`: preview without sending / skip the confirm prompt |

Every command exits 0 yes, 1 no (fail, diverged, unsafe), or 2 could not answer. With `--format json`, the reason is one JSON object `{error, code}` on stderr.
