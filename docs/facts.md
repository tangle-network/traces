# Session facts

[traces](../README.md#docs) › Session facts

`traces facts` prints the deterministic session-facts sheet: the answers a session audit needs first, computed straight from the spans.
No model call, no engine, no budget — it costs $0 and always returns the same sheet for the same spans.

```bash
traces facts <id>                                           # the text sheet: at most 25 lines a session
traces facts <id> --format json                             # the whole sheet, with span ids, for programs
traces facts --harness codex --last 5
traces facts spans.otlp.jsonl --format json --out facts.json
traces facts --harness claude-code --since 7d               # every session with a record in the last week
traces facts --since 2026-10-14 --until 2026-10-15          # one day, across every harness
traces facts --since 1d --format jsonl                      # one row per typed turn: author, answered, reply, signals
traces facts --since 30d --match '^gh pr merge'             # each matching human turn, agent message or shell command
```

## The text sheet

Text is the default; pass `--format json` to parse the sheet. Each session takes at most 25 lines, in this order, and times are UTC:

```
99d75d4b claude-code · agent-dev-container (feat/gap-closure) · 10-15 09:12→12:40 UTC · active 3.1 h
who dotfiles sha256:5843…ca56 · claude-opus-5-5 (from session-identity)
human turns 14 (excluded: injected 6, fleet 2, relay 1) · interrupts 2
tools 412 (Bash 220, Edit 88, Read 61, …) · subagents 6 (lint, test, docs, …)
skills verify 2, simplify 1
tokens in 2.1M · out 310k · cache read 88M · $38.20 list price (Router rates)
waste 52 min: `pnpm test` failed 14× in a row (31 min) · 2 stalls ≥ 10 min (21 min) · reverts 1
PRs opened #11021 #11022 · merged #11006 · changed 23 files
first failure 09:40 Bash: exit 1 (blame agent, span 6be1…)
final "Merged #11006; …"
```

`who` and `skills` appear when known, and a session that is a spawned child says `child of <parent>` in its first line.
A fact the spans cannot support reads `unknown` with the reason.
A selection of several sessions, or a window, starts with one line naming the count, the window and the sessions it could not read.

## Waste

`measurements.waste` says where the session's own agent lost time, and `measurements.activeMinutes` how long it worked:

- `failingStreaks`: a command that failed 3 or more times in a row (a loop is 3 identical calls), with its runs, its minutes from the first failed run's start to the last one's end, and their span ids. A success of the same command, or a turn sent in, ends a streak. Commands are compared with their whitespace collapsed; under `--no-content` the command is `null`.
- `stalls`: gaps of 10 minutes or more between the session's own records that no turn sent in ended. A gap a person ended (or a fleet message, a parent agent, or an interrupt) is their time, not a stall. Each stall names its start, its minutes, the span that ended it, and whether a command's result or a background command's notice (`<task-notification>`) ended it (`waiting on a command`) or anything else did (`idle`).
- `rollbacks`: `git revert` and `git reset --hard` commands, one per simple command as the shell splits the script.
- `repeatedCommands`: commands run more than once and the runs beyond each one's first, the way `reflect/scripts/self-audit` counts rework.
- `minutes`: the time inside a failing streak or a stall, each minute counted once.
- `activeMinutes`: the minutes between consecutive records, each gap capped at 10.

A command measure is `null` with its reason when no tool call kept its arguments, and `minutes` is then `null` too.

## Turns, search and jsonl

Each `humanTurns` entry carries `author` (always `human` there), `answered` (the agent's last message before it), `reply` (its first message after), `interrupted` (the person stopped the agent's work on this turn) and `signals`: `interrupt`, `rejected-tool` and `after-claim`, each counted since the person's previous human turn.
A turn the reader called human is checked once more by org convention: harness text still reads `injected`, a fleet, session-to-session or operator message, or a first turn over 1,500 characters (a lane brief a tool typed in), is `fleet`, a long markdown-heavy paste after the first turn is `relay`, and a harness command (`/model`, `/clear`) is excluded with the person as its author.
A `codex exec` run's first turn is its script's brief (`injected`), every prompt of a Codex session the Claude Code plugin opened is `agent`, and a Codex fork the person made counts the turns typed into it.
`excludedTurns` groups every left-out turn by reason and `author`.

`--format jsonl` prints one row per typed turn (`human`, `fleet` or `relay`): `host`, `harness`, `session`, `cwd`, `at`, `author`, `text`, `answered`, `reply`, `interrupted`, `signals` and `spanId`.
A `fleet` row carries no signals: those are a person's.
`host` is this machine's short name, or for a trace archive's `<host>/home` store root, that host.

`--match RE` prints, instead of the sheet, one row per human turn, agent message or shell command that matches (`sessionId`, `kind`, `at`, `spanId`, `source`, and the text clipped to 300 characters around the hit).
Shell commands are matched one simple command at a time, as the shell would split the script, so `^traces ` matches `cd x && traces facts …` and never `tangle traces list`.
Over a window, `--match` reads the turn index under `$XDG_STATE_HOME/traces/turn-index`, which keeps a byte cursor per session file, so a repeated search reads only what sessions appended since the last one; its rows are a whole read's, row for row. A named ref is read whole.
`--no-content` withholds the text both of these read, so it is refused with either.

## Who acted

`agent` names the profile, model, harness, skill set and directive variant of the session, under agent-trace-contract's `ATTR` keys: from the root span's `agent.*` attributes, else (Claude Code) the record dotfiles' SessionStart hook writes at `~/.local/state/session-identity/claude-code/<session_id>.json`, else the directive variant in `~/.claude/directives-log.jsonl`.
Each key comes from the first source that has it, and `source` names the first source that supplied any; with a store root, both files are read under it.
`agent.value` is `null` with the reason when no source names anyone.

## Time window

`--since <t>` and `--until <t>` open a half-open time window `[since, until)`; each takes `30m`/`2h`/`7d` before now or an ISO date, and either may be left open.
With a window, `facts` selects **every** session with a record that starts or ends inside it, not only the newest (`--last <n>` still caps it to the newest `n` per harness, and a ref still names the input).
Sessions are read one at a time, and a session file last modified before `since` is not read, because it cannot hold a later record.
Within a selected session, `humanTurns`, `excludedTurns` and `turnsByActor` keep only turns that started inside the window, so a one-day run counts only that day's turns; every other fact covers the whole session.
The report's `selection` states the window, both rules, the sessions read whose records all fell outside it (`outsideWindow`), and every session that could not be read (`unreadSessions`, each with its reason).
A report built without a window has `selection: null`.

## What it states

| Fact | What it is |
|---|---|
| `toolCalls` | TOOL spans **this session's agent** actually invoked. Synthesized lifecycle spans are excluded and counted in `synthesizedToolSpans`, so the total is not high by the number of subagents; calls a spawned subagent made are excluded and counted in `subagentToolSpans` |
| `toolCallsByName` | the same calls by tool name, so a category decision is the reader's, not a guess |
| `subagentToolSpans` | TOOL spans excluded because a subagent, not this agent, made the call. Zero on a trace that carries no subagent records |
| `subagents` | every subagent-spawning call with the task name the adapter recorded |
| `pullRequests` | the pull requests the commands created and merged, each named by number or head branch, with the command span and how the identity was joined. Scanned the way a shell reads the script, so a `gh pr create` inside a heredoc body is not a command that ran |
| `repo` | the repository: `git.repository`, `git.branch` and `git.commit` on the session's spans. The harness's own record when it kept one, else read from the checkout at the recorded cwd when the session was read, so the branch can be the checkout's current one. `null` with the reason when no span names one |
| `cwd` | the working directory the harness recorded for the session (`traces.session.cwd` on the root span): Claude Code's first record `cwd`, Codex's `session_meta` cwd, Pi's session header, OpenCode's session directory (the older JSON store: its messages' `path.cwd`), Factory's `session_start`. Never decoded from a directory name or inferred from paths; `null` with the reason when the source names none or its adapter does not read one |
| `humanTurns` | `user.prompt` turns a person typed into this session, in order, with the timestamp. Inherited fork or compaction history, harness-injected blocks, and a second record of the same turn are excluded — each listed in `excludedTurns` with its reason and span ids, never silently dropped. `turnsByActor` shows every turn by actor so the filter is checkable. Each turn's `answered` is the last message this session's own agent wrote before it (not a subagent's, not inherited history), clipped to 1,500 characters with a `… [+N chars]` marker, with its span in `answeredSpanId`; `null` when the agent had written no text yet in the spans read (a `--latest-turn` read starts at the latest task, so its first turn has none) |
| `excludedTurns` | every `user.prompt` turn `humanTurns` left out, grouped by the reason, with the span ids |
| `turnsByActor` | every `user.prompt` turn by actor, so the human filter is checkable |
| `finalMessages` | the last message of the session's own agent, and of each subagent task, kept apart |
| `changedFiles` | paths the harness recorded for the changes it applied, plus paths named by patch headers and file-editing tool arguments, with the operation |
| `firstRecordAt` / `lastRecordAt` | the earliest span start and latest span end among this session's own records — a subagent that outlives the session does not stretch its window |
| `unreadRecords` | records the session reader could not parse, from the session's integrity receipt |
| `tokens` | this session's own agent's tokens, from one owner (`src/execution.ts`) on every harness: `input` is the whole prompt, cache reads and writes included (Claude Code's `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` per response, counted once per message id; Codex's own cumulative `input_tokens`, which already holds its cached tokens), with `output`, `cacheRead`, `cacheWrite`, `reasoning` (null when the harness does not report it), `modelCalls` and `byModel`. A harness's cumulative counter (Codex's `total_token_usage`) is preferred to a sum of its calls. Every count is null, with `unavailable`, when no call reports usage |
| `cost` | what the Router would charge for `tokens`: agent-runtime's `priceTokens` per model, labelled `list price (Router rates)`. `usd` is null, with `unavailable`, when a model has no Router price, no model is recorded, or the tokens are unknown |
| `tokenTotal` | `tokens.input + tokens.output`, null with the same reason when the tokens are unknown |
| `measurements.waste`, `measurements.activeMinutes` | where the session's own agent lost time, and how long it worked (see [Waste](#waste)) |
| `measurements.skills` | skills used, by name and kind (`model`, `slash`, `read`), counted by the classifier `traces skills` uses |
| `firstFailure` | the first failure among this session's own records, ranked by agent-eval's fixed precedence: the innermost ERROR span that ended first, else a span whose `agent.outcome` is `fail`, else `none` — spans were observed and none of them failed. When every span is UNSET (a capture that failed before any status was written), or a session has no records of its own at all (every span is `traces.span.subagent` — spawned work folded into this trace, with nothing this agent recorded itself), the status is `unknown`, not `none`: the record does not say whether the run failed. Failures that ended at the same instant are `ambiguous` and list the candidates instead of picking one. `blame` separates machine and provider failures from the agent's own, and is `unknown` rather than `agent` when no evidence names the agent. A found failure carries `at`, when its span ended |

Three rules hold for every field:

- **Every fact is about this session's own agent.** Some harnesses fold a spawned agent's transcript into the parent's trace, so a trace can carry both what this agent did and what a child it spawned did (Claude Code writes one file per subagent under the session directory and the adapter reads them all). The child's work is named in `subagents` and counted in `subagentToolSpans`; it is never added to the parent's totals.

- **Every fact names its span ids.** `spanIds` lists the spans the value was computed from, so any number here can be opened and checked. The sheet itself is not a span and cannot be cited.
- **A fact the spans cannot support is `null` with its reason.** It is never guessed, and never a silent zero. `partial` marks a measured value that is known to be incomplete — a truncated patch, or a list above the entry cap.

## Exit status

Without a window, `facts` exits non-zero when a selected session cannot be read at all: a session that produced no record spans would otherwise print a sheet of zeros stating, in the sheet's own voice, that the session did nothing.
With a window, a session that cannot be read — the parser failed, or no record could be read — is named in `selection.unreadSessions` with its reason and a warning on stderr, and the run still exits 0 with the sessions it could read; it is never counted as a session with no turns.

## Why it exists

The trace tools are bounded, and above their bounds they answer a different question than the one asked.
`viewTrace` returns a `≤20`-entry span-name histogram once a trace exceeds `perCallByteCeiling` (150,000 bytes).
`countTraces` counts traces, not spans.
`viewSpans` needs span ids the reader does not have yet.
`searchTrace` stops at 500 hits.

A model asked "how many tool calls ran?" therefore adds up a capped histogram and decides by eye which names belong.
Measured over twelve private audit sessions, the model-backed analyst arm scored a deterministic mean of **0.389**.
Extracting the same answers mechanically from the OTLP spans those runs already wrote scored **0.858** — the facts were present and exact the whole time.
The sheet is that extraction, made part of the tool.

## Pull requests

The command spans carry the script, the exit code and the output.
`pullRequests` scans each script the way a shell would, so a `gh pr create` inside a heredoc body or a commit message is not counted as a command that ran.
A pull request is named by its number when the command or an output that joins to it shows one, and by its head branch when neither does.
A create whose stdout was redirected away takes the number a later output states for the same branch on the same line, and names the span that stated it.
A failed `git push && gh pr create` counts only when the output shows `gh` itself answering; otherwise the shell never reached it.
A trace whose spans carry no executed command returns `null` with that reason, because "no pull requests" and "the spans cannot say" are different answers.

## Human turns

A user message is one the human typed into this session.
Three filters run in order, and each excluded span is listed in `excludedTurns` with its reason, never silently dropped:

- history the session carries but did not receive — the prefix a fork copies from its parent, and the turns a compaction replays;
- turns whose actor is not a person — an instruction file, an environment-context block, a system reminder, a subagent notification, a turn-aborted marker, or a skill or slash-command expansion;
- a second record of the turn before it, meaning the same text at the same instant with no model call, tool call or assistant message between them.

For Codex the actor comes from the harness's own per-item labelling (`internal_chat_message_metadata_passthrough.content_item_kinds`) whenever the record carries it: a message is the person's exactly when every item in it is a `user.` kind.

## Measurements and `--no-content`

The same facts sheet includes observed tool outcomes, captured input/output byte
volumes, call-to-result intervals, compaction boundaries and available context
sizes, the waste measures, and the session's skill counts.
Each measurement carries coverage; absent telemetry remains unknown.
`--format json` prints the sheet as one compact line, with no distribution of a single value.
`facts --no-content` withholds conversation (including each turn's `answered` text),
command, changed-file, working-directory and assignment text while retaining
measurement metadata. This is a local metadata view, not a
share-safety certificate.

## Prepared context for analysts

The same sheet is supplied to the model-backed analysts before their first model call, through `TraceAnalystDefinition.prepareContext`.
It reaches the built-in kinds run by `analyze --llm` and `improve`, and it reaches every `traces ask` question inside `PREPARED CONTEXT:`.

- The sheet is bounded at `PREPARED_CONTEXT_BYTE_CEILING` (30,000 bytes), a fifth of the `perCallByteCeiling` of 150,000 the trace tools work to, so the rest of the budget stays available for the tool calls the model still makes.
- When the sheet does not fit, fields are shed from the largest downward and the shed is listed in `omitted_fields`. The tool-call counts are the last facts to go.
- Receiving the sheet changes an analyst's behavior, so its version carries `SESSION_FACTS_VERSION_SUFFIX` (`+session-facts.` and the sheet's `measurementVersion`). `createTraceAnalyst` records `prepare_context` in the exact-run identity, and a changed prepared context must not hide behind an unchanged version.
- The sheet is not evidence. Citations still resolve against the raw spans, which is why every fact names its span ids rather than asking the model to trust the sheet.

Pass `sessionFactsContext: false` to `analyzeSpans` to run an analyst without it.

## SDK

```ts
import { buildSessionFactsReport, computeSessionFacts, renderSessionFacts } from '@tangle-network/traces'

const [facts] = computeSessionFacts(spans)
console.log(facts.toolCalls.value, facts.toolCalls.spanIds)
console.log(renderSessionFacts(buildSessionFactsReport(spans)))
```

SDK consumers use `buildSessionFactsReport(spans, { includeContent: false })`.
`await priceReport(report)` fills each session's `cost` from agent-runtime's `priceTokens`. It loads that price table only when a session has tokens to price; an unpriced report says `not priced yet` in `cost.unavailable`.
Pass `window: { since, until }` (ISO bounds) for the windowed report `facts --since/--until` prints, and use
`createSessionFactsReportBuilder(options)` (`add(spans)`, `addUnread(...)`, `build()`) to build it one session at a time.
Cache by `measurementVersion` and `sourceDigest`; `evidenceThrough` is the latest
recorded endpoint, not current liveness. Computing the sheet parses the supplied
spans; returning a stored sheet needs no model call or trace scan. Semantic
judgments remain attributed analyst results.
