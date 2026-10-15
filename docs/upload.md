# Upload and share safely

[traces](../README.md#docs) › Upload and share safely

`traces upload` sends sessions to the Tangle Intelligence Platform. `traces verify-safe` says whether files are safe to share.

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
2. **`--redactor <cmd>`**: run an ML PII scrubber (e.g. [`openai/privacy-filter`](https://github.com/openai/privacy-filter)) after the redaction core.
3. Default: the redaction core.

Always `--dry-run` first to see exactly what would be sent.

## External redactors

**Redactors** scrub prompt/response prose with an external PII model (catching names/addresses the regex pass can't), running *after* the built-in redaction:

```bash
# the command reads a JSON array of strings on stdin, writes the scrubbed array on stdout
traces upload --since 24h --dry-run --redactor "my-pii-scrubber"
```

## Check before sharing

`verify-safe` reads files and says whether they are safe to share. It never changes them.

```bash
traces verify-safe bundle-dir                              # share profile (default)
traces verify-safe session.jsonl --profile strict --format json
traces verify-safe out/ --known-secret-env TANGLE_API_KEY  # also look for this exact key, in any encoding
```

| Status | Meaning | Exit |
|---|---|---|
| `SAFE` | Nothing found | 0 |
| `SAFE_WITH_WARNINGS` | Only warnings: raw content, identifiers, embedded media | 0 |
| `UNSAFE` | A credential remains, or personal data under `share` or `strict` | 1 |
| `UNKNOWN` | A file, line or byte range could not be read, so its safety is unknown | 2 |

`.json` files are parsed whole and `.jsonl` or `.ndjson` files line by line. Any other file is scanned as text.
Each finding names the file, line and JSON Pointer, never the matched value.
