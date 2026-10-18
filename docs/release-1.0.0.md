# traces 1.0.0

traces answers every question about an agent session with one command: 12 commands and 24 options, down from 27 commands, each with its own `--help`, one page, and a test that spawns it.
`facts` states what happened for $0, `analyze` ranks what went wrong for $0, `check` is the one gate, `watch` the one live view, and `ask` the only command that spends.
Selection finds every session on every harness (every Codex home, ids by 8-character prefix or suffix, `--current` in Claude Code too), `facts` owns every number with tokens and cost checked against the raw records, `--match` searches 30 days of sessions through an incremental index, nothing is written outside `--out` and `$XDG_STATE_HOME/traces`, and `install.sh` refuses to overwrite another program's `traces`.
The `inspect-agent-traces` skill maps each question an agent asks to the command that answers it.

## Migration

- **Commands.** `investigate` and `improve` are `analyze` (`--out DIR`). `validate` is `check --contract conformance`, and `verify-safe` is `check --share-safe`. `stream` is `watch --format jsonl`, with the same `traces.stream.*` v1 envelope minus batch events. `export` is `convert`. `index` is `list --format json`. `evidence` is `facts --format json`. `bundle-view` is `facts --no-content`. `inspect` is `analyze`. The CodeTraceBench and replay commands are removed; use `npx --yes @tangle-network/traces@0.23.1 <command>`.
- **Refs replace flags.** `--session`, `--otlp`, `--supervisor-run-dir` and `--source-bundle` become a positional ref. Ids, unique 8+ character prefixes or suffixes, files, directories and store roots are all refs ([refs and selection](select.md)).
- **Selection.**
  - `--harness` defaults to every harness, and `--all` is gone.
  - A reading command needs a ref, `--current`, `--last` or `--since`.
  - `--last` is by mtime and never selects your own session.
  - `--current` works in Claude Code too; in a Codex session started from Claude Code, the Codex session wins.
  - Children are always included; the named session is `sessions[0]`.
  - `upload` needs a ref or `--since`.
- **Output.** Text is the default, including for `facts`, so pass `--format json` to parse. `--dir`, `--otlp-out` and `--evidence` are `--out`. `--junit F` is `--format junit > F`. Nothing is written outside `--out` and `$XDG_STATE_HOME/traces`.
- **Errors and exit codes:** 0 yes, 1 no, 2 could not answer. check's 3 and 4, diff's 2 and 3, and verify-safe's UNKNOWN 2 all become 2. With `--format json|jsonl`, the error is one JSON object on stderr with `code`; stdout stays empty.
- **check needs a gate.** `check <ref>` alone exits 2. Use `--contract <file>`, `--contract conformance` or `--share-safe`. `--known-secret-env` is unchanged.
- **Model use.** Only `ask` calls a model; `analyze --llm` is gone. `ask` requires `--budget`, caps each question at min(budget, $2), and defaults to 1800 s and concurrency 4. A partial run writes `answers.json` and exits 2 with `code: partial`. Without `TRACES_PYTHON`, the bridge runs through `uvx`.
- **SDK.** 25 values and 25 types ([sdk](sdk.md)). Import agent-eval and agent-trace-contract names from their owners. `watchSessions` is now `streamSessions`. `runPipelines` is gone; `analyze --format json` carries its measures. `buildTraceFindingPacket` is unchanged.
- **Harnesses.** gemini, qwen, amp and copilot are removed; pin 0.23.1 if you read them. `codex-exec` stays.
- **mcp.** Unchanged except that its selection is refs and selection flags.
- **facts JSON.** `measurementVersion` is 5. Fields are added: `reply`, `interrupted`, `signals`, `author`, `cost`, `matches` and the waste measures. `tokens.input` is the whole prompt, cache included, on every harness. n = 1 distributions are removed. Every existing value path is unchanged.
- **Install.** `install.sh` refuses to overwrite a `traces` that is not this package's (Homebrew ships an unrelated one) and names it.

