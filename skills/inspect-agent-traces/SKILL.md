---
name: inspect-agent-traces
description: Answer what an agent session did, said, wasted or broke with the traces CLI, not by parsing.
---
Run traces; never parse session stores yourself. Everything except `ask` is exact, local and $0.
A ref is a session id or 8+ char prefix or suffix, a file, an OTLP file or dir, a run dir, a bundle dir,
or a store root; or select with --current, --last N, --since/--until, --cwd.
`traces <command> --help` lists flags and jq paths.

| Question | Command |
|---|---|
| What did this session do (Claude Code, Codex) | `traces facts --current` |
| This session on Pi, OpenCode or Kimi | `traces list --cwd . --last 1`, then `traces facts <id>` |
| The session that just ended here | `traces list --cwd . --last 5`, then `traces facts <id>` |
| What did the person ask, and what did the agent reply | `traces facts <id> --format jsonl` |
| Did we already try X / what did Drew say about Y | `traces facts --since 30d --match '<re>'` |
| Where it churned, what failed, what it cost | `traces analyze <id>` |
| What a trace cannot answer, and why | `traces analyze <id> --format json \| jq .cannotAnswer` |
| Where two runs split | `traces diff <a> <b>` |
| Gate a PR or eval on the path a run took | `traces check <ref> --contract <file>` |
| Is this safe to share | `traces check <path> --share-safe` |
| Watch workers live | `traces watch [<run-dir>] --once` |
| A judgment question with checked citations ($) | `traces ask <id> --question '<q>' --budget 1` |
| Keep a session's evidence before a move | `traces bundle <id> --out <dir>`, then `traces bundle verify <dir>` |

Report the ref and harness, cite span ids, and say "unknown" where traces returns null.
Do not infer success from a completion message. Upload only when asked.

## Then consider
A question you ask twice becomes a `--questions` bank file or a `check --contract`.
