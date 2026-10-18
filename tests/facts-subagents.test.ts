/**
 * A Claude Code session's subagents through the built CLI: the kind of agent
 * each `Task` call asked for, and the tool calls the subagents' own
 * transcripts hold, counted apart from the session's. The session is the
 * audit benchmark's Claude session (`bench/audit/fixtures.ts`): three `Task`
 * subagents, each with a sidechain transcript under `subagents/`, and `Bash`
 * results with `is_error` in the main transcript and inside a subagent. Every
 * expected value is read from the generated JSONL here, never through an
 * adapter or the generator's bookkeeping.
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { writeFixtures } from '../bench/audit/fixtures.js'
import { runCli } from './run-cli.js'

interface Block { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean }
interface ToolCount { name: string; calls: number; failed: number }
interface Facts {
  toolCalls: { value: number; spanIds: string[] }
  subagentTools: { value: ToolCount[] | null; spanIds: string[] }
  subagents: { value: Array<{ taskName: string | null; agentType: string | null; status: string }> }
}

/** The content blocks of one transcript, read straight from its bytes. */
async function blocks(path: string): Promise<Block[]> {
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { message?: { content?: unknown } })
  return rows.flatMap((row) => (Array.isArray(row.message?.content) ? (row.message.content as Block[]) : []))
}

/** Tool calls by name in `paths`, and those whose result says `is_error`, most calls first. */
async function toolCounts(paths: readonly string[]): Promise<ToolCount[]> {
  const all = (await Promise.all(paths.map(blocks))).flat()
  const failed = new Set(all.filter((block) => block.type === 'tool_result' && block.is_error === true).map((block) => block.tool_use_id))
  const rows = new Map<string, ToolCount>()
  for (const call of all.filter((block) => block.type === 'tool_use')) {
    const row = rows.get(call.name!) ?? { name: call.name!, calls: 0, failed: 0 }
    row.calls += 1
    if (failed.has(call.id)) row.failed += 1
    rows.set(call.name!, row)
  }
  return [...rows.values()].sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name))
}

let session: string
let env: Record<string, string>
let theirs: ToolCount[]
let tasks: Array<{ description: string; type: string }>

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'traces-facts-subagents-'))
  const bench = await writeFixtures(join(root, 'tree'))
  session = join(root, 'tree', bench.manifest.sessions.find((entry) => entry.id === 'claude')!.path)
  env = { HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state') }
  const subagents = join(session.replace(/\.jsonl$/u, ''), 'subagents')
  theirs = await toolCounts((await readdir(subagents)).filter((file) => file.endsWith('.jsonl')).map((file) => join(subagents, file)))
  tasks = (await blocks(session))
    .filter((block) => block.type === 'tool_use' && block.name === 'Task')
    .map((block) => ({ description: String(block.input!.description), type: String(block.input!.subagent_type) }))
})

async function facts(argv: readonly string[]): Promise<Facts> {
  const run = await runCli(['facts', session, ...argv, '--format', 'json'], { env })
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return (JSON.parse(run.stdout) as { sessions: Facts[] }).sessions[0]!
}

describe("facts on a Claude Code session's subagents", () => {
  it("counts the subagents' tool calls by name with their failures, apart from the session's own", async () => {
    const sheet = await facts([])
    expect(theirs.find((row) => row.name === 'Bash')?.failed).toBeGreaterThan(0)
    expect(sheet.subagentTools.value).toEqual(theirs)
    expect(sheet.subagentTools.spanIds).toHaveLength(theirs.reduce((sum, row) => sum + row.calls, 0))
    for (const id of sheet.subagentTools.spanIds) expect(sheet.toolCalls.spanIds).not.toContain(id)
  })

  it('names the subagent type each Task call asked for', async () => {
    const sheet = await facts([])
    expect(new Set(tasks.map((task) => task.type)).size).toBeGreaterThan(1)
    expect(sheet.subagents.value.map((spawn) => [spawn.taskName, spawn.agentType])).toEqual(tasks.map((task) => [task.description, task.type]))
  })

  it('prints both on the text sheet', async () => {
    const run = await runCli(['facts', session], { env })
    expect(run.code).toBe(0)
    const lines = run.stdout.split('\n')
    const named = tasks.map((task) => `${task.description} [${task.type}]`).join(', ')
    expect(lines.find((line) => line.startsWith('tools '))).toContain(` · subagents ${tasks.length} (${named})`)
    const calls = theirs.reduce((sum, row) => sum + row.calls, 0)
    const listed = theirs.map((row) => `${row.name} ${row.calls}${row.failed > 0 ? ` (${row.failed} failed)` : ''}`).join(', ')
    expect(lines).toContain(`subagent tools ${calls} (${listed}), not in the tools count`)
  })

  it('withholds the subagent types under --no-content, and keeps the counts', async () => {
    const sheet = await facts(['--no-content'])
    expect(sheet.subagents.value.map((spawn) => spawn.agentType)).toEqual(tasks.map(() => null))
    expect(sheet.subagentTools.value).toEqual(theirs)
  })
})