The full table: [docs/migrate-1.0.md](migrate-1.0.md), or `traces help moved`.

## Benchmark: traces against an agent reading the raw files (U11)

`bench/audit` asks 19 questions about three synthetic sessions, scored by exact match. Each model arm is one `claude -p` agent per question, model `sonnet` (served as `claude-sonnet-5-5`), $0.25 per question, tools `Bash`, `Read`, `Grep`, `Glob`; cost is the harness's own `total_cost_usd` at list price. The rule: the traces arm answers at least as many questions correctly as the raw-files arm, at lower cost.

**Step 20 (2026-10-17, Claude Code 2.1.301, traces on PATH, no skill):**

| Run | raw-files correct / partial / wrong | cost | traces correct / partial / wrong | cost |
|---|---|---|---|---|
| 1 | 17 / 1 / 1 | $0.6712 | 16 / 2 / 1 | $0.6069 |
| 2 | 17 / 1 / 1 | $0.6951 | 17 / 1 / 1 | $0.6693 |
| 3 | 16 / 2 / 1 | $0.7051 | 16 / 3 / 0 | $0.6974 |
| **Total** | **50 / 57** | **$2.0714** | **49 / 57** | **$1.9736** |

**Step 21 rerun (2026-10-17, the same questions, model and budget; the traces arm loads the skill as installed):**

| Run | raw-files correct / partial / wrong | cost | traces correct / partial / wrong | cost | traces arm: skill loaded / ran traces / only `--help` / no traces |
|---|---|---|---|---|---|
| 1 | 17 / 1 / 1 | $0.6515 | 16 / 2 / 1 | $0.7436 | 4 / 4 / 5 / 10 |
| 2 | 17 / 1 / 1 | $0.6574 | 17 / 1 / 1 | $0.9749 | 5 / 6 / 4 / 9 |
| 3 | 17 / 1 / 1 | $0.6789 | 17 / 2 / 0 | $0.9876 | 4 / 5 / 4 / 10 |
| **Total** | **51 / 57** | **$1.9878** | **50 / 57** | **$2.7061** | 13 / 15 / 13 / 29 of 57 |

The rule is **not met**: the traces arm answered one question fewer, at 36% more cost. The question it loses is `op.role` in all three runs: it counts runs a `labctl run` inside a code-mode script loop started, which no facts field records. Where the agent loaded the skill and ran `traces facts`, the answer cost more than a targeted `grep` on these small files: the operator session's JSON sheet is about 60 KB. A first traces run with Claude Code's 19 bundled skills also listed in the Skill tool scored 15 / 3 / 1 at $1.1506; the arm now turns them off (`bench/audit/README.md`).

**The facts arm** (`traces facts <ref> --format json` mapped by fixed rules, $0, in `pnpm test`): 12 of 19 on the canonical wordings and 12 of 19 held out since #215, which answers `op.runs` and `op.role` (10 of 19 at step 21, 5 before step 20's fixes).

**The large-session arm** (reported apart; it does not decide the rule): one synthetic Codex session of 50,124 spans (27 MB), four questions, one run per arm.

| Arm | correct / partial / wrong | cost | note |
|---|---|---|---|
| facts | 4 / 0 / 0 | $0 | 8 s on a laptop |
| raw-files | 3 / 1 / 0 | $0.1225 | counted `write_stdin` poll exits as command exits (5,252 against 4,297) |
| traces | 3 / 1 / 0 | $0.1522 | never loaded the skill; ran `traces --help` once; the same miss |

