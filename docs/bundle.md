# Session bundle

[traces](../README.md#docs) › Session bundle

`traces bundle` keeps ONE session's evidence beyond log rotation — the input for any reader that must cite the session after the live stores rotate.
It never spends a model call.

```bash
traces bundle <id|path> --out bundle-dir
```

The bundle directory:

- `session/` — the transcript byte-for-byte, plus every other source file its spans cite (the subagents directory when one exists)
- `spans.otlp.jsonl` — the session's spans, as every command reads them
- `facts.json` — the session's facts sheet, the same as `traces facts <ref> --format json`
- `git-log.txt` — commits in the session window, from the cwd the session recorded
- `manifest.json` — SHA-256 + byte count per file, provenance (session id, harness, cwd, transcript hash, session window), and every absent artifact with its reason

A missing transcript fails the assembly loudly.
Every optional input that is absent (no subagents, no recorded cwd, no git repo) is recorded in `manifest.absent` with the probed path — a fact, not an error.

A bundle directory is a ref: `traces facts bundle-dir` reads the session it keeps, and `traces facts bundle-dir --no-content` gives its evidence without the session's own words.
A 0.x bundle, whose spans sit at `derived/trace.otlp.jsonl`, reads the same way.

## Verify a bundle

```bash
traces bundle verify bundle-dir            # VERIFIED, or FAILED with each difference; exit 1 on failure
traces bundle verify bundle-dir --format json
```

`bundle verify` checks every file the manifest lists for its recorded size and SHA-256.
It reports a listed file that is missing, a file on disk that the manifest does not list, a manifest path that is absolute or climbs out of the directory, and any symbolic link.
It proves the bytes are the bytes `traces` wrote. It does not prove who wrote them: anyone who can rewrite a file can rewrite the manifest.
