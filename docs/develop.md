# Develop and release

[traces](../README.md#docs) › Develop and release

## Local merge gate

`he gate fetches the pushed revision and installs frozen dependencies. Build before tests, which spawn the CLI.

```bash
beelink-gate auto https://github.com/tangle-network/traces.git <full-commit-sha> -- bash -euc \
  'pnpm check:source && pnpm typecheck && pnpm build && pnpm test && pnpm run verify:contracts-corpus && pnpm check:package'
```

PRs and branch pushes run no CI. `he corpus checks real trace fixtures; `check:package` checks the packed CLI. Use the package's Node engine range; tag publication retains its own runtime and qualification.

## Release

`main` is protected, and nothing publishes until a `v*` tag:

1. Change `package.json` (and `pnpm-lock.yaml`) to the version, and its notes to `docs/release-<version>.md`, through a pull request.
2. Tag the merge commit `vX.Y.Z` and push the tag.
3. The Publish workflow checks the tag is on `main` and matches `package.json`, builds, publishes to npm with provenance, and creates the GitHub release from `docs/release-<version>.md`.

`pnpm check:package` proves the tarball ships the `traces` binary and the skill. To retry a failed publish, run the Publish workflow with the existing tag.

## How quality is measured

[`bench/audit/`](../bench/audit) asks 19 questions about three synthetic sessions and scores answers by exact match, with no model judging anything.
Three arms answer it: `facts` (`traces facts <ref> --format json` mapped by fixed rules, $0; `pnpm test` holds its score to `bench/audit/facts-score.json`, which may only rise), `raw-files` (one `claude -p` agent per question over the raw files) and `traces` (the same agent with `traces` on PATH and the skill installed in its own HOME).
`pnpm bench:audit large` runs any arm over one synthetic session of about 50,000 spans.
The release rule: the traces arm answers at least as many questions as the raw-files arm, at lower cost. [`bench/audit/README.md`](../bench/audit/README.md) has the commands and the rule, and [`bench/parity/`](../bench/parity) scores each parser traces retires against the command that replaces it ([parsers](parsers.md)).
