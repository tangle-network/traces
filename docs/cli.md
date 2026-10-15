# CLI reference

[traces](../README.md#docs) › CLI reference

The common commands and flags. `traces --help` lists every command and option, and `traces <command> --help` prints that command's own flags.

```bash
traces list     --harness claude-code --last 20    # discover sessions
traces analyze  --harness codex --session <id>     # pin one ID printed by `list`
traces analyze  --harness codex --current          # this session, even when a child wrote later
traces analyze --harness codex --current --latest-turn --workflow  # current turn plus workers
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
traces index    --all --since 24h --out session-index.json
traces bundle   --harness claude-code --session <id|path> --out bundle-dir   # one session's durable evidence dir
traces bundle-view bundle-dir --view evidence-only --out writer-dir   # same session, without its own words
traces bundle verify bundle-dir                                        # every file against its manifest SHA-256
traces inspect  session-index.json --out inspection-report.md
traces evidence --harness codex --last 20 --out policy-evidence.jsonl
traces evidence --harness codex-exec --session /tmp/codex.jsonl --cwd "$PWD" --out policy-evidence.jsonl
traces export   policy-evidence.jsonl --out spans.openinference.jsonl
traces import-codetracebench verified.jsonl --trajectory-dir normalized --out traces --revision <40-or-64-character-hex>
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
traces replay-verify --steps steps.json --image <docker-image> --at 37 --cwd /home --out ./replay-out \
  --fix-command "<corrected step>"                 # executed proof: replay prefix, reproduce failure, show fix
traces verify-findings --findings findings.json --out ./receipts \
  --steps steps.json --image <replay-ready-image> --cwd /app   # execute recorded analyst findings as proofs
traces analyze --last 1 --llm --verify-findings --replay-corpus h=labels.json::prepared/  # proof-carrying analyze
```

`replay-verify` replays a CodeTraceBench-style trajectory prefix in a real sandbox and executes step k twice — recorded (does the failure reproduce?) and corrected (does it vanish?).
`verify-findings` runs that proof per analyst finding and annotates each with `reproduced | fix-flipped | divergent | not-replayable` plus a receipt directory; see [Verified findings](./trace-analysts.md#verified-findings-executed-replay).
See [Replay verification](./replay-verify.md) for setup, semantics, and honest limits (SWE-style trajectories with a docker image only; commands run as the non-root sandbox user).

| Flag | Meaning |
|---|---|
| `--harness <id>` | Harness or alias (default: `claude-code`) |
| `--all` | Every known harness |
| `--last <n>` | Most-recent N sessions |
| `--current` | Active Codex session from `CODEX_THREAD_ID` |
| `--latest-turn` | Limit a resumed Codex or Claude Code session to its latest task turn |
| `--session <id\|path>` | One listed session ID or explicit session file |
| `--workflow` | Expand selected files through stable parent and child session IDs |
| `--max-workflow-sessions <n>` | Stop workflow expansion before parsing more than `n` files; default `100` |
| `--cwd <dir>` | Filter by working directory |
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
| `--format <kind>` | File `analyze`, `export`, or `stream`: `auto`, `policy-evidence`, `sandbox-events`, `openinference`, `intelligence-spans`, or `chat-trajectory` |
| `--source-bundle <dir>` | `analyze` / `investigate` / `improve` / `ask`: read a retained full bundle and explicitly grant source-field reads |
| `--llm` / `--budget <usd>` | Enable agentic analysts (needs `TANGLE_API_KEY` + Python with `agent-eval-rpc[dspy]`) / cap their spend |
| `--question <text>` | `ask`: one question, repeatable. Kept short so the engine sees it whole |
| `--questions <file>` | `ask`: JSON array of questions — strings, or `{ id?, question, instructions?, answerSchema? }` |
| `--question-budget <usd>` | `ask`: provider ceiling for ONE question; `--budget` is the ceiling shared by all of them |
| `--question-timeout <seconds>` | `ask`: wall-clock deadline for ONE question's investigation (default 600); raise it for questions over many large sessions |
| `--concurrency <n>` | `ask`: questions running at once (default 4); `import-codetracebench`: trajectories imported at once |
| `--config <path>` | `analyze` / `investigate` / `improve` / `stream`: load BYO analysts, live analysts, and external analyzers |
| `--interval <s>` / `--window <m>` | `watch` / live `stream`: poll seconds (sessions 5, run tree 2) / active-session window minutes (default 30) |
| `--min-loop <n>` | Identical repeated calls before flagging a loop (default 3) |
| `--mode <kind>` | `stream`: `visualizer` (spans + findings), `findings` (low-volume), or `agent` (findings + reports) |
| `--supervisor-run-dir <dir>` | `analyze`: report one run tree; `watch`: tail it live |
| `--verify-findings` | `analyze`: execute the findings as sandbox replay proofs; each is marked VERIFIED (receipt path) or UNVERIFIABLE (reason). Needs `--replay-corpus` and a running sandbox (`SANDBOX_API_KEY` / `SANDBOX_API_URL`) |
| `--replay-corpus name=<labels>::<prepared>` | Trajectory source for `--verify-findings` (repeatable) |
| `--verify-out <dir>` | Receipt root for `--verify-findings` (default: `<--out>.verify`) |
| `--replay` | `stream`: scan once, then exit |
| `--once` | `stream`: scan once; `watch <target>`: print ONE snapshot and exit |
| `--no-spans` / `--no-findings` | `stream`: suppress raw span rows / finding rows |
| `--no-content` | `facts`: omit conversation, commands, paths and assignment text; `upload`: send metadata only |
| `--dry-run` / `--yes` | `upload`: preview without sending / skip the confirm prompt |