**U11 round (2026-10-17, after #215: code-mode processes by program, the `commands` sheet line, the facts-first skill).** The same questions, model and budget; at most 2 `claude -p` at a time on this Mac, each started at load1 ≤ 20 and free memory ≥ 30%.

| Run | raw-files correct / partial / wrong | cost | traces correct / partial / wrong | cost | traces arm: skill loaded / ran traces / only `--help` / no traces |
|---|---|---|---|---|---|
| 1, step 21's arm settings, before #215's two leak fixes | 17 / 1 / 1 | $0.6847 | 19 / 0 / 0 | $0.9958 | 14 / 15 / 1 / 3 |
| 1, account skills off | 17 / 1 / 1 | $0.6317 | 17 / 1 / 1 | $0.7530 | 15 / 15 / 0 / 4 |
| 2, account skills off | 14 / 4 / 1 | $0.6228 | 18 / 1 / 0 | $0.6707 | 15 / 15 / 0 / 4 |
| 3, account skills off | 17 / 2 / 0 | $0.6615 | 19 / 0 / 0 | $0.6826 | 16 / 16 / 0 / 3 |
| **Total, account skills off** | **48 / 57** | **$1.9160** | **54 / 57** | **$2.1063** | 46 / 46 / 0 / 11 of 57 |

The rule is **not met**: the traces arm answers six more questions correctly, but at 9.9% more cost. Under step 21's settings, Claude Code loaded the login account's claude.ai skills into the traces arm's Skill tool after the first request (24 `commands_changed` events in 19 questions), so each question's second turn rewrote the prompt cache: `op.tokens`, the same two calls in both arms, cost $0.0171 in raw-files and $0.0310 in traces. The arm now sets `syncClaudeAiSkills: false`: 0 such events in 57 questions, and the traces arm's median second-turn cache write fell from 4,037 to about 1,378 tokens (raw-files about 585; the rest is the skill's own text). What still costs more: `claude.bash` (+$0.097 over three runs; facts counts only the main session's Bash calls), `op.runs` (+$0.090; `--match` rows carry no exit status, so agents read the raw records), and `claude.tasks` (+$0.053; no facts field holds `subagent_type`).

Large session, account skills off, three paired runs: traces 12 / 12 at $0.3579 (4 / 4 each run), raw-files 9 / 12 at $0.5494 (3 / 4 each run, counting `write_stdin` poll exits as command exits, 5,252 against 4,297); facts 4 / 4 at $0.

**U11 rerun after #217 (2026-10-18, traces `e8c0d35`, on GTR).** The same questions, model (`claude -p` 2.1.302, `sonnet`), budget and arm settings; at most 2 `claude -p` at a time, each started at load1 ≤ 40 and 16 GiB available. The work trees sat under `/tmp`: under the login's home, both arms' agents loaded that home's skills, `AGENTS.md` and auto-memory.

| Run | raw-files correct / partial / wrong | cost | traces correct / partial / wrong | cost | traces arm: skill loaded / ran traces / only `--help` / no traces |
|---|---|---|---|---|---|
| 1 | 15 / 1 / 3 | $0.5731 | 19 / 0 / 0 | $0.6029 | 12 / 12 / 0 / 7 |
| 2 | 17 / 1 / 1 | $0.6931 | 19 / 0 / 0 | $0.6996 | 11 / 11 / 0 / 8 |
| 3 | 16 / 2 / 1 | $0.7169 | 17 / 1 / 1 | $0.6828 | 11 / 11 / 1 / 7 |
| **Total** | **48 / 57** | **$1.9830** | **55 / 57** | **$1.9853** | 34 / 34 / 1 / 22 of 57 |

The rule is **not met**, by $0.0023 (0.1%). #217's facts closed the three gaps it named: over the three runs, `claude.bash` went from +$0.097 to −$0.004, `op.runs` from +$0.090 to −$0.052, and `claude.tasks` from +$0.053 to $0.000. What still costs more is answers that cite or quote a record. The agent reads the fact, then searches the session file for its line: `op.exit-codes` +$0.091 (no exit codes by command), `op.local-copy` +$0.066, `claude.first-bash-error` +$0.035, `op.large-output` +$0.033 (`--match` showed no output) and `op.last-human-turn` +$0.027. Large session, three pairs: traces 10 / 12 at $0.3784, raw-files 9 / 12 at $0.4097; both missed `large.commands` in most runs.

## Fork parity (step 20, this Mac, 2026-10-08 to 2026-10-14)

Each parser traces retires, scored against the command that replaces it; a consumer PR deletes a fork only at or above its tolerance (90%).

| Fork (deleted in step) | Agreement | Disagreements and their cause |
|---|---|---|
| voice-ledger `multi_extract.py`, Codex (23) | 75.8%, below | Codex goal-context injections the old parser counts (traces follows Codex's own context list), and question-tool answers and screenshot turns traces dropped; **fixed in 1.0.0**: on the session that held 23 of the 45, facts now reads 19 turns instead of 14 |
| trace-mine `extract.mjs` (25) | 93.2%, pass | Claude Code `Warmup` prompts (old only), typed slash commands (traces only) |
| reflect `self-audit`, counting half (23) | 93.8%, pass | one code-mode session: per-`cmd` against per-script counting |
| HALO `halo-extract.mjs` (23) | 43.8%, below | HALO counts a script-launched session's prompt as a person's turn |
| skill_ledger `_pr_events` (23) | 93.8%, pass | `gh-drew pr create` inside Codex code-mode scripts; **fixed in 1.0.0**: that session now reads all 6 creates (#127, #130, #131, #134, #135, #136) |
| recurrence `scan()` tokens (25) | 87.5%, below | 2 sessions with no usage record: recurrence 0, facts null with its reason; a definition, not a defect ([parsers](parsers.md)) |
| trace_insights adapters (25) | 100%, pass | none |
| trace-adapters `flatten.py` (25) | 100%, pass | none |

## Correction signals (U21, step 10)

On voice-ledger's 150 blind calibration turns (148 joined, 44 corrections), against trace-mine Opus labels:

| Arm | Recall [95% CI] | Precision [95% CI] | F1 |
|---|---|---|---|
| interrupt | 0.091 [0.04, 0.21] | 0.400 [0.17, 0.69] | 0.148 |
| rejected-tool | 0.068 [0.02, 0.18] | 0.750 [0.30, 0.95] | 0.125 |
| after-claim | 0.091 [0.04, 0.21] | 0.190 [0.08, 0.40] | 0.123 |
| union | 0.205 [0.11, 0.34] | 0.290 [0.16, 0.47] | 0.240 |
| lexical (0.23.1 baseline) | 0.341 [0.22, 0.49] | 0.577 [0.39, 0.74] | 0.429 |
| lexical-any | 0.591 [0.44, 0.72] | 0.553 [0.41, 0.69] | 0.571 |

The union does not beat the lexical baseline, so analyze section 7 is "Interrupts and rejections", and nothing calls these signals corrections.

## Finding precision (U7, step 13)

HIGH and MED findings on 10 real sessions (5 Claude Code, 5 Codex), each labelled by reading the evidence:

| Finding kind | Severity labelled | Findings | True | Precision | Shipped |
|---|---|---|---|---|---|
| `terminal-failure` | HIGH | 3 | 3 | 1.00 | HIGH |
| `completion-claim-without-verification` | MED | 9 | 0 | 0.00 | LOW in step 13, removed in step 14 |
| `no-self-verification` | MED | 1 | 0 | 0.00 | LOW |
| the other six kinds | | 0 | | not measured | unchanged |

## Parsers outside traces

[docs/parsers.md](parsers.md) re-ran the census on seven default branches: 35 hand-written session parsers today, 26 after the 1.0 consumer PRs (steps 22 to 30), 22 after 1.1. The spec expected 23, 8 and 5: the census found 13 more parsers (discovery-lab 7, tangle-tools 2, agent-dev-container 1, agent-eval 3) that no step retires yet.
