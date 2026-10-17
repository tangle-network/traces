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

**The facts arm** (`traces facts --format json` mapped by fixed rules, $0, in `pnpm test`): FACTS_ARM of 19 on every wording (5 of 19 before step 20's fixes).

**The large-session arm** (reported apart; it does not decide the rule): one synthetic Codex session of 50,124 spans (27 MB), four questions, one run per arm.

| Arm | correct / partial / wrong | cost | note |
|---|---|---|---|
| facts | 4 / 0 / 0 | $0 | 8 s on a laptop |
| raw-files | 3 / 1 / 0 | $0.1225 | counted `write_stdin` poll exits as command exits (5,252 against 4,297) |
| traces | 3 / 1 / 0 | $0.1522 | never loaded the skill; ran `traces --help` once; the same miss |

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
