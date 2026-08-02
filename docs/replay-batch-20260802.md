# Replay-verify batch — first measured replayability and fix-flip rates (2026-08-02)

Provenance: labels shas in `~/bench-cache/ctb-20260801/replay-batch/label-shas.txt`; docker 29.6.1; node v24.16.0; orchestrator :4095 + SDK adapter :4097; seed 17; fix model glm-5.2 via z.ai direct (16k cap, one doubled retry on length-empty); command recorded in `run2-20260802.log` header.
Corpora: dev-32, holdout-1, holdout-2, split3 (all spent mini-SWE splits; submit-only golds excluded per the split3 positional-degeneracy finding).

## Headline (n=22 replayable of 133 label entries)

| Rate | Value |
| --- | --- |
| Replayability (prefix ≤10% divergence AND arm A reproduces recorded returncode at the gold step) | 16/22 = 72.7% |
| Strict signature match (returncode + output substring) | 13/22 = 59.1% |
| Fix-flip (one-shot glm-5.2 corrected command makes the failure vanish) | 9/11 = 81.8% |
| Fix-flip, nonzero-returncode subset | 7/9 = 77.8% |

Exclusions (101 of 133, all named): 65 no-swe-raw-trajectory, 21 no-docker-image, 21 gold-only-submit-step, 4 no-gold-incorrect-step.
LLM: 16 calls, 5 residual failures (long-reasoning cases exceeding the doubled cap), 41,878 prompt + 51,312 completion tokens (~$0.14).


Generated 2026-08-02T00:55:37.309Z.

## Headline

- **Replayability rate: 72.7%** (16/22 replayable cases where the prefix replayed with ≤10% returncode divergence AND arm A reproduced the recorded returncode at the gold step k).
- Signature-strict rate: 59.1% (13/22; additionally requires the recorded error substring in arm A output).
- **Fix-flip rate: 81.8%** (9/11 arm-B-executed cases where the generated fix made the failure vanish).
- Fix-flip rate on recorded-rc≠0 cases: 77.8% (7/9; real recorded failures — a gold step recorded with rc 0 flips vacuously).

## Enumeration

133 label entries across 4 corpora → 22 replayable (SWE-style docker image + ≥1 gold incorrect step), 22 executed.

| exclusion reason | count |
| --- | --- |
| no-swe-raw-trajectory | 65 |
| no-docker-image | 21 |
| gold-only-submit-step | 21 |
| no-gold-incorrect-step | 4 |

Submit-command golds are never counterfactual targets (a gold on the submit step marks a bad submit decision, not a failed command):

| corpus | cases excluded (all golds = submit) | golds skipped within replayable cases |
| --- | --- | --- |
| dev-32 | 1 | 0 |
| holdout-1 | 2 | 0 |
| split3 | 18 | 0 |

## Per-case results

