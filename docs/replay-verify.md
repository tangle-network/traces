# replay-verify — executed proofs for trajectory findings

An analyst finding today is a cited claim: "step 37 is where the run went wrong."
`traces replay-verify` upgrades that claim to an executed proof: it replays the trajectory prefix inside a real sandbox on the trajectory's own docker image, then runs two counterfactual arms at the error-critical step k:

- **Arm A** re-executes the recorded step k and checks the recorded failure reproduces — same returncode plus a stable output substring (the failure signature).
- **Arm B** executes a corrected step k and checks the failure vanishes (exit 0 and the signature absent).

Each arm gets a fresh sandbox with its own prefix replay, so arm B is never contaminated by arm A's side effects.
Under the hood each arm is an agent-eval `runCounterfactual` meta-run (`layer='meta'`, `parentRunId` = the ingested trajectory run), with the sandbox-backed `CounterfactualRunner` from `src/replay-verify.ts` supplying the `executeFrom` callback that scaffold leaves to consumers.

## Usage

```sh
traces replay-verify \
  --steps normalized/<traj_id>/steps.json \
  --image <docker_config.base_image> \
  --at 37 \
  --cwd /home \
  --fix-command "sed -i '145d' /home/zstd/programs/zstdcli.c && make -C /home/zstd zstd -j2 V=1" \
  --signature 'undeclared (first use in this function)' \
  --out ./replay-out \
  --base-url http://127.0.0.1:4097 --api-key-env SANDBOX_API_KEY
```

Outputs `replay-verdict.json` (machine-readable: prefix divergences, both arms, timings, run ids) and `report.md` (human-readable with real stdout/stderr excerpts).
`traces replay-verify --help` lists every flag.

## Execution semantics

Every step runs the way mini-SWE ran it: a fresh `/bin/sh` subshell from a fixed workdir.
The action is base64-piped into `sh` after `cd`-ing to `--cwd`, so arbitrary quoting in recorded actions survives, and the reported exit code is the action's own.

Prefix divergences (recorded returncode ≠ replayed exit) are recorded per step, never abort the replay, and are surfaced in the verdict.
A high divergence rate is a finding about replayability, not a failure of the tool.

## Honest limits

