# Develop and release

[traces](../README.md#docs) › Develop and release

## Develop

```bash
pnpm install
pnpm build        # dist/index.js (SDK), dist/cli.js (bin) and .d.ts; tests spawn dist/cli.js
pnpm test
pnpm typecheck
pnpm dev facts --current   # run from source through tsx
```

Tests assert through public boundaries: they spawn `dist/cli.js` with argv (`tests/run-cli.ts`) and assert stdout, stderr and exit code, or import SDK exports. Only process boundaries are faked: a fixture HOME and `XDG_STATE_HOME`, the clock, a stub `npm`, and the Python bridge as a stub child process.

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
