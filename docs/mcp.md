# MCP server

[traces](../README.md#docs) › MCP server

`traces mcp` serves the selected traces to an MCP client over stdio.

```bash
claude mcp add traces -- traces mcp ./spans.otlp.jsonl
claude mcp add traces -- traces mcp --harness claude-code --last 5
```

It serves agent-eval's seven trace tools: `getDatasetOverview`, `queryTraces`, `countTraces`, `viewTrace`, `viewSpans`, `searchTrace` and `searchSpan`.
Each tool declares `readOnlyHint` and `idempotentHint` in its MCP annotations, and its description says that returned trace text is untrusted.

- The spans are redacted before the store is built — every span's name, attributes, status message and causal links' attributes, every field the store reads — and each result is redacted again at the boundary. The server then reassesses the redacted spans and refuses to start when they are still UNSAFE or UNKNOWN, the same gate `upload` applies to what it sends.
- Each result carries an `untrusted` notice beside it.
- A result above 512 KiB is refused with an error rather than truncated.
- `readSpanSource` is not served. It reads original source bytes in windows the caller picks, and a secret split across two windows matches no redaction rule.
