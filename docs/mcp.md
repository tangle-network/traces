# MCP server

[traces](../README.md#docs) › MCP server

`traces mcp` serves agent-eval's read-only span tools over stdio, for an MCP client with no shell. An agent with a shell runs the CLI instead.

```bash
claude mcp add traces -- traces mcp spans.otlp.jsonl
claude mcp add traces -- traces mcp --last 5
```

It serves `getDatasetOverview`, `queryTraces`, `countTraces`, `viewTrace`, `viewSpans`, `searchTrace` and `searchSpan` over the spans selected at start. Each declares `readOnlyHint` and `idempotentHint`.

- Spans are redacted before the store is built, and each result again at the boundary. The server refuses to start when the redacted spans are still UNSAFE or UNKNOWN.
- Each result carries an untrusted-text notice, and a result above 512 KiB is refused rather than cut.
- `readSpanSource` is not served: a secret split across two windows matches no redaction rule.

## `traces mcp --help`

```text
Usage: traces mcp <ref…> | --current | --last N | --since T
Serve agent-eval's read-only span tools over stdio, for an MCP client with no shell.
Spans and results are redacted, and it refuses to start if redacted spans are UNSAFE or UNKNOWN.
Each result carries an untrusted-text notice and is capped at 512 KiB.

  --current           the caller's own session: CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID
  --last N            the N newest sessions by file mtime, never the caller's own
  --since T           every session with a record since T: 30m, 2h, 7d or an ISO time
  --cwd DIR           sessions recorded in DIR or under it, or in a worktree of its repo
  --harness ID        read only this harness; with a file ref, force its reader

Examples:
  traces mcp spans.otlp.jsonl
  traces mcp --last 5
  claude mcp add traces -- traces mcp spans.otlp.jsonl
```
