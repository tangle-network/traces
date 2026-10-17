# Convert to OTLP

[traces](../README.md#docs) › Convert

`traces convert` hands a session's spans to another tool as contract OTLP-JSONL, the OpenInference span shape every traces command reads.

```bash
traces convert --current --out spans.otlp.jsonl
traces convert sandbox-events.json --out spans.otlp.jsonl
traces convert raw.otlp.jsonl --no-content --out metadata.otlp.jsonl --format json
```

Any ref converts, and these inputs are sniffed: sandbox-events recordings (a tool call is one span, keyed by its message part id, however many events report on it), OpenInference JSONL, and Sandbox live streams (`"backend":"codex"`, read as `codex-exec`; `--harness codex-exec` forces it).
Without `--out` the spans go to stdout. With `--out` stdout gets one summary line, and with `--format json` it is `{out, spans, droppedAttributes}`.

`--no-content` applies the one metadata-only rule (`src/metadata-only.ts`) that `facts` and `upload` share: prompts, replies, tool input and output, error text, working directories, branch names and briefs are dropped, and `droppedAttributes` lists the keys.
`convert` does not redact: redaction belongs where data leaves the machine (`traces upload`, and `traces check <path> --share-safe` before sharing).
A re-export keeps what the producer wrote and carries the rows it could not read, so it never looks cleaner than its source.

## `traces convert --help`

```text
Usage: traces convert <ref…> | --current | --last N | --since T [--out FILE] [--no-content]
Hand spans to another tool: contract OTLP-JSONL, to --out or stdout.
Sandbox events, Codex live streams and OpenInference files are sniffed; --harness forces a reader.

  --current           the caller's own session: CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID
  --last N            the N newest sessions by file mtime, never the caller's own
  --since T           every session with a record since T: 30m, 2h, 7d or an ISO time
  --cwd DIR           sessions recorded in DIR or under it, or in a worktree of its repo
  --harness ID        read only this harness; with a file ref, force its reader
  --latest-turn       only the latest task turn of a resumed Codex or Claude Code session
  --no-content        metadata only: drop prompts, replies, tool input and output, error text, paths and briefs
  --out PATH          write the spans to PATH; stdout gets one summary line
  --format text|json  the --out summary line: text (default) or json {out, spans, droppedAttributes}

jq paths (--format json):
  .droppedAttributes  with --out and --no-content: the attribute keys the metadata-only rule removed

Examples:
  traces convert --current --out spans.otlp.jsonl
  traces convert raw.otlp.jsonl --no-content --out metadata.otlp.jsonl --format json
  traces convert live-stream.jsonl --harness codex-exec > spans.otlp.jsonl
```
