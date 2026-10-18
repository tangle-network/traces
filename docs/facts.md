# Session facts

[traces](../README.md#docs) › Session facts

`traces facts` states what happened in a session, exactly, for $0: who acted, the turns, tools, commands, pull requests, first failure, tokens, cost and the time lost.
It calls no model, and the same spans always give the same sheet.

```bash
traces facts --current                                      # the text sheet: at most 25 lines a session
traces facts 019a3c7e --format json                         # the whole sheet, with span ids
traces facts --since 2026-10-14 --until 2026-10-15          # one day, across every harness
traces facts --since 1d --format jsonl                      # one row per typed turn
traces facts --since 30d --match '^gh pr merge'             # each matching turn, agent message or command
```

## The text sheet

Text is the default; pass `--format json` to parse. Each session takes at most 25 lines, times in UTC:

```
99d75d4b claude-code · agent-dev-container (feat/gap-closure) · 10-15 09:12→12:40 UTC · active 3.1 h
who dotfiles sha256:5843…ca56 · claude-opus-5-5 (from session-identity)
human turns 14 (excluded: injected 6, fleet 2, relay 1) · interrupts 2
tools 412 (Bash 220 (31 failed), Edit 88, Read 61, …) · subagents 6 (lint, test, docs, …)
commands 236: pnpm test 41 (19 failed), git status 30, rg 22, gh pr 9 (1 failed), git push 6, …
tokens in 2.1M · out 310k · cache read 88M · $38.20 list price (Router rates)
waste 52 min: `pnpm test` failed 14× in a row (31 min) · 2 stalls ≥ 10 min (21 min) · reverts 1
PRs opened #11021 #11022 · merged #11006 · changed 23 files
first failure 09:40 Bash: exit 1 (blame agent, span 6be1…)
final "Merged #11006; …"
```

A fact the spans cannot support reads `unknown` with the reason. A selection of several sessions starts with one line naming the count, the window and the sessions it could not read.

## What it states

Three rules hold for every field. Every fact is about this session's own agent: a subagent's work is named in `subagents` and counted in `subagentTools` (by tool name, with failures), never added to the parent's totals. Every fact names its `spanIds`. A fact the spans cannot support is `null` with its reason, never a guess and never a silent zero; `partial` marks a value known to be incomplete.

| Fact | What it is |
|---|---|
| `toolCalls`, `toolCallsByName` | tool calls this session's agent made, by name. A Codex command that checks work is `exec_command.verify` |
| `subagents` | every subagent-spawning call, with its task name and `agentType` (Claude Code's `subagent_type`); a refused Codex spawn is `ERROR`. On the sheet, `subagent tools` counts their calls |
| `commands` | the programs the session's commands ran (`labctl run`, `git push`, `pnpm test`), most runs first: `runs`; `failed`, runs that were their call's only command (a `cd` aside) and ended in error; and `inScripts`, runs inside a Codex code-mode script, which records no exit code of its own; `nonZeroExits`, each run `failed` counts with the `code` its output printed (`null` when it printed none), `inScript`, `at` and `spanId`; and `lastSpanId`, the latest run. `--match` gives each run's span. A code-mode `tools.exec_command` call inside `for (const x of [...])` counts once per element, `${x}` or `{cmd: x}` taking each value; inside any other loop, once as written. On the sheet, a tool's `(31 failed)` counts its calls that ended in error |
| `pullRequests` | pull requests created and merged, by number or head branch, with when the command ran and the span that named it |
| `humanTurns` | turns a person typed, each with `author`, `answered`, `reply`, `interrupted` and `signals` (`interrupt`, `rejected-tool`, `after-claim`) |
| `excludedTurns`, `turnsByActor` | every left-out turn, by reason and author, so the filter is checkable |
| `tokens`, `cost` | from one owner on every harness; `input` is the whole prompt, cache included; `cost` is agent-runtime's `priceTokens`, labelled `list price (Router rates)` |
| `measurements.waste` | failing streaks (3 or more identical failures), stalls of 10 minutes or more that no turn ended, `git revert` and `reset --hard`, repeated commands |
| `measurements.activeMinutes`, `measurements.skills` | minutes worked (gaps capped at 10), and skills used, by the classifier `traces skills` uses |
| `repo`, `cwd`, `changedFiles`, `finalMessages` | the repository and recorded cwd, files the session changed, and the last message of the agent and each subagent |
| `record` | in `--format json`, `{file, line}` of the session record a fact came from, to quote or cite without searching the files: on each `humanTurns` entry, on `firstFailure` (the failing call's result, else the call), on each `commands` row (its latest run's result) and each of its `nonZeroExits`, and on each `changedFiles` entry (the call that first changed it). `null` when no record names it; absent under `--no-content` |
| `firstFailure` | the first failure among the session's own records, with its blame; `unknown` when no status was recorded, `ambiguous` when two ended at once |
| `agent` | the profile, model, harness and directive that acted, from the root span, else the session-identity record |

## Turns

A turn is one a person typed into this session. History a fork or a compaction replays, harness-injected blocks (instructions, environment context, notifications, skill expansions) and a second record of the same turn are left out, each listed in `excludedTurns`. A turn the reader called human is checked once more by org convention: a fleet or session message, or a first turn over 1,500 characters, is `fleet`; a long markdown-heavy paste is `relay`; a harness command (`/model`) is left out.
For Codex, the harness's own labels (`content_item_kinds`) decide: a message is the person's when every item is a `user.` kind. An answer to Codex's question tool (`<send_user_message_question_reply>`) is a turn, and so is a turn with an attached image, whose text is the report Codex wrote of it, without the `<image>` wrapper.

`--format jsonl` prints one row per typed turn: `host`, `harness`, `session`, `cwd`, `at`, `author`, `text`, `answered`, `reply`, `interrupted`, `signals` and `spanId`.
`--match RE` prints one row per matching human turn, agent message or shell command (`sessionId`, `kind`, `at`, `spanId`, `source`, text clipped to 300 characters). A command row of a named session also has `record` and `lastLine`, the last non-blank line of the command's whole output, which the row's text never shows. A command row's `failed` follows the `commands` rule; it is `null`, `?` in text, when its call's status is not its own. Commands match one simple command at a time, so `^traces ` matches `cd x && traces facts …` and never `tangle traces list`. Over a window it reads the turn index under `$XDG_STATE_HOME/traces/turn-index`, which reads only bytes appended since the last search.

## Pull requests

`pullRequests` scans each command the way a shell would, so a `gh pr create` inside a heredoc body never counts.
A pull request is named by its number when the command or an output that joins to it shows one, else by its head branch.
A create whose call returned while it still ran takes the number a later poll of that process printed.
In a Codex code-mode script, each tool result the script printed is decoded (`exit_code` or `session_id`, and the command's output), and a later script's `write_stdin` poll of the session counts as that poll.
A create counts only where an output shows `gh` answered: a script that completed says nothing about its commands.

## `--no-content`, windows and exit status

`--no-content` withholds conversation, commands, paths and assignments and keeps the measurements; it is a local view, not a share-safety verdict (`traces check <path> --share-safe` is).
With `--since`/`--until`, the turn facts keep only turns inside `[since, until)`; every other fact covers the whole session. `selection` names the window, the sessions outside it and every unreadable session.
A named session that cannot be read exits 2; in a window it is skipped, named, and the run exits 0.

## SDK

```ts
import { buildSessionFactsReport, computeSessionFacts, renderSessionFacts } from '@tangle-network/traces'

const [facts] = computeSessionFacts(spans)
console.log(facts.toolCalls.value, facts.toolCalls.spanIds)
console.log(renderSessionFacts(buildSessionFactsReport(spans)))
```

## `traces facts --help`

```text
Usage: traces facts <ref…> | --current | --last N | --since T [flags]
What happened, exactly, for $0: who acted, turns, tools, commands, PRs, first failure, tokens, cost, time lost.

  --current           the caller's own session: CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID
  --last N            the N newest sessions by file mtime, never the caller's own
  --since T           every session with a record since T: 30m, 2h, 7d or an ISO time
  --until T           close the --since window (exclusive); same forms
  --cwd DIR           sessions recorded in DIR or under it, or in a worktree of its repo
  --harness ID        read only this harness; with a file ref, force its reader
  --latest-turn       only the latest task turn of a resumed Codex or Claude Code session
  --match RE          one row per human turn, agent message or shell command matching RE (a command: ok, failed or ?)
  --no-content        omit conversation, commands, paths and assignments
  --format text|json|jsonl text (default, 25 lines a session), json (the sheet), or jsonl: one row per typed turn
  --out PATH          write the sheet to PATH; stdout gets one summary line

jq paths (--format json):
  .sessions[0].humanTurns.value[] | {at, text, spanId}                        each typed turn, its time and span
  .sessions[0].commands.value[]                                               programs run: runs, failed, inScripts
  .sessions[0].measurements.tools[] | {name, calls, failed: .outcomes.error}  tool calls by name, and failures
  .sessions[0] | {firstFailure, tokens, cost, agent: .agent.value}            first failure, tokens, cost, who acted

Examples:
  traces facts --current
  traces facts 019a3c7e --format json | jq '.sessions[0].measurements.waste'
  traces facts --since 30d --match '^gh pr merge'
```
