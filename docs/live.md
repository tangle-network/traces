# Watch live sessions

[traces](../README.md#docs) › Watch live sessions

## Live sessions

`traces watch` follows every session active in the last 30 minutes, on every harness, and reports what the `traces analyze` rules find while the agents are still running (`src/pipelines.ts`): a command that failed 3 or more times in a row, a check rerun 3 or more times with no edit between, and half or more of a session's tool calls failing.
Sessions are read every 5 s. The window slides: each pass watches the sessions active in the last `--since` (default `30m`), so a feed left running never goes blind.
A session that cannot be read is skipped and named; the watch goes on.

```bash
traces watch --once                          # one pass over every active session, then exit
traces watch --since 2h --cwd .              # this repo's sessions of the last two hours, live
traces watch 019a3c7e                        # one session, live
traces watch --format jsonl                  # the machine feed
```

Text prints one line per new finding:

```
10:06:00 HIGH a11a1a11 claude-code same-failing-command: `pnpm test` failed 3× in a row (5 min). (spans t1, t2, …)
```

`--format jsonl` prints the `traces.stream.*` envelope at `schemaVersion` 1, the same events the text renders:

| `kind` | When | Fields |
|---|---|---|
| `traces.stream.session` | the first pass that reads a session | `session` (`harness`, `sessionId`, `cwd`, `path`), `spanCount`, `startedAt`, `endedAt` |
| `traces.stream.finding` | the first pass that finds it | `finding`: `kind: traces.live_finding`, `ruleId`, `fingerprint`, `severity`, `claim`, `action`, `check`, `evidence` (with span ids), `session`, `observedAt` |
| `traces.stream.tick` | the end of every pass | `sessions`, `newSpans`, `findings`, `unreadSessions` (`sessionId`, `source`, `reason`) |

Every event also carries `schemaVersion`, `event` and `generatedAt`.
The envelope is a stable API; [`watch-jsonl.v1.example.jsonl`](./watch-jsonl.v1.example.jsonl) is the CLI's output on a fixture, and `tests/watch-jsonl-contract.test.ts` holds it and the fields consumers read.
A run directory or span file with `--format jsonl` prints the same events for its spans.

Custom live rules go through the SDK: `streamSessions({ extraAnalysts })` runs them after the built-in rules, on the same classified actions.

## Watch a run tree

`traces watch <target>` tails ONE run that fans work out to other agents, instead of one harness session.
It prints the tree at any depth: per node the status, the runtime, the authored budget, and the actual spend.
Plain stdout, no cursor control, no extra dependency — it works over SSH, in a CI log, and through a pipe.

```bash
traces watch runs/my-run                 # live: reprints only when something changed
traces watch runs/my-run --once          # one snapshot, for a script or an agent
traces watch traces.otlp.jsonl           # spans only, for any emitter
```

Two sources sit behind the one verb, and the output always names which number came from which:

| Source | Reads | Gives you | Cannot give you |
|---|---|---|---|
| **General** — OTLP spans | `trace_id` / `span_id` / `parent_span_id` in any `*.otlp.jsonl`, `*.spans.jsonl`, `*.traces.jsonl` | tree shape, wall time, per-turn tokens, cost when the emitter priced it | the authored budget — no span vocabulary carries one |
| **Specific** — the spawn journal | `spawn-journal.jsonl` written by agent-runtime's `createFileRunContext` | authored budget, settled spend, settlement status, blocking questions, steers, the typed result | per-turn detail the journal does not tap |

The general source is the one that matters for a system nobody has written yet: anything that emits a parent span pointer gets a tree, whether it is a supervisor, a pi session, a Claude subagent fan-out, or a custom fanout.
Attributes are read through `@tangle-network/agent-eval/trace-attributes` alias lists, so both live vocabularies — OpenInference's `llm.token_count.*` and GenAI semconv's `gen_ai.usage.*` — already work, and no key is invented here.

Two rules the view will not bend on:

- **Driver inference and child work never merge.** A node that drove and the work it delegated are separate lines, because one total cannot answer "which half spent the budget" — the decisive question in three real runs.
- **Unknown is never rendered as zero.** A turn the harness did not price reads `cost unknown (n unpriced)`, never `$0.0000`. A recorded `$0` paid on real tokens is printed AND flagged, because "free" and "unmetered" are different facts.

```
run proof-harness-mcp-20260731i
  2 node(s) · depth 1 · elapsed 9m59s
  driver total    in 639,632 · out 35,077 · $0.0000 (zero across 58 priced)
  worker total    in 47,965 · out 515 · cost unknown (1 unpriced)

● · root  [pending]  supervisor  inline  budget 12it/400,000tok/$2.00/15m00s
    driver    58 turn(s) · in 639,632 · out 35,077 · $0.0000 (zero across 58 priced) · 169% tok of budget
    children  1 settled · in 47,965 · out 515 · cost unknown (1 unpriced)
└─ ✗ artifact-writer-s0  [failed]  worker  pi  budget 6it/80,000tok  wall 20.8s
       settled   3it · in 47,965 · out 515 · cost unknown (1 unpriced) · 50% it, 61% tok of budget

  ! spend recorded $0 with tokens spent: usdKnown was never set false, so this reads as FREE rather
    than unmetered. A harness-billed brain (a CLI on a subscription) looks exactly like this.

RESULT no-winner · budget-exhausted
```

`traces analyze <run-dir>` writes the full report for the same run.
It also reads `failure.json` when Runtime fails before the first spawn.
Pass a parent directory to combine reports from its Runtime runs.
Eval owns discovery, normalization, and analysis; Traces adds recorded coordination requests and delivery receipts.
Old Loops directories are unsupported.

Replay and resume are a separate concern: they belong to the durable spawn journal, and nothing here routes them through telemetry.
