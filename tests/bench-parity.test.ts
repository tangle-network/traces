/**
 * The fork-parity scorecard (`bench/parity/score.ts`, spec U11) through its
 * command line, on a synthetic fork whose old and new sides are child
 * processes printing fixed rows: one field agrees and one does not.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs')
const printRows = (rows: readonly object[]) => [process.execPath, '-e', `for (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row))`]

describe('the fork-parity scorecard', () => {
  it('reports one agreeing and one disagreeing field, the key only one side found, and writes only under --out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-bench-parity-'))
    const home = join(dir, 'home')
    await mkdir(home)
    const forks = join(dir, 'forks.json')
    await writeFile(forks, JSON.stringify({
      window: { since: '2026-10-08T00:00:00.000Z', until: '2026-10-15T00:00:00.000Z' },
      forks: [{
        id: 'synthetic',
        parser: 'a synthetic old parser',
        retiredBy: 'test',
        deletedIn: 'never',
        unit: 'window',
        old: printRows([{ key: 's1@10:00', author: 'human', turns: 2 }, { key: 's2@11:00', author: 'human', turns: 1 }]),
        new: printRows([{ key: 's1@10:00', author: 'human', turns: 3 }]),
        read: { old: 'rows', new: 'rows' },
        key: 'session and time',
        fields: { author: 'author -> author', turns: 'turns -> turns' },
        tolerance: 0.9,
      }],
    }))
    const out = join(dir, 'out')
    const { stdout } = await execFileAsync(process.execPath, ['--import', tsx, join(process.cwd(), 'bench', 'parity', 'score.ts'), '--home', home, '--out', out, '--forks-file', forks])
    const card = JSON.parse(await readFile(join(out, 'scorecard.json'), 'utf8')) as {
      scores: Array<{ id: string; keys: Record<string, number>; fields: Record<string, number>; agreement: number; pass: boolean; disagreements: string[] }>
    }
    expect(card.scores).toHaveLength(1)
    const [score] = card.scores
    expect(score!.keys).toEqual({ old: 2, new: 1, both: 1, agreement: 0.5 })
    expect(score!.fields).toEqual({ author: 1, turns: 0 })
    expect(score!.agreement).toBe(0)
    expect(score!.pass).toBe(false)
    expect(score!.disagreements).toEqual(['s2@11:00: only the old parser', 's1@10:00: turns 2 vs 3'])
    expect(stdout).toContain('| synthetic | 2 / 1 / 1 | 50.0% | author 100.0%, turns 0.0% | 0.0% | 90.0% | no | never |')
    expect(await readdir(home)).toEqual([])
  })
})
