# traces

`traces` is the CLI and SDK surface over agent trace data: OTLP spans any system emits, or a coding
agent's own on-disk session log. It reads traces; it does not decide what a run means or redact/gate
content itself — see Ownership.

## Read for the task

- For CLI commands, flags, and the SDK export table, read [README.md](README.md) — it is the source
  of truth for both; do not duplicate command inventories here.
- For the analyst engine (built-in vs `--llm` vs external engines like HALO/Hodoscope/Prime), read
  [docs/trace-analysts.md](docs/trace-analysts.md).
- For executed-replay proofs of a finding (`replay-verify`, `verify-findings`), read
  [docs/replay-verify.md](docs/replay-verify.md), including its Honest limits section before trusting
  a replay verdict.
- Resolve current exports and signatures from [src/index.ts](src/index.ts) and `src/cli.ts`'s `usage()`
  function (`traces --help`), not from memory of an older version.

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
- **Exit codes are a stable API.** `validate`/`check`/`diff` scripts and CI gates branch on exact exit
  codes (see the tables in README.md). Do not repurpose a code's meaning; add a new one only alongside a
  major-version note.
- **Nothing on the ingest path is repaired or invented.** A span with an unreadable timestamp is
  reported and excluded from analysis, never given a synthesized value — a repaired value would put
  invented work into a total. A re-export carries `traces.source.unreadable_rows` forward; it never
  reports cleaner than its source.
- **Redact before anything leaves the machine, then check the redacted copy.** `upload` and `mcp` both
  redact first and then require a `SAFE`/`SAFE_WITH_WARNINGS` verdict on the *redacted* result before
  sending or serving anything. `UNSAFE` or `UNKNOWN` is refused, not sent with a warning.
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
  redaction the rest of this package applies. It is withheld from `traces mcp` entirely and reachable
  elsewhere only through the caller's explicit, opt-in `--source-bundle` — never a default path.
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

`pnpm bench:audit` (see [Audit benchmark](README.md#audit-benchmark)) is a separate, hand-run
comparison; it is not part of the standard gate.
