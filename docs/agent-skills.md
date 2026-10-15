# Agent skills

[traces](../README.md#docs) › Agent skills

The npm package ships two AgentProfile-ready skills:

| Skill | Use |
|---|---|
| [`inspect-agent-traces`](../skills/inspect-agent-traces/SKILL.md) | select workflows and export deterministic findings |
| [`build-trace-analyst`](../skills/build-trace-analyst/SKILL.md) | write and calibrate a custom analyst |

Load both from GitHub:

```ts
import { defineGitHubResource } from '@tangle-network/agent-interface'

const ref = process.env.TRACES_SKILLS_REF
if (!ref) throw new Error('TRACES_SKILLS_REF must be an immutable commit')

const names = ['inspect-agent-traces', 'build-trace-analyst']
const skills = names.map((name) => defineGitHubResource(`skills/${name}/SKILL.md`, {
  repository: 'tangle-network/traces',
  ref,
  name,
}))
const profile = { name: 'trace-reviewer', resources: { skills } }
```
