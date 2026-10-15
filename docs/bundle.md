# Session bundle

[traces](../README.md#docs) › Session bundle

`traces bundle` assembles ONE session's durable evidence directory — the input for any downstream consumer that must cite the session after the live stores rotate.
It composes commands this CLI already owns and never spends a model call.

```bash
traces bundle --harness claude-code --session <id|path> --out bundle-dir
```

The bundle directory:

- `session/` — the transcript byte-for-byte, plus the sibling subagents directory when one exists
- `derived/` — `session-index.json`, the deterministic `report.md`, `evidence.jsonl`, and the OTLP span artifact
- `ledger/` — the repo's `.evolve` slices for the session window: `experiments.jsonl` and `skill-runs.jsonl` rows inside the padded span window, `current.json` / `scorecard.json` / `progress.md` copied whole, the latest flat `handoff-*.md`, and reflections dated inside the window
- `repo/git-log.txt` — commits in the session window from the session's cwd
- `manifest.json` — `view`, SHA-256 + byte count per file, provenance (session id, harness, cwd, transcript hash, session window), every absent artifact with its reason, per-slice row counts, and the bundle's known limits

A missing transcript fails the assembly loudly.
Every optional input that is absent (no subagents, no `.evolve`, no git repo) is recorded in `manifest.absent` with the probed path — a fact, not an error.

## Two views, two consumers

A bundle has two kinds of reader, and they need opposite things.

- An **auditor** cites the session and needs every source byte. That is the FULL view — what `traces bundle` writes, `manifest.view: "full"`.
- A **writer** must reach its own conclusion about the session, so it must not be able to read the conclusion that session already reached. That is the EVIDENCE-ONLY view, `manifest.view: "evidence-only"`.

The full bundle cannot serve the writer. Its transcript holds every word the session wrote, including the shell call that authored an earlier report, so a check that looks for the report FILE passes while the report CONTENT is right there. Projecting is the fix, not grepping:

```bash
traces bundle      --harness claude-code --session <id|path> --out bundle-dir
traces bundle-view bundle-dir --view evidence-only --out writer-dir
```

The evidence-only view carries an explicit allow-list — `derived/session-index.json`, `derived/evidence.jsonl`, and the structured `ledger/` records (`current.json`, `scorecard.json`, `skill-runs.jsonl`). Everything else is excluded **by name** in `manifest.excluded`, with its SHA-256 and one of four rules:

| rule | what it covers |
|---|---|
| `session-source` | `session/` — the transcript and every subagent transcript |
| `session-text-derived` | `derived/report.md` (quotes the first prompt line and evidence excerpts) and `derived/trace.otlp.jsonl` (spans carry the full prompt and response text) |
| `authored-prose` | `ledger/progress.md`, `ledger/handoff-*.md`, `ledger/reflections/`, `ledger/experiments.jsonl` free-text, `repo/git-log.txt` |
| `not-allow-listed` | any other path, including one a later version of `traces` adds — the view can only narrow by accident, never widen |

The allow-list is the structure. A content check is the proof it is right: before anything is written, every candidate is compared against every excluded file for shared 8-word runs of prose, with identifiers (paths, URLs, hashes) and this package's own constant strings scrubbed from both sides first. A shared run in a repo ledger file drops that file with `rule: "content-signature"` and the match count; a shared run in an artifact `traces` derives is a defect in the derivation and no view is written at all. `manifest.projection.leakCheck` records the width, the sources compared, and the result — always `matches: 0`, because a match means no view exists.

A projected view also carries the full bundle's `manifest.json` hash, so an auditor can prove which record it came from. Projecting a view of a view is refused.

## Verify a bundle

```bash
traces bundle verify bundle-dir            # VERIFIED, or FAILED with each difference; exit 1 on failure
traces bundle verify writer-dir --format json
```

`bundle verify` checks every file the manifest lists for its recorded size and SHA-256.
It reports a listed file that is missing, a file on disk that the manifest does not list, a manifest path that is absolute or climbs out of the directory, and any symbolic link.
For a projected view it also checks that the full bundle it names still has the manifest bytes the view recorded; a moved or deleted source is `unavailable`, not a failure.
It proves the bytes are the bytes `traces` wrote. It does not prove who wrote them: anyone who can rewrite a file can rewrite the manifest.
