---
name: inspect-agent-traces
description: Use for any question about a Claude Code or Codex session, its session file, or a trace.
---
Run traces; never parse session stores yourself. Everything except `ask` is exact, local and $0.
A ref is a session id or 8+ char prefix, a session file, an OTLP file or dir, a run dir or a bundle dir.

## Any question about one session
1. Run `traces facts <ref>` first. Its sheet is at most 25 lines: harness, cwd, times and parent;
   human turns; tools by name with failures; commands by program with failures and runs inside
   Codex code-mode scripts; subagents, their types and tool calls; tokens; PRs; changed files;
   first failure; final message.
   When the sheet holds the answer, answer.
2. For one field the sheet summarizes, print only that field:
   `traces facts <ref> --format json | jq '<path>'` with a path below.
   Never print the whole JSON: it is tens of KB of span ids.
3. To list commands, typed turns or agent messages by text: `traces facts <ref> --match '<re>'`.
   It prints the count first, then one line per hit, a command's with `ok`, `failed` or `?`;
   a program's run count is on the sheet.

```text
.sessions[0].firstFailure | {name, message, at, spanId}                      first failure, its output
.sessions[0].measurements.tools[] | {name, calls, failed: .outcomes.error}   tool calls by name, failures
.sessions[0].commands.value                                                  programs: runs, failed, inScripts
.sessions[0].pullRequests.value | {created: [.created[] | {number, at}], merged: [.merged[] | {number, at}]}
.sessions[0].humanTurns.value[] | {at, text, spanId, signals}                typed turns, in order
.sessions[0] | {tokens, cost}                                                tokens and cost
.sessions[0].subagents.value[] | {taskName, agentType, status}               subagents spawned, refused ones ERROR
[.sessions[0].changedFiles.value[].path]                                     files changed
.sessions[0] | {first: .firstRecordAt.value, last: .lastRecordAt.value}      first and last record
.sessions[0] | {parentSessionId, rel: .measurements.relationship}            parent, agent path, own task start, children
```

A count in a command's `failed` is a known non-zero exit; a run `inScripts` has no exit code of its own.

## Other jobs
| Question | Command |
|---|---|
| This session, or the one that just ended here | `traces facts --current`, or `traces list --cwd . --last 5` |
| Where it churned, what failed, what it cost | `traces analyze <ref>` |
| Where two runs split | `traces diff <a> <b>` |
| Gate a PR or eval on the path a run took | `traces check <ref> --contract <file>` |
| Is this safe to share | `traces check <path> --share-safe` |
| Watch workers live | `traces watch <run-dir> --once` |
| A judgment question with checked citations ($) | `traces ask <ref> --question '<q>' --budget 1` |
| Keep a session's evidence before a move | `traces bundle <ref> --out <dir>` |

Report the ref, cite span ids, and say "unknown" where traces returns null.
Do not infer success from a completion message. Upload only when asked.

## Then consider
A question you ask twice becomes a `--questions` bank file or a `check --contract`.
