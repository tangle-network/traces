/**
 * The $0 facts arm of the audit benchmark (spec U11): `traces facts --format
 * json` over the three fixture sessions, mapped to the 19 answers by
 * `bench/audit/arms.ts`, scored by `bench/audit/score.ts` through the bench
 * runner. The score may only rise: every question `facts-score.json` lists as
 * correct stays correct, on every wording.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { QUESTIONS } from '../bench/audit/questions.js'

const execFileAsync = promisify(execFile)
const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs')
const bench = (...args: string[]) =>
  execFileAsync(process.execPath, ['--import', tsx, join(process.cwd(), 'bench', 'audit', 'cli.ts'), ...args], { maxBuffer: 32 * 1024 * 1024 })

interface Committed {
  canonical: { correct: number }
  heldOut: { correct: number }
  correct: string[]
}
interface Score {
  arm: string
  canonical: { correct: number; attempts: number }
  heldOut: { correct: number; attempts: number }
  attempts: Array<{ question: string; variant: number; verdict: string }>
  notAttempted: unknown[]
}

let score: Score
let committed: Committed
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'traces-bench-facts-'))
  await bench('arm', '--arm', 'facts', '--variants', 'all', '--work', join(dir, 'work'), '--out', join(dir, 'answers.json'))
  await bench('score', join(dir, 'answers.json'), '--fixtures', join(dir, 'work', 'fixtures'), '--json', join(dir, 'score.json'), '--out', join(dir, 'report.md'))
  score = JSON.parse(await readFile(join(dir, 'score.json'), 'utf8')) as Score
  committed = JSON.parse(await readFile(join(process.cwd(), 'bench', 'audit', 'facts-score.json'), 'utf8')) as Committed
}, 120_000)

describe('the facts arm', () => {
  it('answers every wording of every question for $0', () => {
    expect(score.arm).toBe('facts')
    expect(score.notAttempted).toEqual([])
    expect(score.canonical.attempts).toBe(QUESTIONS.length)
  })

  it('scores at least the committed facts-score.json, question by question', () => {
    const correct = new Set(score.attempts.filter((attempt) => attempt.verdict === 'correct').map((attempt) => `${attempt.question}#${attempt.variant}`))
    for (const question of committed.correct) {
      const variants = QUESTIONS.find((item) => item.id === question)!.paraphrases.length
      for (let variant = 0; variant <= variants; variant += 1) expect(correct, `${question}#${variant}`).toContain(`${question}#${variant}`)
    }
    expect(score.canonical.correct).toBeGreaterThanOrEqual(committed.canonical.correct)
    expect(score.heldOut.correct).toBeGreaterThanOrEqual(committed.heldOut.correct)
  })
})
