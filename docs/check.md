# Check: the one gate

[traces](../README.md#docs) › Check

`traces check` is the one gate, and it needs one: `--contract FILE`, the built-in `--contract conformance`, or `--share-safe`. With none it exits 2 and names them, so a CI step whose contract variable expanded to nothing never passes.

## Trace contracts

Two runs can give the same answer while one calls a forbidden tool. An output check passes both; a trace contract fails the wrong one.

```json
{
  "name": "refund-desk",
  "run": { "requireCompleted": true, "maxDurationMs": 300000 },
  "tools": { "required": ["Read"], "forbidden": ["Bash"], "allowed": ["Read", "Grep"], "maxCalls": 10, "enforced": true },
  "retries": { "reads": ["Read", "Grep"] }
}
```

```bash
claude -p "$TASK" --tools Read,Grep --strict-mcp-config --output-format stream-json --verbose > run.jsonl
traces check run.jsonl --contract refund-desk.json --format junit > contract.xml
traces check --contract refund-desk.json         # what each rule checks; reads no trace
```

`tools.enforced` fails when the harness offered a tool the contract does not allow. A saved interactive session records no run status, so give a contract for a session file no `run` key.
Every rule prints `pass`, `fail`, `error` or `skipped`. The keys and semantics are in [agent-eval's trace-contract guide](https://github.com/tangle-network/agent-eval/blob/main/docs/trace-contracts.md).

## Conformance: integrate your own system

Emit the span contract and pass the file as the ref; no adapter or plugin.

```ts
import { llmSpan, loopSpan, steeredBy, toolSpan } from '@tangle-network/agent-trace-contract'
```

`parent_span_id` is containment and `links` is causality (`steeredBy`), so a retry is linked to the verdict that caused it, not nested under it.
`traces check spans.otlp.jsonl --contract conformance` says what a trace can answer: each capability (`token-accounting`, `cost-attribution`, `tool-usage`, `loop-convergence`, `tree-comparison`, `steering-chain`, `latency-analysis`) available or not, with the reason. It fails only when not one entry reads as a span. It reads contract OTLP-JSONL, standard OTLP/JSON and every other ref.
Nothing is repaired on the way in, and a re-export never validates cleaner than its source: `traces convert` keeps what the producer wrote and carries `traces.source.unreadable_rows`.

## Share safety

`traces check <path> --share-safe` reads each path as bytes, never as a trace, so a handoff, an issue draft and a span export are all just files. SAFE and SAFE_WITH_WARNINGS pass, UNSAFE fails, UNKNOWN cannot decide. `--known-secret-env NAME` also fails on that variable's value, in any encoding. Findings name the file and JSON Pointer, never the value.

## Exit codes and output

Gates combine: 1 if any fails, else 2 if any could not decide, else 0. Exit 2 means no gate, a bad contract, a rule that could not run, an UNKNOWN share verdict, or an unreadable or ambiguous ref.
The verdict goes to stdout in `--format`: `text`, `json` (`.gates[]`), `junit` or `github` (`::error` lines). Evidence for each gate that did not pass goes under `--out DIR`; without it, `check` writes nothing.

## `traces check --help`

```text
Usage: traces check <ref…> | --current | --last N | --since T  --contract FILE|conformance | --share-safe  [flags]
The one gate: does this run pass a trace contract or conform, and is this file safe to share?
A gate is required. --share-safe reads each path as bytes, never as a trace. --contract F with no ref explains F.
Exit 0 pass, 1 any gate fails, 2 a gate could not decide: a bad contract, a rule or verdict that could not run, an unreadable ref.

  --contract FILE|conformance gate on a trace contract file, or on conformance (repeatable)
  --share-safe        gate on whether each path is safe to share, read as bytes: SAFE passes, UNSAFE fails, UNKNOWN cannot decide
  --known-secret-env NAME with --share-safe: an environment variable whose value must appear nowhere (repeatable)
  --current           the caller's own session: CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID
  --last N            the N newest sessions by file mtime, never the caller's own
  --since T           every session with a record since T: 30m, 2h, 7d or an ISO time
  --cwd DIR           sessions recorded in DIR or under it, or in a worktree of its repo
  --harness ID        force the reader of a file ref (claude-code, codex, …)
  --format text|json|junit|github text (default), json, junit or github: the verdict, on stdout
  --out DIR           write evidence for each gate that did not pass under DIR

jq paths (--format json):
  .gates[] | {gate, status}                     each gate and what it decided
  .gates[].report.traces[]?.verdict.violations  each rule a run broke, with span ids

Examples:
  traces check run.otlp.jsonl --contract contract.json --format junit > contract.xml
  traces check spans.otlp.jsonl --contract conformance
  traces check handoff.md --share-safe --known-secret-env TANGLE_API_KEY
```
