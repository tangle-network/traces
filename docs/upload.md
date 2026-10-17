# Upload and share safely

[traces](../README.md#docs) › Upload and share safely

`traces upload` sends sessions to the Tangle Intelligence Platform. `traces check <path> --share-safe` says whether files are safe to share.

`upload` **redacts locally before anything leaves the machine**, dedups against already-uploaded sessions, and tags each with metadata (harness, cwd, git branch, host).
It then checks the final events of each session, exactly as they would be sent, with the share-safety verdict.
A session that is UNSAFE or UNKNOWN is refused: it is not sent, not written to the dry-run preview, and not marked uploaded, and the command exits 1.

```bash
traces upload --since 24h --dry-run     # see exactly what would be sent; no network
traces upload --since 24h --no-content  # send metadata only; drop all prompt/response text
traces upload --since 24h               # send it
```

It needs `TANGLE_INGEST_URL` (or `TANGLE_ORCHESTRATOR_URL`), `TANGLE_INGEST_API_KEY` (or `TANGLE_API_KEY`), and `TANGLE_TENANT_ID`. Without them, `--dry-run` still works fully.

## Redaction scope: read this before uploading prose

Redaction is agent-eval's redaction core ([docs/redaction.md](https://github.com/tangle-network/agent-eval/blob/main/docs/redaction.md)), `default` profile.
It finds credentials by field name (`apiKey`, `x-api-key`, `client.secret`, `refreshToken`) and by value shape (provider keys, GitHub, Slack, AWS and Google tokens, JWTs, bearer headers, private keys, `KEY=secret` assignments, credentials in URLs), and replaces the whole string.
It replaces email, card, SSN and phone values in place.
Token counts such as `input_tokens` and `max_tokens` are kept.
It runs over every span attribute, including the captured prompt/response text.

It does **not** catch names, postal addresses or account numbers written in prose. Those need a context-aware model. Three postures, strongest first:

1. **`--no-content`**: upload metadata only (tool calls, tokens, timing, loop signal); no prose leaves the machine.
2. **Your own scrubber on a file**: `traces convert <ref> --out spans.jsonl`, run an ML PII scrubber (e.g. [`openai/privacy-filter`](https://github.com/openai/privacy-filter)) on `spans.jsonl`, then `traces upload spans.jsonl`. Upload still applies the redaction core and the share-safety check to that file.
3. Default: the redaction core.

Always `--dry-run` first to see exactly what would be sent.

## Check before sharing

`traces check <path> --share-safe` reads files as bytes and says whether they are safe to share, under the `share` profile. It never changes them, and never reads a path as a trace.

```bash
traces check bundle-dir --share-safe
traces check session.jsonl --share-safe --format json
traces check out/ --share-safe --known-secret-env TANGLE_API_KEY  # also look for this exact key, in any encoding
```

| Status | Meaning | Exit |
|---|---|---|
| `SAFE` | Nothing found | 0 |
| `SAFE_WITH_WARNINGS` | Only warnings: raw content, identifiers, embedded media | 0 |
| `UNSAFE` | A credential or personal data remains | 1 |
| `UNKNOWN` | A file, line or byte range could not be read, so its safety is unknown | 2 |

`.json` files are parsed whole and `.jsonl` or `.ndjson` files line by line. Any other file is scanned as text.
Each finding names the file, line and JSON Pointer, never the matched value.
