import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildSkillUsageReport,
  readInstalledSkills,
  SkillUsageStore,
  type SkillUsageSources,
} from '../src/skill-usage.js'

const SESSION = '11111111-2222-3333-4444-555555555555'
const CODEX_SESSION = '01a10a34-ca81-71d0-997e-f336570e67fd'

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function skillCall(id: string, skill: string, ts: string): string {
  return line({
    type: 'assistant',
    uuid: `a-${id}`,
    sessionId: SESSION,
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] },
  })
}

function skillResult(id: string, ts: string, result: { commandName?: string; text?: string; error?: boolean }): string {
  return line({
    type: 'user',
    uuid: `r-${id}`,
    sessionId: SESSION,
    timestamp: ts,
    ...(result.commandName ? { toolUseResult: { success: true, commandName: result.commandName } } : {}),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: result.text ?? 'Launching skill', ...(result.error ? { is_error: true } : {}) }],
    },
  })
}

function expansion(parentUuid: string, text: string, sourceToolUseID?: string): string {
  return line({
    type: 'user',
    uuid: `m-${parentUuid}`,
    parentUuid,
    isMeta: true,
    sessionId: SESSION,
    ...(sourceToolUseID ? { sourceToolUseID } : {}),
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}

function slashCommand(uuid: string, name: string, ts: string): string {
  return line({
    type: 'user',
    uuid,
    sessionId: SESSION,
    timestamp: ts,
    message: { role: 'user', content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>` },
  })
}

function codexRead(id: string, command: string, ts: string, output = '# Skill\n'): string {
  return line({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'CommandExecution', id, command: ['/bin/zsh', '-lc', command], exit_code: 0, aggregated_output: output },
    },
  })
}

async function fixture(): Promise<{ root: string; sources: SkillUsageSources; claudeFile: string; codexFile: string; store: string }> {
  const root = await mkdtemp(join(tmpdir(), 'traces-skill-usage-'))
  const projects = join(root, 'claude', 'projects', '-repo')
  const codexDay = join(root, 'codex', 'sessions', '2026', '10', '04')
  await mkdir(projects, { recursive: true })
  await mkdir(codexDay, { recursive: true })
  return {
    root,
    sources: { claudeProjects: join(root, 'claude', 'projects'), codexSessions: [join(root, 'codex', 'sessions')] },
    claudeFile: join(projects, `${SESSION}.jsonl`),
    codexFile: join(codexDay, `rollout-2026-10-04T20-56-34-${CODEX_SESSION}.jsonl`),
    store: join(root, 'state', 'skill-usage.json'),
  }
}

describe('SkillUsageStore', () => {
  it('counts loaded skills and expanded slash commands, not failures or built-in commands', async () => {
    const f = await fixture()
    await writeFile(f.claudeFile, [
      skillCall('toolu_a', 'reflect', '2026-10-01T10:00:00Z'),
      skillResult('toolu_a', '2026-10-01T10:00:01Z', { commandName: 'reflect' }),
      expansion('r-toolu_a', 'Base directory for this skill: /home/u/.claude/skills/reflect\n\n# Reflect', 'toolu_a'),
      // A subagent transcript records only the result text.
      skillResult('toolu_b', '2026-10-01T11:00:00Z', { text: 'Launching skill: product-design' }),
      skillResult('toolu_c', '2026-10-01T12:00:00Z', { text: 'Skill "code-review" launched (forked execution, running in the background).' }),
      skillResult('toolu_d', '2026-10-01T13:00:00Z', { text: 'Unknown skill: missing', error: true }),
      slashCommand('u-loop', 'loop', '2026-10-02T09:00:00Z'),
      expansion('u-loop', '# /loop — schedule a recurring prompt'),
      slashCommand('u-clear', 'clear', '2026-10-02T09:05:00Z'),
      line({ type: 'user', uuid: 'out-clear', parentUuid: 'u-clear', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } }),
    ].join(''))

    const store = await SkillUsageStore.load(f.store)
    const [claude] = await store.refresh(f.sources)

    expect(claude).toMatchObject({ harness: 'claude-code', files: 1, filesRead: 1, eventsAdded: 4 })
    const events = store.list().map((e) => [e.kind, e.skill, e.root, e.id])
    expect(events).toEqual([
      ['model', 'reflect', '/home/u/.claude/skills', 'toolu_a'],
      ['model', 'product-design', null, 'toolu_b'],
      ['model', 'code-review', null, 'toolu_c'],
      ['slash', 'loop', null, 'u-loop'],
    ])
  })

  it('reads only appended bytes and resolves a slash command whose expansion arrives later', async () => {
    const f = await fixture()
    await writeFile(f.claudeFile, slashCommand('u-reflect', 'reflect', '2026-10-02T09:00:00Z'))
    const first = await SkillUsageStore.load(f.store)
    await first.refresh(f.sources)
    expect(first.size).toBe(0)
    await first.save()

    const tail = expansion('u-reflect', 'Base directory for this skill: /home/u/.claude/skills/reflect\n\n# Reflect')
    await appendFile(f.claudeFile, tail)
    const second = await SkillUsageStore.load(f.store)
    const [claude] = await second.refresh(f.sources)

    expect(claude!.bytesRead).toBe(Buffer.byteLength(tail))
    expect(second.list()).toMatchObject([{ kind: 'slash', skill: 'reflect', root: '/home/u/.claude/skills', ts: '2026-10-02T09:00:00Z' }])
    await second.save()

    const third = await SkillUsageStore.load(f.store)
    const [unchanged] = await third.refresh(f.sources)
    expect(unchanged).toMatchObject({ filesRead: 0, bytesRead: 0, eventsAdded: 0 })
  })

  it('counts a record copied into a resumed session or reread after truncation once', async () => {
    const f = await fixture()
    const call = skillCall('toolu_a', 'ship', '2026-10-01T10:00:00Z') + skillResult('toolu_a', '2026-10-01T10:00:01Z', { commandName: 'ship' })
    await writeFile(f.claudeFile, call)
    await writeFile(join(f.sources.claudeProjects, '-repo', '99999999-2222-3333-4444-555555555555.jsonl'), call)
    const store = await SkillUsageStore.load(f.store)
    await store.refresh(f.sources)
    expect(store.size).toBe(1)

    await writeFile(f.claudeFile, call.slice(0, 10))
    await store.refresh(f.sources)
    await writeFile(f.claudeFile, call)
    await store.refresh(f.sources)
    expect(store.size).toBe(1)
  })

  it('counts Codex commands that read a skill document, not output that mentions one', async () => {
    const f = await fixture()
    await writeFile(f.codexFile, [
      codexRead('exec-1', "sed -n '1,200p' /home/u/.codex/skills/verify/SKILL.md", '2026-10-04T10:00:00Z'),
      codexRead('exec-2', 'cat docs/agent-work.md', '2026-10-04T10:01:00Z', 'see /home/u/.codex/skills/ship/SKILL.md'),
      codexRead('exec-3', 'cat /home/u/.codex/skills/gone/SKILL.md', '2026-10-04T10:02:00Z', 'cat: /home/u/.codex/skills/gone/SKILL.md: No such file or directory'),
      codexRead('exec-4', 'wc -l /home/u/.agents/skills/tdd/SKILL.md', '2026-10-04T10:03:00Z'),
      codexRead('exec-5', 'cat a/x/SKILL.md a/y/SKILL.md a/z/SKILL.md', '2026-10-04T10:04:00Z'),
    ].join(''))
    const store = await SkillUsageStore.load(f.store)
    await store.refresh(f.sources)

    expect(store.list().map((e) => [e.skill, e.root, e.session])).toEqual([
      ['verify', '/home/u/.codex/skills', CODEX_SESSION],
      ['x', 'a', CODEX_SESSION],
      ['y', 'a', CODEX_SESSION],
      ['z', 'a', CODEX_SESSION],
    ])
    const report = buildSkillUsageReport(store.list(), [], f.store)
    expect(report.rows.map((r) => r.skill)).toEqual(['verify'])
    expect(report).toMatchObject({ sweepCommands: 1, sweepReadsExcluded: 3 })
  })
})

describe('buildSkillUsageReport', () => {
  it('joins the installed catalog, filters the window, and lists installed skills with no use', async () => {
    const f = await fixture()
    const claudeHome = join(f.root, 'home', '.claude')
    for (const skill of ['reflect', 'ship', 'teach']) {
      await mkdir(join(claudeHome, 'skills', skill), { recursive: true })
      await writeFile(join(claudeHome, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`)
    }
    const pluginPath = join(f.root, 'plugins', 'matt', '1.0.0')
    await mkdir(join(pluginPath, 'skills', 'tdd'), { recursive: true })
    await writeFile(join(pluginPath, 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\n---\n')
    await mkdir(join(claudeHome, 'plugins'), { recursive: true })
    await writeFile(join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'matt@market': true } }))
    await writeFile(join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'matt@market': [{ installPath: pluginPath }] } }))

    const installed = await readInstalledSkills({ claudeHome, codexSkillDirs: [] })
    expect(installed.map((s) => s.name)).toEqual(['reflect', 'ship', 'teach', 'matt:tdd'])

    const events = [
      { harness: 'claude-code' as const, kind: 'model' as const, skill: 'reflect', root: null, ts: '2026-10-05T00:00:00Z', session: 's1', id: 't1' },
      { harness: 'claude-code' as const, kind: 'slash' as const, skill: 'reflect', root: null, ts: '2026-10-06T00:00:00Z', session: 's2', id: 't2' },
      { harness: 'claude-code' as const, kind: 'model' as const, skill: 'ship', root: null, ts: '2026-08-01T00:00:00Z', session: 's3', id: 't3' },
    ]
    const report = buildSkillUsageReport(events, installed, f.store, { since: Date.parse('2026-09-01T00:00:00Z') })

    expect(report.rows).toEqual([
      { skill: 'reflect', model: 1, slash: 1, read: 0, sessions: 2, firstUsed: '2026-10-05T00:00:00Z', lastUsed: '2026-10-06T00:00:00Z', installedIn: ['claude-code'] },
    ])
    expect(report.unused.map((u) => u.skill)).toEqual(['matt:tdd', 'ship', 'teach'])
  })
})
