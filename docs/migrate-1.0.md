# Migrate to 1.0

[traces](../README.md#docs) › Migrate to 1.0

1.0 has 12 commands and 24 options. Every removed command and flag exits 2 and prints its replacement, with your argv rewritten where the rewrite is mechanical; `traces help moved` prints the whole table. 0.23.1 stays on npm: pin `@tangle-network/traces@0.23.1` to go back.

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

| 0.x argv (after `traces`) | 1.0 |
|---|---|
| `investigate --session X` | `traces analyze X` |
| `facts --harness codex --session P` | `traces facts P --harness codex --format json` |
| `convert --format sandbox-events --otlp-out f x.json` | `traces convert x.json --out f` |
| `stream --all --mode findings` | `traces watch --format jsonl` |
| `validate f` · `verify-safe p` | `traces check f --contract conformance` · `traces check p --share-safe` |
| `improve X --dir d --llm` | `traces analyze X --out d`, then `traces ask X --question … --budget 1` |
