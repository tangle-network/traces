# Gate CI on a trace contract

[traces](../README.md#docs) › Gate CI on a trace contract

Two runs can give the same answer while one of them calls a forbidden tool.
An output check passes both; a trace contract fails the wrong one.

```json
{
  "name": "refund-desk",
  "run": { "requireCompleted": true, "maxDurationMs": 300000 },
  "tools": { "required": ["Read"], "forbidden": ["Bash"], "allowed": ["Read", "Grep"], "maxCalls": 10, "enforced": true },
  "retries": { "reads": ["Read", "Grep"] },
  "llm": { "maxCalls": 10 }
}
```

```bash
claude -p "$TASK" --tools Read,Grep --strict-mcp-config --output-format stream-json --verbose > run.jsonl
traces check run.jsonl --contract refund-desk.json --junit contract.xml
```

`tools.enforced` fails when the harness offered the model a tool the contract does not allow, which a flag such as `--tools` does not prove.
Without `--strict-mcp-config`, the run above is also offered every MCP server the account or project configures.
`retries` fails when a tool repeats a call with the same arguments and nothing proves the repeat is safe.

The trace is a ref: `claude -p --output-format stream-json` output, a Claude Code or Codex session file or id, OTLP spans (a file or a directory), or trace evidence. The input is sniffed, and `--harness claude-code` or `--harness codex` forces the reader of a file.
Only stream-json output records the offered tools and the run's own result.
**A saved interactive session file carries no run status at all** (the `result` record above only exists in `-p` mode), so `run.requireCompleted`/`run.allowedStatuses` always fail on one — write a contract for a session file with no `run` key, like the `refund-desk` example above running against `run.jsonl`.
Every rule prints `pass`, `fail`, `error`, or `skipped` (a rule of an alternative path that did not decide the result).

| Exit | Meaning |
|---|---|
| 0 | Every rule passed. |
| 1 | A rule failed. |
| 2 | Could not decide: the contract is malformed or contradicts itself, a rule could not be evaluated, or the trace could not be read or its reference is ambiguous. |

With `--format json`, the verdict is the full report on stdout, and an exit 2 that is not a verdict writes one JSON object `{error, code}` on stderr: `code` is `usage` (no or bad contract), `unknown-verdict` (a rule could not run), `unreadable` or `ambiguous`.

`--junit` writes one test case per rule, and GitHub annotations print under `GITHUB_ACTIONS=true` or `--annotations`.
`traces check --contract <file> --explain` prints what each compiled rule checks and reads no trace.
For a trace that does not pass, the verdict, the contract, its plain-language statement, and the redacted spans the violations cite go to `--evidence` (default `.traces/check`).
The contract keys and rule semantics are in [agent-eval's trace-contract guide](https://github.com/tangle-network/agent-eval/blob/main/docs/trace-contracts.md).
