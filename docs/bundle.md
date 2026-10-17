# Session bundle

[traces](../README.md#docs) › Session bundle

`traces bundle` keeps one session's evidence beyond log rotation, for any reader that must cite the session after the live stores rotate. It never calls a model.

```bash
traces bundle 019a3c7e --out bundle-dir
traces bundle verify bundle-dir            # VERIFIED, or FAILED with each difference (exit 1)
```

The bundle directory holds:

- `session/`: the transcript byte for byte, plus every other source file its spans cite (the subagents directory when one exists);
- `spans.otlp.jsonl`: the session's spans, as every command reads them;
- `facts.json`: the same as `traces facts <ref> --format json`;
- `git-log.txt`: commits in the session window, from the cwd the session recorded;
- `manifest.json`: SHA-256 and size per file, provenance (session id, harness, cwd, transcript hash, window), and every absent artifact with its reason.

A missing transcript fails the assembly. An optional input that is absent (no subagents, no git repo) is recorded in `manifest.absent` with the path it probed.
A bundle directory is a ref: `traces facts bundle-dir` reads the session it keeps, and `traces facts bundle-dir --no-content` gives its evidence without its words.

`bundle verify` checks every listed file's size and SHA-256, and reports a missing file, an unlisted file, a path that climbs out of the directory, and any symbolic link. It proves the bytes are the ones `traces` wrote, not who wrote them.

## `traces bundle --help`

```text
Usage: traces bundle <ref> | --current --out DIR      (then: traces bundle verify DIR)
Keep one session's evidence beyond log rotation: session/, spans, facts, git log, sha256 manifest.
A bundle directory is a ref: traces facts DIR reads it.

  --current           the caller's own session: CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID
  --harness ID        force the reader of a file ref
  --out DIR           a new or empty directory for the bundle

Examples:
  traces bundle 019a3c7e --out evidence/019a3c7e
  traces bundle --current --out evidence/now
  traces bundle verify evidence/019a3c7e
```
