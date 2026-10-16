# CLI reference

[traces](../README.md#docs) › CLI reference

The common commands and flags. `traces --help` lists every command and option, and `traces <command> --help` prints that command's own flags.

```bash
traces list     --cwd . --last 20                  # one row per session: ref, harness, last activity, turns, cwd, first prompt
traces analyze  --harness codex --session <id>     # pin one ID printed by `list`
traces analyze  --current                          # this session (Codex or Claude Code), with its spawned children
traces analyze --current --latest-turn             # current turn plus the workers it spawned
traces analyze --harness claude-code --session <path> --latest-turn # latest task plus its subagents
traces investigate --all --last 10 --out report.md  # explicit investigation alias
traces improve --all --last 10 --dir .traces/improvement
traces ask --harness codex --session <id> --question "Which commands failed?"
traces facts --harness codex --session <id>        # the deterministic facts sheet, $0
traces facts --all --since 2026-10-14 --until 2026-10-15  # every session with a record that day, that day's turns
traces skills --since 30d                          # skill use across every local session, incremental, $0
traces diff  run-a.otlp.jsonl run-b.otlp.jsonl      # where two runs of one task first diverge
traces mcp   --otlp spans.otlp.jsonl                # read-only trace tools for an MCP client
traces analyze  --all --since 2026-06-18 --out report.md
traces check   spans.otlp.jsonl --contract c.json --junit c.xml  # exit 0 pass, 1 fail, 2 bad contract, 3 unreadable, 4 ambiguous
traces validate spans.otlp.jsonl                   # conformance; exit 1 only when it is not a trace
traces validate results/sessions --out conformance.md  # a whole directory of exports
traces analyze  --otlp spans.otlp.jsonl            # analyse foreign OTLP, no adapter
traces analyze  --otlp results/sessions --out report.md
traces convert  --harness claude-code --last 1 --otlp-out spans.jsonl   # OTLP only
traces list     --format json                      # one row per session, with id, path and parent id
traces bundle   <id|path> --out bundle-dir         # one session's durable evidence dir
traces bundle verify bundle-dir                    # every file against its manifest SHA-256
traces facts    bundle-dir --no-content            # a bundle is a ref; this is its evidence without its words
traces export   sandbox-events.json --out spans.openinference.jsonl
traces watch    --all                              # live observer; loops + semantic findings
traces watch    runs/my-run                        # live run tree: status, budget, driver vs child spend
traces watch    runs/my-run --once                 # one snapshot, then exit
traces watch    traces.otlp.jsonl                  # any OTLP span file, any emitter
traces analyze  --supervisor-run-dir runs/my-run   # the full tree report
traces stream   --all --mode findings              # low-volume semantic feed
traces stream   --all --mode agent                 # findings + deterministic report events
traces stream   spans.openinference.jsonl --format openinference --no-spans
traces upload   --since 1h --dry-run               # redact + dedup + preview, no network
traces upload   --since 24h                        # upload last day to the Intelligence Platform
traces verify-safe bundle-dir                      # SAFE / SAFE_WITH_WARNINGS / UNSAFE (exit 1) / UNKNOWN (exit 2)
traces help moved                                  # every 0.x command and flag 1.0 removed, and its replacement
```

| Flag | Meaning |
|---|---|
| `--harness <id>` | Read only this harness; the default is every harness |
| `--last <n>` | The N sessions with the newest file mtime, never the caller's own |
| `--current` | The caller's own session: `CODEX_THREAD_ID` (Codex) wins, else `CLAUDE_CODE_SESSION_ID` (Claude Code) |
| `--latest-turn` | Limit a resumed Codex or Claude Code session to its latest task turn |
| `--session <id\|path>` | The session a ref names (same as the positional ref) |
| `--cwd <dir>` | Sessions recorded in `<dir>` or under it on a path boundary, in a live worktree of its repository, or in a removed worktree whose recorded repository (Codex) is its |
| `--since <t>` | `30m`/`2h`/`7d` before now, or an ISO date. Commands that select sessions read those modified at or after it; `upload`: its window (default 24h); `facts`: opens a time window — see [Session facts](facts.md) |
| `--until <t>` | `facts`: closes the time window (exclusive), same forms as `--since` |
| `--out <path>` | Write the report to a file |
| `--dir <path>` | `improve`: write the full artifact pack to this directory; `ask`: write `answers.json` + `report.md` there |
| `--otlp <file\|dir>` | **READ** OTLP-JSONL from any system, skipping the adapters; a directory reads the OTLP files under it (only `otlp/` when the producer made one) and names the JSONL that is not OTLP. `validate`, `check`, `analyze`, `investigate`, `improve`, `ask`, `stream` |
| `--contract <file>` | `check`: the declarative trace contract (JSON) |
| `--junit <file>` | `check`: write JUnit XML, one test case per rule |
| `--evidence <dir>` | `check`: where evidence for a trace that did not pass goes (default `.traces/check`) |
| `--annotations` | `check`: print GitHub workflow annotations (on by default under `GITHUB_ACTIONS=true`) |
| `--otlp-out <path>` | **WRITE** the OTLP artifact here (also evidence provenance / dry-run upload preview) |
| `--format <kind>` | File `analyze`, `export`, or `stream`: `auto`, `sandbox-events` or `openinference` |
| `--llm` / `--budget <usd>` | Enable agentic analysts (needs `TANGLE_API_KEY` + Python with `agent-eval-rpc[dspy]`) / cap their spend |
| `--question <text>` | `ask`: one question, repeatable. Kept short so the engine sees it whole |
| `--questions <file>` | `ask`: JSON array of questions — strings, or `{ id?, question, instructions?, answerSchema? }` |
| `--question-budget <usd>` | `ask`: provider ceiling for ONE question; `--budget` is the ceiling shared by all of them |
| `--question-timeout <seconds>` | `ask`: wall-clock deadline for ONE question's investigation (default 600); raise it for questions over many large sessions |
| `--concurrency <n>` | `ask`: questions running at once (default 4) |
| `--config <path>` | `analyze` / `investigate` / `improve` / `stream`: load BYO analysts and live analysts |
| `--interval <s>` / `--window <m>` | `watch` / live `stream`: poll seconds (sessions 5, run tree 2) / active-session window minutes (default 30) |
| `--min-loop <n>` | Identical repeated calls before flagging a loop (default 3) |
| `--mode <kind>` | `stream`: `visualizer` (spans + findings), `findings` (low-volume), or `agent` (findings + reports) |
| `--supervisor-run-dir <dir>` | `analyze`: report one run tree; `watch`: tail it live |
| `--replay` | `stream`: scan once, then exit |
| `--once` | `stream`: scan once; `watch <target>`: print ONE snapshot and exit |
| `--no-spans` / `--no-findings` | `stream`: suppress raw span rows / finding rows |
| `--no-content` | `facts`: omit conversation, commands, paths and assignment text; `upload`: send metadata only |
| `--dry-run` / `--yes` | `upload`: preview without sending / skip the confirm prompt |
