# Audit benchmark

A public, dependency-free benchmark for one question: on a coding-agent session, does an
audit arm answer factual questions correctly and cheaply?

The point of comparison is a fleet of general subagents turned loose on the raw session
files. That fleet is a real arm here, not a straw man, and it wins on some questions today.
Every claim that `traces` beats it has to come from a scored run of both arms on this
benchmark, with the costs reported.

## What is in here

| File | Owns |
|---|---|
| `fixtures.ts` | The generator. Writes three synthetic sessions and the gold answers. |
| `questions.ts` | The questions, their held-out paraphrases, and one JSON answer schema each. |
| `score.ts` | The exact-match scorer and the per-arm tally. |
| `citations.ts` | Resolves an answer's citation to the source record it names. |
| `cli.ts` | The runner: write fixtures, write gold, score an answers file. |

Everything the fixtures contain is invented. No content from any real session appears in
this directory, in its tests, or in anything it generates.

### Why the gold does not come from an adapter

`fixtures.ts` records each planted fact at the moment it writes the record that carries it.
The answer key therefore comes from the plan, never from parsing the files back through
`src/adapters/`. An adapter defect shows up here as a wrong answer, which is the point; if
the gold went through the adapter, the same defect would quietly rewrite the answer key and
the benchmark would score nothing.

`fixtures.test.ts` closes the other half of that loop: it re-derives every planted fact by
reading the generated JSONL directly, with no adapter and no access to the generator's
bookkeeping, and fails if the plan and the bytes disagree.

## Sessions and what they plant

**`codex-operator`** — a Codex operator session, over 600 spans, eight turns.

- One command repeated past any single page of matches: 523 `labctl status` calls, two of
  which name a run that does not exist.
- 16 `spawn_agent` calls, one of which fails on an agent thread limit.
- Three pull requests opened three ways: one inside an `exec` script, one straight from
  `exec_command`, and one whose URL never appears in the create command's own output and
  shows up only in a later `write_stdin` poll of the backgrounded process.
- Three merges, the same three ways, plus one earlier merge the harness refused.
- Runs launched, relaunched with different arguments after a failure, and cancelled, with a
  cancel of a run id that does not exist.
- Injected text that is not a human turn: an `AGENTS.md` block, `environment_context`
  blocks, and `subagent_notification` blocks, including two after the last human turn.
- A short last human turn (`ya?`) following a substantive one.
- `apply_patch` both as its own tool call and nested inside an `exec` script.
- One tool output over 16 KiB whose answer is its last line.
- A repeated `token_count` record with an unchanged cumulative total, so summing deltas
  double-counts.

**`codex-child`** — the session forked from one of those spawns. It starts with the
parent's history rewritten to the fork timestamp, so any count that includes inherited
records is wrong.

**`claude`** — a Claude Code session with three `Task` subagents, each with its own
sidechain transcript, and `Bash` results carrying `is_error`, in the main transcript and
inside the subagents.

## Failure classes

`probes` on each question names the failure classes from the improvement brief it
exercises.

| Class | What it is | Questions |
|---|---|---|
| F1 | Ordered human turns, told apart from injected text | `op.last-human-turn`, `op.corrections` |
| F2 | Enumeration over a session longer than one read | `op.subagents`, `op.runs`, `op.role`, `op.status-polls`, `op.exit-codes`, `op.pull-requests`, `child.own-work`, `claude.tasks`, `claude.bash` |
| F3 | Timestamps of specific records | `op.pull-requests`, `op.time-bounds`, `child.own-work` |
| F4 | Facts linked across spans and across sessions | `op.pull-requests`, `child.lineage` |
| F5 | Files a session changed | `op.local-copy`, `op.changed-files` |
| F6 | Verbatim tool output | `claude.first-bash-error` |
| F9 | Output past a truncation boundary | `op.large-output` |
| F11 | Derived fields, including the correct empty answer | `op.exit-codes`, `op.tokens`, `child.spawned` |

## Scoring

Exact match. No model judges any answer.

- Counts, numbers, names, paths, booleans: equality.
- Times: correct within 1 s. Neighboring records in the fixtures are at least 2 s apart, so
  the tolerance can never accept an adjacent record's time.
- Sets: set equality, order ignored, no missing and no extra member.
- Quotes: the text verbatim (whitespace-insensitive) **and** a citation that resolves to
  the gold record. A citation may be `<file>:<line>`, a span id, or a
  `trace://<trace>/span/<span>` URI; span ids resolve through the source-record offsets the
  adapters attach, so a span id counts only when the span really came from that record.
- A question is `correct` when every leaf is correct, `wrong` when none is, `partial`
  otherwise.

Two things are counted rather than averaged away. A leaf answered `null` where the gold has
a value is reported separately as a false "not in trace"; a confident wrong answer and a
refusal are different failures. And an unreported cost stays `missing` — it never becomes
zero.

## Running it

```sh
# The tree an arm may read. It does not contain the gold.
pnpm bench:audit fixtures --out /tmp/audit-bench

# The answer key, written somewhere the arm cannot see.
pnpm bench:audit gold --out /tmp/audit-gold.json

# Score an arm.
pnpm bench:audit score /tmp/arm-answers.json --fixtures /tmp/audit-bench --out /tmp/report.md
```

`--fixtures` is optional; without it the runner regenerates the tree in a temporary
directory. When it is given, every file in it must still match the generated bytes, so an
arm cannot be scored against a tree it edited.

`prompts.jsonl` in the fixtures directory holds one row per question wording: the canonical
question at `variant: 0` and each held-out paraphrase above it, each with the exact prompt
text and the JSON Schema the answer must match. An arm that only handles the canonical
wordings is scored on those alone; the paraphrase tally is reported separately.

### The answers file

```json
{
  "arm": "subagent-fleet",
  "notes": "5 general subagents, one per session, no traces CLI",
  "answers": [
    {
      "question": "op.status-polls",
      "variant": 0,
      "answer": { "status_commands": 523 },
      "wall_ms": 41200,
      "model_calls": 18,
      "tool_calls": 96,
      "cost_usd": 0.83,
      "cost_basis": "observed"
    }
  ]
}
```

`answer` is the object the question's schema describes, or `null` when the arm produced
none. `wall_ms`, `model_calls`, `tool_calls` and `cost_usd` are optional; leave one out
rather than guessing, because an omitted measure is reported as missing and a guessed one
is reported as a number. `cost_basis` says whether `cost_usd` was observed or estimated.

## What `pnpm test` covers, and what it does not

`pnpm test` runs the deterministic half:

- `fixtures.test.ts` — the generator is byte-identical across runs, every planted fact is
  present, and the gold equals a re-derivation of the fixtures that never touches the
  generator's bookkeeping or an adapter.
- `score.test.ts` — the gold, submitted as an arm, scores every question correct through
  the same path a real arm takes; and the scorer's leaf rules, citation resolution,
  answers-file validation, tallies, and the runner end to end.

The model arms are **manual**, on purpose: they cost money, they are not deterministic, and
CI must not depend on a model provider. Run them by hand and keep the answers files.

Two arms are worth running against each other:

1. **Subagent fleet.** Point a coding agent at the fixtures directory with no `traces` CLI
   and let it spawn whatever subagents it wants. This is the baseline to beat.
2. **traces.** The same coding agent, allowed to use the `traces` CLI over the same
   fixtures directory.

Give both arms the same prompts from `prompts.jsonl`, the same model, and the same fixture
tree; record wall time, model calls, tool calls, and cost for each; then score both and
report the two tallies together. A single paired run supports a claim about that run, not a
general one — repeat before claiming an arm is better.
