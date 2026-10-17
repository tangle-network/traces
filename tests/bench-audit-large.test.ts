/**
 * The large-session arm of the audit benchmark (`bench/audit/large.ts`): one
 * synthetic Codex session where reading the raw file costs an agent the most.
 * At a small size here, the $0 facts arm answers all four of its questions
 * through the bench runner, and the generator writes the same bytes each time.
 */
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { generateLarge } from '../bench/audit/large.js'

const execFileAsync = promisify(execFile)
const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs')
const bench = (...args: string[]) =>
  execFileAsync(process.execPath, ['--import', tsx, join(process.cwd(), 'bench', 'audit', 'cli.ts'), ...args], { maxBuffer: 32 * 1024 * 1024 })

describe('the large-session arm', () => {
  it('is answered in full by the facts arm, for $0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-bench-large-'))
    const { stdout } = await bench('large', '--arm', 'facts', '--tool-calls', '1200', '--work', join(dir, 'work'), '--out', join(dir, 'answers.json'))
    expect(stdout).toContain('| **total** | **4 / 0 / 0** | **$0.0000** |')
  }, 120_000)

  it('plants every fact, the same way each time', () => {
    const small = generateLarge(1200)
    expect(generateLarge(1200).files[0]!.content).toBe(small.files[0]!.content)
    expect(small.gold['large.pull-requests']).toEqual({ created: [212, 219, 231], merged: [212, 219] })
    const commands = small.files[0]!.content.split('\n').filter((line) => line.includes('"name":"exec_command"')).length
    expect(small.gold['large.commands']!.exec_commands).toBe(commands)
    expect(small.gold['large.commands']!.nonzero_exits).toBeGreaterThan(0)
    expect(small.gold['large.test-runs']!.pnpm_test_runs).toBeGreaterThan(0)
  })
})
