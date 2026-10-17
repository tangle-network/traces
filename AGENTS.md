# traces

`traces` is the CLI and SDK surface over agent trace data: OTLP spans any system emits, or a coding
agent's own on-disk session log. It reads traces; it does not decide what a run means or redact/gate
content itself — see Ownership.

## Read for the task

- For the common CLI commands and flags, read [docs/cli.md](docs/cli.md); for the main SDK exports, read
  [docs/sdk.md](docs/sdk.md). Both are curated: `traces --help` and [src/index.ts](src/index.ts) are the
  complete inventories. Do not duplicate command inventories here. [README.md](README.md) stays a short
  front page that links to one guide per task.
- For the analyst engine (built-in vs `--llm`), read [docs/trace-analysts.md](docs/trace-analysts.md).
- Every 0.x command and flag that 1.0 removed is a row in [src/moved.ts](src/moved.ts): using it exits 2
  and prints the replacement (`traces help moved`). Remove a spelling only by adding its row.
- Resolve current exports and signatures from [src/index.ts](src/index.ts) and the command table in
  [src/commands.ts](src/commands.ts) (`traces --help`, `traces <command> --help`), not from memory of an
  older version. A command's flags, help and parsing come from its one row there.

## Ownership

This package is the integration surface. It does not reimplement logic that another package already
owns:

- `@tangle-network/agent-trace-contract` (in `agent-sdk`) owns the span shape and kind vocabulary.
  Emit spans through its builders (`llmSpan`, `toolSpan`, `loopSpan`, `steeredBy`, …); do not construct
  a raw OTLP object by hand and call it conforming.
- `@tangle-network/agent-eval` owns the trace-contract checker (`traces check` calls it), the analyst
  suite (`analyzeSpans`, `runTraceInvestigation`, …), and the one redaction/share-safety core
  (`redactSpans`, `assessSpans`). `traces upload` and `traces mcp` call that core; they never carry a
  parallel credential-matching or PII implementation here.
- `agent-runtime` owns execution and applying an approved improvement. `traces improve` writes a
  reviewable packet; it does not execute a candidate change.
- This package's own job: adapt one more harness's on-disk format into spans (`src/adapters/`), read
  and validate OTLP from any producer, and render/report/gate over the result.

A harness adapter is the legacy edge, for a format this project does not control. A system you do
control should emit the contract directly (`--otlp`), never get a new adapter.

## Invariants

- **`parent_span_id` is containment; `links` is causality.** A span's parent is what it happened
  inside. A `links` entry is what caused it (e.g. a verdict that triggered a retry round). Never encode
  a causal edge as a parent pointer — it claims a nesting that never existed and cannot round-trip.
- **Exit codes are a stable API: 0 yes, 1 no, 2 could not answer** (the 1.0.0 major note). A usage
  error or an input traces could not read exits 2; under `--format json|jsonl` its error is one JSON
  object `{error, code}` on stderr and stdout stays empty. Scripts and CI gates branch on exact exit
  codes (see the tables in [docs/integrate.md](docs/integrate.md), [docs/check.md](docs/check.md),
  [docs/diff.md](docs/diff.md) and [docs/upload.md](docs/upload.md)). Do not repurpose a code's meaning.
- **Nothing on the ingest path is repaired or invented.** A span with an unreadable timestamp is
  reported and excluded from analysis, never given a synthesized value — a repaired value would put
  invented work into a total. A re-export carries `traces.source.unreadable_rows` forward; it never
  reports cleaner than its source.
- **Redact before anything leaves the machine, then check the redacted copy.** `upload` and `mcp` both
  redact first and then require a `SAFE`/`SAFE_WITH_WARNINGS` verdict on the *redacted* result before
  sending or serving anything. `UNSAFE` or `UNKNOWN` is refused, not sent with a warning.
- **The turn index answers exactly what a whole read answers.** `list` and `facts --since … --match`
  read the index under `$XDG_STATE_HOME/traces/turn-index`, which reads only what each session file
  appended since the last run. Its rows come from the same fold, projection and row functions as a
  whole read, never a second classifier; `tests/turn-index.test.ts` holds it to a whole read, row for
  row, after every appended record.
- **`facts` owns every session number; the other commands render it.** Tokens and cost have one owner,
  `src/execution.ts`: `tokens.input` is the whole prompt on every harness, and `cost` is agent-runtime's
  `priceTokens` (`list price (Router rates)`). `analyze` prints the sum of the sessions' facts, never a
  second count; `tests/facts-owner.test.ts` checks the numbers against jq over the raw records. The
  waste measures (failing streaks, rollbacks, stalls, active minutes, rework) are facts' too, checked
  against the planted records in `tests/facts-measures.test.ts`, and a session's skill counts come from
  the classifier `traces skills` uses (`skill-usage.ts`), never a second one.
- **Until harness-sessions reads every view (U18), both read paths state every number the same.**
  `traces facts <f>` (the shared reader), `--latest-turn` (traces' own reader) and a bundle of `<f>`
  agree on tokens, cost, tool calls, human turns, subagents, pull requests, skills, rework, rollbacks
  and failing streaks (`tests/dual-path.test.ts`).
- **Unknown is never rendered as a measured zero.** An unpriced turn reads `cost unknown`, never
  `$0.0000`; a fact the spans cannot support is `null` with its reason, never a guessed value.

## What not to do

- Do not add a new harness adapter for a system this org controls. Emit
  `@tangle-network/agent-trace-contract` spans and use `--otlp` instead.
- Do not hand-write a credential or PII pattern here. Extend agent-eval's redaction core
  ([its docs/redaction.md](https://github.com/tangle-network/agent-eval/blob/main/docs/redaction.md))
  and depend on the new version; a second regex list drifts from the first.
- Do not treat a `warn` validation finding as a failure, or an `UNKNOWN` share-safety verdict as safe.
  Both mean "the input could not fully answer this," not "answer negative."
- Do not call `readSpanSource` (or otherwise read original bytes) as a way to route around the
  redaction the rest of this package applies. It is withheld from `traces mcp` entirely, and no
  command grants it.
- Do not assume `@tangle-network/agent-eval`'s published version matches this package's declared range
  without checking; run `npm view @tangle-network/agent-eval version` before pinning a bridge
  (`agent-eval-rpc[dspy]`) to a version.

## Validation

Run from the package root:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build          # dist/index.js (SDK), dist/cli.js (bin), .d.ts
pnpm test
pnpm check:package  # proves the packed npm tarball actually contains the `traces` binary
pnpm run verify:contracts-corpus   # real-trace corpus that CI runs traces check against
```

`pnpm bench:audit` (see [Audit benchmark](docs/develop.md#audit-benchmark)) is a separate, hand-run
comparison; it is not part of the standard gate.
