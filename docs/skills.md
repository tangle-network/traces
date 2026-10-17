# Skill usage

[traces](../README.md#docs) › Skill usage

`traces skills` says which skills are used, and which installed skills never are, across Claude Code, Codex and Kimi Code sessions on this machine. It calls no model.

```bash
traces skills                     # the last 30 days, with the installed catalog joined
traces skills --unused            # installed skills with no use in the window
traces skills --format json       # rows, unused skills, refresh cost and sweep exclusions
```

A run reads only transcript bytes appended since the previous run, and stores events in `$XDG_STATE_HOME/traces/skill-usage.json`. The first run reads the whole corpus (about two minutes for 41 GB); later runs take seconds. Stored events survive a harness deleting old transcripts.

| Column | Harness | Counted record |
| --- | --- | --- |
| `model` | Claude Code | a Skill tool result that loaded a skill; a failed call does not count |
| `slash` | Claude Code | a `/name` command whose next record is its expanded prompt |
| `read` | Codex, Kimi Code | a completed command that reads `<skill>/SKILL.md`, the closest observable act |

Each event is keyed by its record id, so a resumed session counts once. One command that reads three or more skills is a catalog sweep; its reads are excluded and reported apart.
`traces facts` counts one session's skill use with the same classifier (`measurements.skills`).
`installed` names the harnesses whose catalog lists the skill: `~/.claude/skills` and enabled plugins, `~/.codex/skills` and `~/.agents/skills`.

This package ships one skill, [`inspect-agent-traces`](../skills/inspect-agent-traces/SKILL.md): a table from each question an agent asks about a session to the command that answers it. Install it where your harness reads skills (`~/.claude/skills/inspect-agent-traces/`).

## `traces skills --help`

```text
Usage: traces skills [--since T] [--unused] [--format text|json]
Which skills are used, and which installed skills never are; no model call.
Reads Claude Code, Codex and Kimi Code sessions; each run reads only bytes appended since the last.

  --since T           count use since T: 30m, 2h, 7d or an ISO time (default 30d)
  --unused            only installed skills with no use in the window
  --format text|json  text (default), or json with the refresh cost and sweep exclusions

jq paths (--format json):
  .rows[] | {skill, sessions}  use per skill
  .unused[].skill              installed skills never used in the window

Examples:
  traces skills --since 30d
  traces skills --unused
  traces skills --format json | jq '.rows[] | {skill, sessions}'
```