- **Only SWE-style trajectories are replayable.** The docker image comes from the raw trajectory's `info.docker_config.base_image`; terminal-bench-style tasks that need external compose peers (databases, services) cannot be replayed with a single image.
- **Commands never run as root.** The sandbox platform pins every customer command to the configured non-root subprocess identity (uid 1000 by default) — a deliberate security invariant with no override. Trajectories recorded as root (mini-SWE's default) will hit permission errors on root-owned trees. Fix by deriving a replay image that chowns the working tree to the sandbox uid:

  ```dockerfile
  FROM mswebench/facebook_m_zstd:pr-1733
  RUN chown -R 1000:1000 /home
  ```

  This preserves the recorded failure semantics for build/edit workflows (they depend on writability, not on uid 0). The verdict records the image actually used.
- **Copy-on-write forks are firecracker-only.** `box.branch()` could replay the prefix once and fork at k; on the docker driver each arm replays the prefix in its own fresh sandbox instead. Wall-time cost is one extra prefix replay per arm.
- **Environment drift shows up as divergence.** The sandbox mounts a workspace at `/home/agent` and injects platform env; recorded observations that depend on exact `ls` output or env contents can differ while returncodes still match. Only returncodes drive the divergence count.
- **The failure signature is derived, not assumed.** Default: the first recorded-output line containing "error". Compiler quote glyphs vary with locale, so prefer an explicit `--signature` with an ASCII-stable substring.

## Batch mode — replayability and fix-flip rates

`traces replay-verify-batch` runs the proof at corpus scale over gold-labeled CodeTraceBench corpora and measures two headline numbers nobody had before:

- **Replayability rate** — fraction of replayable cases where the prefix replays with ≤10% returncode divergence AND arm A reproduces the recorded returncode at the gold step k (k = the first gold incorrect step from `incorrect_stages[].incorrect_step_ids` that is a real mid-trajectory action; see the submit-step rule below).
- **Fix-flip rate** — fraction of arm-B-executed cases where a generated corrected command made the failure vanish.

```sh
traces replay-verify-batch \
  --corpus dev-32=<labels.json>::<prepared-dir> \
  --corpus holdout-1=<labels.json>::<prepared-dir> \
  --out ./replay-batch-out \
  --fix generate --max-fix-cases 30 --seed 17 \
  --base-url http://127.0.0.1:4097 --api-key-env SANDBOX_API_KEY \
  --fix-api-key-env ZAI_GLM_API_KEY
```

A corpus is a gold label file plus a prepared directory (`normalized/<traj_id>/steps.json` + `extracted/<traj_id>/swe_raw/**`). Replayable = the raw trajectory carries `info.docker_config.base_image` AND the labels mark ≥1 gold incorrect step that is a real mid-trajectory action. The batch:

- reports the true replayable count and a per-reason exclusion table (`--enumerate-only` prints both without touching a sandbox);
- **skips submit-command golds when choosing k.** A gold step whose action is the agent's end-of-run submit (`COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`) marks a bad submit *decision*, not a failed command — there is no executable failure to reproduce, so it is never a counterfactual target. k advances to the first non-submit gold; a case whose golds are all submit steps is excluded as `gold-only-submit-step`. The report carries a per-corpus table of both counts (this matters most for split3, whose gold labels concentrate on the submit decision);
- derives the working directory from the recorded run config (`info.config.environment.cwd`), falling back to `docker_config.cwd`, then to the first `pwd` observation;
- builds and caches a uid-1000 derived image per (base image, cwd) pair — `ctb-replay:<hash>-uid1000` — because the sandbox platform pins commands to a non-root identity;
- runs every case serially (image pulls contend on disk and registry bandwidth) and records pull/build failures as report rows, never silent skips;
- uses the recorded per-step timeout (`info.config.environment.timeout`) unless `--step-timeout` overrides it.

Fix generation (`--fix generate`) runs ONE chat completion per arm-A-reproduced case against an OpenAI-compatible endpoint (default: glm-5.2 on z.ai). The prompt carries the gold step's action and observation, ±3 surrounding steps, and the task statement; the reply must be a single corrected shell command. Cases beyond `--max-fix-cases` are excluded by a seeded random sample and marked `sampled-out` in the report. Arm B replays the prefix in its own fresh sandbox and executes the corrected command; `failureVanished` = exit 0 with the failure signature absent.

Honest-reporting notes baked into the report:

- A gold step whose recorded observation carries **no returncode** can never satisfy "arm A reproduces the recorded returncode": it counts against the replayability rate and the per-case table says why.
- A gold step recorded with **returncode 0** (the labeled mistake succeeded — a wrong-direction action, not a crash) reproduces trivially; for such cases `failureVanished` is vacuous, so read the headline's separate fix-flip rate on the recorded-rc≠0 subset.

Outputs: `batch-report.json`, `batch-report.md` (headline + exclusion + pull-failure + per-case tables), `cases.jsonl` (incremental, crash-safe), and one directory per case with the full `replay-verify` artifacts plus `armB-result.json`.

## Analyst wire — finding in, executed proof out

`replayVerifyFinding` (exported from the package root, `src/replay-wire.ts`) is the entry point the analyst product calls:

```ts
import { replayVerifyFinding } from '@tangle-network/traces'

const { invocation, fixCommand, verdict } = await replayVerifyFinding(
  { trajId: 'miniswe-…-zstd-1733-786102c1', subject: 'incorrect-steps-37-37-unescaped-consequence-39' },
  { corpora, out: './proof', fixCaller, baseUrl, apiKey },
)
```

The subject grammar is the analyst benchmark's `incorrect-steps-<first>-<last>-<escaped|unescaped>-consequence-<step>`; `--at` is the finding's **first** incorrect step (the finding's claim, which may differ from the gold label). The wire resolves the trajectory across the given corpora, generates the arm-B fix through the same one-call generator (or accepts a pre-supplied `fixCommand`), and returns the full `ReplayVerdict`. It throws with a precise reason when the finding cannot be replayed (malformed subject, unknown trajectory, non-SWE case, step out of range) — the product surfaces that reason instead of a proof.

## Product surface — verified findings

`traces verify-findings` (and `traces analyze --verify-findings`) runs this proof per recorded analyst finding and annotates each with `reproduced | fix-flipped | divergent | not-replayable` plus a receipt directory.
Unlike the wire above it accepts the shapes analysts actually emit (`incorrect-step-<n>` subjects, `metadata.block_first_step`, `trace://` evidence refs) and never throws on a finding-shaped dead end — the dead end becomes the finding's honest `not-replayable` receipt.
See [Verified findings](./trace-analysts.md#verified-findings-executed-replay).

## Orchestrator prerequisites

replay-verify talks to a sandbox API (`--base-url`); in local development that is the sandbox SDK adapter in front of an orchestrator running the docker driver.
Arbitrary docker images need the platform control runtime (node injected from a mounted Nix profile) because sidecar-less images rarely ship node: the orchestrator needs `NIX_PROFILE_PATH` set, and this CLI passes the `SIDECAR_PLATFORM_CONTROL_RUNTIME` container-env marker on create (the production sandbox API derives the same marker from `agent: false`).
