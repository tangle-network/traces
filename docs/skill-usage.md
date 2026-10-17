# Skill usage

[traces](../README.md#docs) › Skill usage

`traces skills` indexes skill records in Claude Code, Codex, and Kimi Code sessions on this machine.
It makes no model call.

```bash
traces skills                     # the last 30 days, with the installed catalog joined
traces skills --since 7d          # another window
traces skills --unused            # installed skills with no use in the window, one per line
traces skills --format json       # rows, unused skills, refresh cost and sweep exclusions
```

The text is one header line and the table; what the run read, the store, the sweep exclusions and the harnesses not indexed are in `--format json`.
A run reads only transcript bytes appended since the previous run.
It parses only lines that can carry a skill record and stores the events in `$XDG_STATE_HOME/traces/skill-usage.json` (`~/.local/state/traces/skill-usage.json` by default).
The first run reads the whole corpus: about two minutes for 41 GB on an M-series Mac.
Later runs take seconds, mostly to stat every session file.
Stored events survive a harness deleting old transcripts.

| Column | Harness | Counted record |
| --- | --- | --- |
| `model` | Claude Code | A Skill tool result that loaded a skill. A failed call does not count. |
| `slash` | Claude Code | A `/name` command whose next record is its expanded prompt. Built-in commands such as `/clear` do not expand and do not count. |
| `read` | Codex | A completed command that reads `<skill>/SKILL.md`. Codex records no skill event, so a read is the closest observable act. It does not show that the skill shaped the outcome. |
| `read` | Kimi Code | A successful `ReadFile` call or shell command that reads `<skill>/SKILL.md`, including streamed arguments. Kimi records no dedicated skill event. |

Each event is keyed by its record ID, so a resumed session that copies earlier records counts once.
One Codex or Kimi command that reads three or more skills is a catalog sweep, such as an audit; its reads are excluded and reported separately.
`traces facts` counts one session's skill use with the same classifier (`measurements.skills`), so the two agree on what a use is.
`installed` names the harnesses whose catalog lists the skill now: `~/.claude/skills` and enabled plugins for Claude Code, and `~/.codex/skills` and `~/.agents/skills` for Codex.
OpenCode, Pi, Gemini, Factory, and other harnesses are not indexed.
