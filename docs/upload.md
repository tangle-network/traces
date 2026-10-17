# Upload

[traces](../README.md#docs) › Upload

`traces upload` sends redacted sessions to the Tangle Intelligence Platform. It needs a ref or `--since`; with neither it exits 2 and prints `--since 24h`.

```bash
traces upload --since 24h --dry-run              # see what would be sent; no network
traces upload --since 24h --no-content           # metadata only
traces upload spans.otlp.jsonl --dry-run --out preview.otlp.jsonl
```

`upload` redacts locally before anything leaves the machine, dedups against sessions already sent, and tags each with its harness, cwd, branch and host.
It then checks each session's final events, exactly as they would be sent, with the share-safety verdict: an UNSAFE or UNKNOWN session is not sent, not previewed and not marked uploaded, and the command exits 1.
It needs `TANGLE_INGEST_URL`, `TANGLE_INGEST_API_KEY` (or `TANGLE_API_KEY`) and `TANGLE_TENANT_ID`; `--dry-run` works without them.

## What redaction catches

Redaction is agent-eval's redaction core, `default` profile: credentials by field name and by value shape (provider keys, GitHub, Slack, AWS and Google tokens, JWTs, bearer headers, private keys, `KEY=secret`, credentials in URLs), and email, card, SSN and phone values. It does not catch names, postal addresses or account numbers in prose. Three postures, strongest first:

1. `--no-content`: metadata only, the same rule as `traces convert <ref> --no-content`.
2. Your own scrubber on a file: `traces convert <ref> --out spans.jsonl`, scrub `spans.jsonl`, then `traces upload spans.jsonl`; upload still redacts and gates it.
3. The redaction core alone.

Run `--dry-run` first. `traces check <path> --share-safe` gives the same verdict for any file ([check](check.md)).

## `traces upload --help`

```text
Usage: traces upload <ref…> | --current | --since T [--dry-run] [--no-content] [--yes]
Send redacted sessions to Tangle Intelligence; one still UNSAFE or UNKNOWN once redacted is refused (exit 1).
Env: TANGLE_INGEST_URL, TANGLE_INGEST_API_KEY (or TANGLE_API_KEY), TANGLE_TENANT_ID.

  --current           the caller's own session: CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID
  --since T           every session with a record since T: 30m, 2h, 7d or an ISO time
  --cwd DIR           sessions recorded in DIR or under it, or in a worktree of its repo
  --harness ID        read only this harness; with a file ref, force its reader
  --dry-run           redact and preview; send nothing
  --no-content        strip prompt and response text; send metadata only
  --yes               skip the confirmation prompt
  --out PATH          with --dry-run: write the redacted OTLP preview to PATH

Examples:
  traces upload --since 24h --dry-run
  traces upload 019a3c7e --yes
  traces upload spans.otlp.jsonl --dry-run --out preview.otlp.jsonl
```
