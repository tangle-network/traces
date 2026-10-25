import type { Args } from './commands.js'
import { parseSince } from './time.js'
import {
  buildSkillUsageReport,
  defaultSkillUsageStorePath,
  readInstalledSkills,
  renderSkillUsage,
  SkillUsageStore,
} from './skill-usage.js'

const SKILLS_SINCE = '30d'

/**
 * `traces skills`: skill use across Claude Code, Codex and Kimi Code sessions,
 * with no model call. Each run reads the bytes sessions appended since the
 * last into the store under `$XDG_STATE_HOME/traces`, then counts the window.
 */
export async function cmdSkills(args: Args): Promise<void> {
  const since = parseSince(args.since ?? SKILLS_SINCE)
  const storePath = defaultSkillUsageStorePath()
  const store = await SkillUsageStore.load(storePath)
  const refreshed = await store.refresh()
  await store.save()
  const report = buildSkillUsageReport(store.list(), await readInstalledSkills(), storePath, { since, refresh: refreshed })
  const json = args.format === 'json'
  if (args.unused) {
    if (json) process.stdout.write(`${JSON.stringify(report.unused, null, 2)}\n`)
    else for (const skill of report.unused) process.stdout.write(`${skill.skill}\t${skill.installedIn.join(',')}\n`)
    return
  }
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderSkillUsage(report)}\n`)
}