| corpus | trajectory | k | rc@k | prefix | div | div% | armA exit | rc match | sig match | replayed | fix | armB exit | vanished | wall s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
holdout-1 | miniswe-OpenAI__GPT-5-clap-rs__clap-3179-107b… | 33 | 0 | 32 | 4 | 12.5 | 0 | yes | yes | no | — | — | — | 10.6
holdout-1 | miniswe-OpenAI__GPT-5-clap-rs__clap-3421-8c92… | 23 | 2 | 22 | 1 | 4.5 | 2 | yes | no | **yes** | llm-failed | — | — | 7.2
holdout-1 | miniswe-OpenAI__GPT-5-clap-rs__clap-3975-5f1a… | 33 | 101 | 32 | 1 | 3.1 | 127 | no | no | no | — | — | — | 13.0
holdout-1 | miniswe-OpenAI__GPT-5-clap-rs__clap-4248-85bd… | 23 | 2 | 22 | 0 | 0 | 2 | yes | no | **yes** | generated | 0 | **yes** | 35.3
holdout-2 | miniswe-OpenAI__GPT-5-instance_ansible__ansib… | 7 | 127 | 6 | 0 | 0 | 127 | yes | yes | **yes** | generated | 0 | **yes** | 20.0
holdout-2 | miniswe-OpenAI__GPT-5-instance_ansible__ansib… | 13 | 0 | 12 | 0 | 0 | 0 | yes | yes | **yes** | llm-failed | — | — | 13.5
holdout-2 | miniswe-OpenAI__GPT-5-instance_element-hq__el… | 17 | 2 | 16 | 0 | 0 | 2 | yes | no | **yes** | llm-failed | — | — | 25.9
holdout-2 | miniswe-OpenAI__GPT-5-instance_internetarchiv… | 10 | 0 | 9 | 0 | 0 | 0 | yes | yes | **yes** | generated | 0 | **yes** | 4.8
holdout-2 | miniswe-OpenAI__GPT-5-instance_qutebrowser__q… | 15 | 127 | 14 | 0 | 0 | 127 | yes | yes | **yes** | generated | 0 | **yes** | 4.1
holdout-2 | miniswe-OpenAI__GPT-5-instance_qutebrowser__q… | 18 | 127 | 17 | 0 | 0 | 127 | yes | yes | **yes** | generated | 0 | **yes** | 4.1
holdout-2 | miniswe-OpenAI__GPT-5-ponylang__ponyc-1057-56… | 35 | 127 | 34 | 0 | 0 | 127 | yes | yes | **yes** | generated | 0 | **yes** | 4.4
holdout-2 | miniswe-OpenAI__GPT-5-ponylang__ponyc-2532-98… | 12 | 1 | 11 | 0 | 0 | 1 | yes | yes | **yes** | generated | 0 | **yes** | 4.4
holdout-2 | miniswe-OpenAI__GPT-5-sveltejs__svelte-10608-… | 23 | 127 | 22 | 0 | 0 | 127 | yes | yes | **yes** | generated | 0 | **yes** | 4.7
split3 | miniswe-OpenAI__GPT-5-fasterxml__jackson-data… | 18 | 127 | 17 | 0 | 0 | 127 | yes | yes | **yes** | generated | 127 | no | 5.7
split3 | miniswe-OpenAI__GPT-5-instance_ansible__ansib… | 21 | 0 | 20 | 1 | 5 | 2 | no | no | no | — | — | — | 4.8
split3 | miniswe-OpenAI__GPT-5-instance_element-hq__el… | 21 | 0 | 20 | 0 | 0 | 2 | no | no | no | — | — | — | 6.3
split3 | miniswe-OpenAI__GPT-5-nushell__nushell-13357-… | 28 | 127 | 27 | 0 | 0 | 127 | yes | yes | **yes** | generated | 127 | no | 5.9
split3 | miniswe-OpenAI__GPT-5-ponylang__ponyc-2205-2a… | 27 | 127 | 26 | 0 | 0 | 0 | no | no | no | — | — | — | 5.4
split3 | miniswe-OpenAI__GPT-5-ponylang__ponyc-3973-60… | 20 | 0 | 19 | 0 | 0 | 127 | no | no | no | — | — | — | 5.8
split3 | miniswe-OpenAI__GPT-5-simdjson__simdjson-2016… | 24 | 0 | 23 | 0 | 0 | 0 | yes | yes | **yes** | llm-failed | — | — | 5.2
split3 | miniswe-OpenAI__GPT-5-sveltejs__svelte-11913-… | 19 | 0 | 18 | 0 | 0 | 0 | yes | yes | **yes** | generated | 0 | **yes** | 41.2
split3 | miniswe-OpenAI__GPT-5-sveltejs__svelte-9962-5… | 21 | 127 | 20 | 0 | 0 | 127 | yes | yes | **yes** | llm-failed | — | — | 4.3

## LLM fix generation

Model glm-5.2: 16 calls (5 failed), 41878 prompt + 51312 completion tokens.
