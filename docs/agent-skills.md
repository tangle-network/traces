# Agent skills

[traces](../README.md#docs) › Agent skills

The npm package ships one AgentProfile-ready skill:

| Skill | Use |
|---|---|
| [`inspect-agent-traces`](../skills/inspect-agent-traces/SKILL.md) | select workflows and export deterministic findings |

Load it from GitHub:

```ts
import { defineGitHubResource } from '@tangle-network/agent-interface'

const ref = process.env.TRACES_SKILLS_REF
if (!ref) throw new Error('TRACES_SKILLS_REF must be an immutable commit')

const names = ['inspect-agent-traces']
const skills = names.map((name) => defineGitHubResource(`skills/${name}/SKILL.md`, {
  repository: 'tangle-network/traces',
  ref,
  name,
}))
const profile = { name: 'trace-reviewer', resources: { skills } }
```
