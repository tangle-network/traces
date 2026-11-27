# Develop and release

[traces](../README.md#docs) › Develop and release

## Local merge gate

The gate fetches the pushed revision and installs frozen dependencies. Build before tests, which spawn the CLI.

```bash
beelink-gate auto https://github.com/tangle-network/traces.git <full-commit-sha> -- bash -euc \
  'pnpm check:source && pnpm typecheck && pnpm build && pnpm test && pnpm run verify:contracts-corpus && pnpm check:package && pnpm check:release'
```

PRs and branch pushes run no CI. The corpus checks real trace fixtures; `check:package` checks the packed CLI; `check:release` runs npm admission when `package.json` names an unpublished version. Use the package's Node engine range; tag publication retains its own runtime and qualification.

## Release

`main` is protected, and nothing publishes until a `v*` tag:

1. Change `package.json` and its notes in `docs/release-<version>.md` through a pull request. Refresh the lockfile when dependency resolution changes.
2. The gate's `pnpm check:release` packs the candidate and runs the Agent Runtime admission script at the commit [the publish workflow](../.github/workflows/publish.yml) pins, against the latest npm release; it reads public types as well as exports and package metadata. A refused candidate fails the gate: change the version or the change until it passes.
3. Tag the merge commit `vX.Y.Z` only once that gate passed, and push the tag.
4. The Publish workflow checks the tag is on `main` and matches `package.json`, builds, admits the packed artifact again, publishes to npm with provenance, and creates the GitHub release from `docs/release-<version>.md`.

`pnpm check:package` proves the tarball ships the `traces` binary and the skill. To retry a failed publish, run the Publish workflow with the existing tag. A tag that admission refused at publish published nothing: delete it (`git push origin :refs/tags/vX.Y.Z`), so the newest tag is again a version npm serves, and release the fix as the next version.

## How quality is measured

[`bench/audit/`](../bench/audit) asks 19 questions about three synthetic sessions and scores answers by exact match, with no model judging anything.
Three arms answer it: `facts` (`traces facts <ref> --format json` mapped by fixed rules, $0; `pnpm test` holds its score to `bench/audit/facts-score.json`, which may only rise), `raw-files` (one `claude -p` agent per question over the raw files) and `traces` (the same agent with `traces` on PATH and the skill installed in its own HOME).
`pnpm bench:audit large` runs any arm over one synthetic session of about 50,000 spans.
The release rule: the traces arm answers at least as many questions as the raw-files arm, at lower cost. [`bench/audit/README.md`](../bench/audit/README.md) has the commands and the rule, and [`bench/parity/`](../bench/parity) scores each parser traces retires against the command that replaces it ([parsers](parsers.md)).
