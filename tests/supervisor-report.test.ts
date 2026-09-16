import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileRunContext } from '../src/supervisor-run-context.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const at = (sec: number) => new Date(Date.parse('2026-09-15T00:00:00.000Z') + sec * 1000).toISOString()

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'traces-supervisor-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function run(args: string[]) {
  return execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  })
}

async function writeRun(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const events = [
    { kind: 'spawned', id: 'sup-1', label: 'root', at: at(0) },
    { kind: 'spawned', id: 'sup-1:w0', parent: 'sup-1', label: 'w-0', at: at(10) },
    {
      kind: 'settled', id: 'sup-1:w0', status: 'done', at: at(100),
      spent: { iterations: 1, tokens: { input: 5, output: 1 }, usd: 0.01, ms: 90_000 },
    },
  ]
  await writeFile(join(dir, 'spawn-journal.jsonl'), [
    JSON.stringify({ kind: 'begin', root: 'sup-1', at: at(0) }),
    ...events.map((event, seq) => JSON.stringify({ kind: 'event', root: 'sup-1', event: { ...event, seq } })),
    '',
  ].join('\n'))
  await writeFile(join(dir, 'result.json'), JSON.stringify({
    kind: 'winner', tree: { root: 'sup-1' }, spentTotal: { usd: 0.01 },
  }))
  await writeFile(join(dir, 'coordination-log.jsonl'), [
    { type: 'steer', down: { messageId: 'steer-1', toWorker: 'sup-1:w0', instruction: 'narrow the fix' } },
    { type: 'delivery', receipt: { messageId: 'steer-1', delivered: true } },
  ].map((event) => JSON.stringify({ at: at(20), event })).join('\n') + '\n')
}

describe('supervisor reports', () => {
  it('reports Runtime runs, retains coordination evidence in nested rollups, and writes the report', async () => {
    const root = await scratch()
    const dir = join(root, 'runs', 'inst-1', 'ARM')
    await writeRun(dir)

    const single = await run(['analyze', '--supervisor-run-dir', dir])
    expect(single.stdout).toContain('# Run report — sup-1 [ARM]')
    expect(single.stdout).toContain('steers=1 queued / 1 delivered')
    expect(single.stdout).toContain('| Workers spawned | 1 |')
    expect(single.stdout).toContain('unavailable —')

    const rollup = await run(['analyze', '--supervisor-run-dir', root])
    expect(rollup.stdout).toContain(`Supervisor rollup — ${root}`)
    expect(rollup.stdout).toContain('Steers across all cells: 1')
    expect(rollup.stdout).toContain('| sup-1 | ARM |')

    const out = join(root, 'supervisor.md')
    const written = await run(['analyze', '--supervisor-run-dir', dir, '--out', out])
    expect(written.stdout).toContain(`supervisor report → ${out}`)
    const withoutGeneratedTime = (text: string) => text.replace(/^- Generated: .+$/m, '').trimEnd()
    expect(withoutGeneratedTime(await readFile(out, 'utf8'))).toBe(withoutGeneratedTime(single.stdout))
  }, 120_000)

  it('reports a Runtime failure before the first spawn instead of rejecting the directory', async () => {
    const dir = await scratch()
    await writeFile(join(dir, 'failure.json'), JSON.stringify({
      runId: 'failed-run', pursuitId: 'attempt-1', at: at(0),
      error: { name: 'ProviderError', message: 'provider setup failed' },
    }))
    const result = await run(['analyze', '--supervisor-run-dir', dir])
    expect(result.stdout).toContain('provider setup failed')
    expect(result.stdout).toContain('failed-run')
    expect(result.stdout).toContain('| Status source | runtime-failure |')
  })

  it.each(['empty', 'loops'])('rejects a %s directory with the supported input path', async (layout) => {
    const empty = await scratch()
    if (layout === 'loops') {
      const old = join(empty, 'ws', '.loops', 'supervisor', 'sup-1')
      await mkdir(old, { recursive: true })
      await writeFile(join(old, 'journal.jsonl'), JSON.stringify({ kind: 'spawned', id: 'sup-1', at: at(0) }))
    }
    await expect(run(['analyze', '--supervisor-run-dir', empty])).rejects.toThrow(/no supervisor run found.*Runtime run/)
  })

  it('rejects a terminal record from another Runtime run', async () => {
    const dir = await scratch()
    await writeRun(dir)
    await writeFile(join(dir, 'result.json'), JSON.stringify({ kind: 'winner', tree: { root: 'another-run' } }))
    await expect(readFileRunContext(dir)).rejects.toThrow(/does not match journal root/)
  })
})
