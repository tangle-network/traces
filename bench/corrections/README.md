# Correction-signal recall

`pnpm bench:corrections` asks how well the turn signals of `traces facts` find the turns where a person corrected the agent.
It scores each signal against judged labels, beside the lexical classifier that traces 0.23.1 used.

| Arm | Fires on a typed turn when |
|---|---|
| `interrupt` | the person interrupted the agent since their previous turn |
| `rejected-tool` | the person rejected a tool call since their previous turn |
| `after-claim` | the agent's last message opened by claiming the work was done |
| `union` | any of the three |
| `lexical` | the 0.23.1 `correction` reaction matched the turn's text ([`lexical-baseline.ts`](lexical-baseline.ts), frozen) |
| `lexical-any` | any 0.23.1 corrective reaction matched: correction, frustration, jargon or structure |

Each arm is scored only on labelled turns that join a facts row with the same session id and the same instant, so every arm is scored on the same turns.
The output gives recall, precision and F1 for each arm, with 95% Wilson intervals, and then applies the rule for analyze section 7 (spec §2.2).
That section is titled "Correction signals" only when the union's recall beats each lexical arm's recall at no lower precision.
Otherwise it is titled "Interrupts and rejections", and no output, doc or skill calls these signals corrections.

## Run it

```bash
traces facts <refs> --format jsonl > facts.jsonl
pnpm -s bench:corrections labels.jsonl facts.jsonl            # a table
pnpm -s bench:corrections labels.jsonl facts.jsonl --format json
traces facts <refs> --format jsonl | pnpm -s bench:corrections labels.jsonl
```

`labels.jsonl` has one judged turn per line: `{"session": "<id>", "at": "<ISO time>", "label": true}`, where `label` is true when the judge called the turn a correction.
Labels and the sessions they come from are private, and they never enter this repository.

## Labels from a voice-ledger run

voice-ledger's adjudication step keeps a blind calibration set of 150 turns, all labelled by trace-mine's Opus judge (`scripts/adjudicate.mjs`, `CALIBRATION = 150`).
With `OUT` set to the run directory, export them and read their sessions on each host:

```bash
jq -c --slurpfile map "$OUT/corpus/adjudicate/_map.json" \
  '([$map[0]["calib-000"][], $map[0]["calib-001"][]] | INDEX(.)) as $calib
   | select($calib[.id]) | {host, harness, session, at: .ts, label: .corr}' \
  "$OUT/corpus/turns-final.jsonl" > labels.jsonl
# On each host and harness the labels name (here, Claude Code on this host):
traces facts $(jq -r --arg h "$(hostname -s | tr A-Z a-z)" 'select(.host == $h and .harness == "claude-code") | .session' labels.jsonl | sort -u) \
  --harness claude-code --format jsonl >> facts.jsonl
```

Drop `select($calib[.id])` to score every turn the run labelled. Turns outside the calibration set carry Sonnet labels from the same judge prompt; the run reports their agreement with Opus.

## Results, 2026-10-16 (traces 1.0 step 10)

The 150 blind calibration turns, with Opus labels: 148 joined a facts row (44 corrections), 2 did not, and 0 were ambiguous.

| Arm | Fires | Recall [95% CI] | Precision [95% CI] | F1 |
|---|---:|---|---|---:|
| interrupt | 10 | 0.091 [0.04, 0.21] | 0.400 [0.17, 0.69] | 0.148 |
| rejected-tool | 4 | 0.068 [0.02, 0.18] | 0.750 [0.30, 0.95] | 0.125 |
| after-claim | 21 | 0.091 [0.04, 0.21] | 0.190 [0.08, 0.40] | 0.123 |
| union | 31 | 0.205 [0.11, 0.34] | 0.290 [0.16, 0.47] | 0.240 |
| lexical | 26 | 0.341 [0.22, 0.49] | 0.577 [0.39, 0.74] | 0.429 |
| lexical-any | 47 | 0.591 [0.44, 0.72] | 0.553 [0.41, 0.69] | 0.571 |

On a larger set of 4,509 labelled turns (1,500 corrections; Sonnet agreed with Opus on 90.7% of the calibration turns, kappa 0.786), the union scored recall 0.252 at precision 0.382, against lexical 0.325 at 0.595 and lexical-any 0.545 at 0.555.

**Decision: analyze section 7 is titled "Interrupts and rejections".**
The union's recall is below both lexical arms, and so is its precision.
Before this step the after-claim signal matched its words anywhere in the agent's message.
That union reached recall 0.682 on the calibration turns, but at precision 0.353 against lexical-any's 0.553, so it failed the rule too.

### The completion-claim detector

A person's reply after a completion claim was a correction about as often as any other reply.
On the 4,509 turns, that rate was 0.362 with the old claim rule and 0.342 with the new one, against a base rate of 0.333; no stricter claim rule tried raised it.
So after-claim cannot carry correction recall.
What it can do is mark real claims, which analyze quotes and which the live rule `completion-claim-without-verification` reads.

The old rule matched a claim word (`merged`, `verified`, `done`, …) anywhere in the message, and it flagged 2,988 of 5,259 Claude Code human turns (57%).
The new rule reads only the opening sentence, with markdown marks removed, and treats a denial (`not`, `still`, `failed`, …) or a question there as no claim.
It flags 871 of those 5,259 turns (17%), and Codex goes from 88 of 270 turns to 39.

To measure claim precision, 80 agent messages that the old rule flagged were drawn at random, 40 that the new rule keeps and 40 that it drops.
They were shuffled and labelled by hand, with the rule that flagged each one hidden.
The question for each was: does the message tell the person the work is finished, fixed, shipped or verified?
A progress report, a plan, an analysis, a failure, or a part done with the asked-for outcome still pending counted as no.

| Rule | Claims among the messages it flags |
|---|---|
| old: a claim word anywhere | 0.435 (weighted by how often each half occurs) |
| new: the opening sentence | 0.725 [0.57, 0.84] |

The new rule keeps 46% of the true claims that the old rule flagged.
The claims it drops open with words outside its list, such as "back", "confirmed", "synced" or "live".
