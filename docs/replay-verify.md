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

## Orchestrator prerequisites

replay-verify talks to a sandbox API (`--base-url`); in local development that is the sandbox SDK adapter in front of an orchestrator running the docker driver.
Arbitrary docker images need the platform control runtime (node injected from a mounted Nix profile) because sidecar-less images rarely ship node: the orchestrator needs `NIX_PROFILE_PATH` set, and this CLI passes the `SIDECAR_PLATFORM_CONTROL_RUNTIME` container-env marker on create (the production sandbox API derives the same marker from `agent: false`).
