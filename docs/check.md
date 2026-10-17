# Gate CI on a trace contract

[traces](../README.md#docs) › Gate CI on a trace contract

`traces check` is the one gate, and it needs one: `--contract FILE`, the built-in `--contract conformance`, or `--share-safe`.
With none, it exits 2 and names them, so a CI step whose contract variable expanded to nothing never passes.

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
traces check run.jsonl --contract refund-desk.json --format junit > contract.xml
```

`tools.enforced` fails when the harness offered the model a tool the contract does not allow, which a flag such as `--tools` does not prove.
Without `--strict-mcp-config`, the run above is also offered every MCP server the account or project configures.
`retries` fails when a tool repeats a call with the same arguments and nothing proves the repeat is safe.

The trace is a ref: `claude -p --output-format stream-json` output, a Claude Code or Codex session file or id, OTLP spans (a file or a directory), or trace evidence. The input is sniffed, and `--harness claude-code` or `--harness codex` forces the reader of a file.
Only stream-json output records the offered tools and the run's own result.
**A saved interactive session file carries no run status at all** (the `result` record above only exists in `-p` mode), so `run.requireCompleted`/`run.allowedStatuses` always fail on one — write a contract for a session file with no `run` key, like the `refund-desk` example above running against `run.jsonl`.
Every rule prints `pass`, `fail`, `error`, or `skipped` (a rule of an alternative path that did not decide the result).

## Conformance and share safety

`traces check spans.otlp.jsonl --contract conformance` says what a trace can answer: it fails only when not one entry could be read as a span, and lists each capability a missing field costs.
It reads contract OTLP-JSONL, standard OTLP/JSON (`resourceSpans`, one document or the collector file exporter's one envelope per line), and every other ref.

`traces check handoff.md --share-safe` reads each path as bytes, never as a trace, so a handoff, an issue draft and a span export are all just files.
SAFE and SAFE_WITH_WARNINGS pass, UNSAFE fails, and UNKNOWN (a part it could not read) cannot decide.
`--known-secret-env NAME` (repeatable) also fails on that variable's value in any encoding, and never prints it.
Findings name the file and JSON Pointer, never the matched value.

## Exit codes and output

Gates combine: the check exits 1 if any gate fails, else 2 if any could not decide, else 0.

| Exit | Meaning |
|---|---|
| 0 | Every gate passed. |
| 1 | A gate failed: a contract rule, conformance (not a trace), or share safety (UNSAFE). |
| 2 | Could not decide: no gate, a contract that is malformed or contradicts itself, a rule that could not be evaluated, an UNKNOWN share verdict, or a trace that could not be read or whose reference is ambiguous. |

The verdict always goes to stdout in `--format`: `text`, `json` (`.gates[]`, one per gate), `junit` (one test case per rule, per capability, per shared path) or `github` (`::error` and `::warning` workflow commands).
An exit 2 that is not a verdict writes one error on stderr; under `--format json` it is one object `{error, code}`: `code` is `usage` (no gate, or a bad contract), `unknown-verdict` (a gate could not decide), `unreadable` or `ambiguous`.

`traces check --contract <file>` with no ref prints what each compiled rule checks and reads no trace.
Evidence for each gate that did not pass goes under `--out DIR`: per trace, the verdict, the contract, its plain-language statement and the redacted spans the violations cite; `conformance.md`; `share-safe.json`. Without `--out`, `check` writes nothing.
The contract keys and rule semantics are in [agent-eval's trace-contract guide](https://github.com/tangle-network/agent-eval/blob/main/docs/trace-contracts.md).
