# Ask a question

[traces](../README.md#docs) › Ask a question

`traces ask` answers a question `traces facts` cannot, with checked `trace://` citations. It is the one command that calls a model.

```bash
traces ask 019a3c7e --question "Which command failed first, and why?" --budget 1
traces ask --last 3 --questions questions.json --budget 2 --out answers
```

`--budget` is required: the most the run may spend, shared by every question. Each question spends at most the smaller of `--budget` and $2, within 1,800 s, and 4 run at once.
A question is at most 705 characters, so the engine sees it whole; put detail in an entry's `instructions`.

## Questions from a file

The file is a JSON array of question strings or entries `{ id?, question, instructions?, answerSchema? }`.
An `answerSchema` makes the answer one JSON value a scorer can compare; it accepts `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `title` and `description`, and any other keyword is rejected before the run starts.

```json
[
  "Which pull requests did this session open?",
  { "id": "merged", "question": "Which pull requests were merged?", "answerSchema": { "type": "array", "items": { "type": "integer" } } }
]
```

## What the run guarantees

- Every question receives the [facts](facts.md) sheet before its first model call.
- Every `trace://<trace>/span/<span>` citation is resolved; an unresolvable one fails that question. Findings pass the same evidence gate as the built-in kinds, and refusals are counted by reason.
- A failed question never stops the others. Ctrl-C keeps the answers already bought.
- `answers.json` and `report.md` (under `--out`) are written before the exit code is decided. Some questions unanswered: exit 2 with `code: partial`.
- Each cost carries its provenance (`observed`, `estimated` or `uncaptured`); an uncaptured cost stays null.
- The ledger reserves each call's maximum before it runs, so a budget below one call is refused before any spend.

## Setup and refusals

`ask` needs `TANGLE_API_KEY` (or `OPENAI_API_KEY` with `OPENAI_BASE_URL`) and the DSPy bridge: with `uv` installed it runs `uvx --from agent-eval-rpc[dspy]==<version>`, or `TRACES_PYTHON` names a Python that has it. A missing key or bridge exits 2 with `code: setup` before anything is read or spent.

| Refusal from the endpoint | What `ask` does |
|---|---|
| 408, 425, 429, 5xx, no connection | retries the call: 2 s doubling to 60 s, 10 attempts, inside the question's deadline |
| 401, 402, 403 | stops every question; exit 2, `code: auth` |
| model not allowed, not found or unpriced | stops every question; exit 2, `code: model` |
| anything else | fails that question alone |

## SDK

```ts
import { analysisEngineFromEnv, runTraceQuestions } from '@tangle-network/traces'

const result = await runTraceQuestions({
  questions: [{ id: 'first-failure', question: 'Which command failed first?' }],
  spans,
  engine: analysisEngineFromEnv({ model: 'gpt-5.6-luna', maxCostUsd: 1 }),
  budgetUsd: 2,
})
```

## `traces ask --help`

```text
Usage: traces ask <ref…> | --current | --last N | --since T --question TEXT [flags]
A question facts cannot answer, with checked trace:// citations: the only command that calls a model.
Each question spends at most min(--budget, $2) within 1800 s; 4 run at once. Some unanswered: exit 2.
Needs TANGLE_API_KEY (or OPENAI_API_KEY) and uv, or TRACES_PYTHON naming a Python with agent-eval-rpc[dspy].

  --current           the caller's own session: CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID
  --last N            the N newest sessions by file mtime, never the caller's own
  --since T           every session with a record since T: 30m, 2h, 7d or an ISO time
  --cwd DIR           sessions recorded in DIR or under it, or in a worktree of its repo
  --harness ID        read only this harness; with a file ref, force its reader
  --latest-turn       only the latest task turn of a resumed Codex or Claude Code session
  --question TEXT     a question (repeatable, at most 705 characters)
  --questions FILE    a JSON array of questions: strings or {id?, question, answerSchema?}
  --budget USD        required: the most the run may spend, shared by every question
  --model ID          the analyst model (default gpt-5.6-luna)
  --format text|json  text (default): the report; json: each answer, its citations, failure and cost
  --out DIR           write answers.json and report.md under DIR; stdout gets one summary line

jq paths (--format json):
  .questions[] | {id, status, answer, failure}  each answer, or why it has none

Examples:
  traces ask --current --question "Which command failed first?" --budget 1
  traces ask 019a3c7e --questions questions.json --budget 5 --out answers
  traces ask --last 3 --question "Did it verify the fix?" --budget 2 --format json | jq '.questions[0].answer'
```
