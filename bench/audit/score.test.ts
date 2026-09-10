/**
 * Scorer tests. Nothing here calls a model: the grader is exact match, so its
 * behavior is fully testable, and these tests are what keep it honest.
 *
 * The first test doubles as the gold's own consistency check. Submitting the
 * gold as an arm's answers must score every question correct through the same
 * path a real arm takes, including citation resolution through the traces
 * adapters. If it does not, the answer key contradicts the fixture bytes.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CitationIndex, loadCitationIndex, spanRecordMap } from './citations.js'
import { generateBench, writeFixtures } from './fixtures.js'
import { QUESTIONS, questionById } from './questions.js'
import { type AnswerRow, parseAnswersFile, renderArmScore, scoreAnswer, scoreArm } from './score.js'

const execFileAsync = promisify(execFile)
const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs')
const cli = join(process.cwd(), 'bench', 'audit', 'cli.ts')

const bench = generateBench()
let root = ''
let index: CitationIndex

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'traces-bench-score-'))
  await writeFixtures(root, bench)
  index = await loadCitationIndex(root, bench.manifest)
})

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

/** The gold answer for one question, deep-copied so a test can spoil one field. */
const goldAnswer = (id: string): Record<string, unknown> => structuredClone(bench.gold[id]!)
const score = (id: string, answer: unknown): ReturnType<typeof scoreAnswer> =>
  scoreAnswer(questionById(id)!, { question: id, answer }, bench.gold, index)

describe('the gold scores itself correct', () => {
  it.each(QUESTIONS.map((question) => question.id))('%s', (id) => {
    const scored = score(id, goldAnswer(id))
    expect(scored.verdict).toBe('correct')
    expect(scored.leaves.every((leaf) => leaf.correct)).toBe(true)
    for (const citation of scored.leaves.flatMap((leaf) => leaf.citations)) {
      expect(citation).toEqual({ cite: citation.cite, resolved: true, verified: true, onGold: true })
    }
  })
})

describe('exact-match leaves', () => {
  it('marks a wrong count wrong and a mixed answer partial', () => {
    expect(score('op.status-polls', { status_commands: 522 }).verdict).toBe('wrong')
    const mixed = goldAnswer('op.subagents')
    mixed.failed_spawns = 0
    expect(score('op.subagents', mixed).verdict).toBe('partial')
  })

  it('rejects a count that is not an integer', () => {
    expect(score('op.status-polls', { status_commands: '523' }).verdict).toBe('wrong')
    expect(score('op.status-polls', { status_commands: 523.5 }).verdict).toBe('wrong')
  })

  it('accepts a time within one second and rejects one beyond it', () => {
    const gold = bench.gold['op.time-bounds'] as { first_record_at: string; last_record_at: string }
    const shift = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString()
    expect(score('op.time-bounds', {
      first_record_at: shift(gold.first_record_at, 900),
      last_record_at: shift(gold.last_record_at, -1_000),
    }).verdict).toBe('correct')
    expect(score('op.time-bounds', {
      first_record_at: shift(gold.first_record_at, 1_001),
      last_record_at: gold.last_record_at,
    }).verdict).toBe('partial')
  })

  it('compares sets without order and without tolerating a gap', () => {
    const answer = goldAnswer('op.runs')
    answer.specs = [...(answer.specs as string[])].reverse()
    expect(score('op.runs', answer).verdict).toBe('correct')
    answer.specs = (answer.specs as string[]).slice(1)
    expect(score('op.runs', answer).verdict).toBe('partial')
  })

  it('records a null where the gold has a value as a false "not in trace"', () => {
    const scored = score('op.local-copy', { path: null })
    expect(scored.verdict).toBe('wrong')
    expect(scored.leaves[0]!.falseNotInTrace).toBe(true)
    expect(score('op.local-copy', { path: 'tools/mini-graph.mjs' }).leaves[0]!.falseNotInTrace).toBe(false)
  })

  it('accepts null for a leaf the trace has no value for', () => {
    // No gold leaf is absent today, so this scores against a gold whose optional merge time
    // is missing: an arm that reports null there is right, and one that invents a time is not.
    const gold = structuredClone(bench.gold)
    const prs = gold['op.pull-requests']!.prs as Array<Record<string, unknown>>
    const merged = prs[0]!.merged_at
    delete prs[0]!.merged_at
    const answer = goldAnswer('op.pull-requests')
    const rows = answer.prs as Array<Record<string, unknown>>
    rows[0]!.merged_at = null
    const scoreAgainst = (value: unknown) => {
      rows[0]!.merged_at = value
      return scoreAnswer(questionById('op.pull-requests')!, { question: 'op.pull-requests', answer }, gold, index)
    }
    const absent = scoreAgainst(null).leaves.find((leaf) => leaf.path === 'prs[41].merged_at')!
    expect(absent).toMatchObject({ correct: true, falseNotInTrace: false })
    expect(scoreAgainst(null).verdict).toBe('correct')
    expect(scoreAgainst(merged).leaves.find((leaf) => leaf.path === 'prs[41].merged_at')!.correct).toBe(false)
  })

  it('scores an empty list as the right answer only where the gold is empty', () => {
    expect(score('child.spawned', { spawned_session_ids: [] }).verdict).toBe('correct')
    expect(score('child.spawned', { spawned_session_ids: ['made-up'] }).verdict).toBe('wrong')
  })

  it('matches records by key and fails the ones it cannot find', () => {
    const answer = goldAnswer('op.pull-requests')
    const prs = answer.prs as Array<Record<string, unknown>>
    answer.prs = prs.slice(0, 2)
    const scored = score('op.pull-requests', answer)
    expect(scored.verdict).toBe('partial')
    expect(scored.leaves.filter((leaf) => leaf.path.startsWith('prs[43]')).every((leaf) => !leaf.correct)).toBe(true)
    expect(scored.leaves.find((leaf) => leaf.path === 'prs[*].number')!.correct).toBe(false)
  })

  it('fails a merge time taken from the wrong tool call', () => {
    const answer = goldAnswer('op.pull-requests')
    const prs = answer.prs as Array<Record<string, unknown>>
    prs[1]!.merged_at = prs[2]!.merged_at
    const scored = score('op.pull-requests', answer)
    expect(scored.verdict).toBe('partial')
    expect(scored.leaves.find((leaf) => leaf.path === 'prs[42].merged_at')!.correct).toBe(false)
  })
})

describe('quotes and citations', () => {
  const goldQuote = bench.gold['op.large-output']!.last_line as { text: string; cite: string }

  it('needs the text verbatim and the citation on the gold record', () => {
    expect(score('op.large-output', { last_line: goldQuote }).verdict).toBe('correct')
    expect(score('op.large-output', { last_line: { text: 'g-01 failed', cite: goldQuote.cite } }).verdict).toBe('wrong')
  })

  it('rejects a real citation that names another record, and says so', () => {
    const other = bench.gold['op.corrections']!.corrections as Array<{ cite: string }>
    const scored = score('op.large-output', { last_line: { text: goldQuote.text, cite: other[0]!.cite } })
    expect(scored.verdict).toBe('wrong')
    expect(scored.leaves[0]!.citations[0]).toMatchObject({ resolved: true, verified: false, onGold: false })
  })

  it('resolves a span id only when the span names a record', async () => {
    const spans = await spanRecordMap(root, bench.manifest)
    // An empty mapping would resolve, so a cite of a record-less span would be reported the
    // same way as a cite of the wrong record.
    expect([...spans].filter(([, refs]) => refs.length === 0)).toEqual([])
  })

  it('reports a citation that names no known record', () => {
    const scored = score('op.large-output', { last_line: { text: goldQuote.text, cite: 'nowhere.jsonl:12' } })
    expect(scored.leaves[0]!.citations[0]).toMatchObject({ resolved: false, verified: false, onGold: false })
  })

  it('accepts a span id whose span came from the gold record', async () => {
    const spans = await spanRecordMap(root, bench.manifest)
    const [file, line] = [goldQuote.cite.slice(0, goldQuote.cite.lastIndexOf(':')), Number(goldQuote.cite.split(':').at(-1))]
    const spanId = [...spans].find(([, refs]) => refs.some((ref) => ref.file === file && ref.line === line))?.[0]
    expect(spanId).toBeDefined()
    const scored = score('op.large-output', { last_line: { text: goldQuote.text, cite: spanId! } })
    expect(scored.verdict).toBe('correct')
    expect(scored.leaves[0]!.citations[0]).toMatchObject({ resolved: true, onGold: true })
  })

  it('needs every correction quoted once, and no invented one', () => {
    const gold = goldAnswer('op.corrections')
    const corrections = gold.corrections as Array<{ text: string; cite: string }>
    expect(score('op.corrections', { corrections: [...corrections].reverse() }).verdict).toBe('correct')
    expect(score('op.corrections', { corrections: corrections.slice(1) }).verdict).toBe('wrong')
    expect(score('op.corrections', {
      corrections: [...corrections, { text: corrections[0]!.text, cite: corrections[0]!.cite }],
    }).verdict).toBe('wrong')
  })
})

describe('answers files', () => {
  it('rejects every problem at once', () => {
    expect(() => parseAnswersFile({ arm: '', answers: [{ question: 'op.nope', answer: null }, { question: 'op.runs', variant: 9 }] }))
      .toThrow(/arm must be a non-empty string[\s\S]*not a known question id[\s\S]*variant must be 0 to[\s\S]*answer is missing/)
  })

  it('accepts a well-formed file', () => {
    const file = parseAnswersFile({ arm: 'baseline', answers: [{ question: 'op.runs', answer: null, cost_usd: 0.01, cost_basis: 'estimated' }] })
    expect(file.arm).toBe('baseline')
  })
})

describe('arm scores', () => {
  const answers = (rows: readonly AnswerRow[]) => scoreArm({ arm: 'test-arm', answers: [...rows] }, bench.gold, index)

  it('separates canonical wordings from held-out paraphrases and lists what was skipped', () => {
    const scored = answers([
      { question: 'op.status-polls', variant: 0, answer: goldAnswer('op.status-polls'), wall_ms: 100, cost_usd: 0.5, cost_basis: 'observed' },
      { question: 'op.status-polls', variant: 1, answer: { status_commands: 1 }, wall_ms: 300 },
    ])
    expect(scored.canonical).toMatchObject({ attempts: 1, correct: 1, wrong: 0 })
    expect(scored.heldOut).toMatchObject({ attempts: 1, correct: 0, wrong: 1 })
    expect(scored.canonical.cost).toMatchObject({ total: 0.5, basis: 'observed', missing: 0 })
    expect(scored.heldOut.cost).toMatchObject({ total: null, basis: 'unknown', missing: 1 })
    expect(scored.notAttempted.length).toBeGreaterThan(0)
    expect(scored.notAttempted).not.toContainEqual({ question: 'op.status-polls', variant: 0 })
  })

  it('never turns an unreported cost into a zero, and reads the basis off the reported ones', () => {
    const scored = answers([
      { question: 'op.status-polls', answer: null, cost_usd: 2, cost_basis: 'estimated' },
      { question: 'op.runs', answer: null },
    ])
    expect(scored.canonical.cost).toMatchObject({ reported: 1, missing: 1, total: 2, basis: 'estimated' })
    expect(scored.canonical.falseNotInTrace).toBeGreaterThan(0)
    const twoBases = answers([
      { question: 'op.status-polls', answer: null, cost_usd: 2, cost_basis: 'estimated' },
      { question: 'op.runs', answer: null, cost_usd: 1, cost_basis: 'observed' },
    ])
    expect(twoBases.canonical.cost).toMatchObject({ reported: 2, missing: 0, total: 3, basis: 'mixed' })
    const noBasis = answers([{ question: 'op.runs', answer: null, cost_usd: 1 }])
    expect(noBasis.canonical.cost).toMatchObject({ reported: 1, total: 1, basis: 'unknown' })
  })

  it('renders one table row per attempted wording, over the full wording count', () => {
    const report = renderArmScore(answers([{ question: 'op.runs', answer: goldAnswer('op.runs') }]))
    expect(report).toContain('# Audit benchmark score: test-arm')
    expect(report).toContain('| op.runs |')
    expect(report).toContain('Not attempted')
    // Answering one easy question must not report 1/0/0 of 1: the denominator is every
    // canonical wording, so skipping the rest is visible in the row a reader compares.
    expect(report).toContain(`| all canonical | 1/0/0 of ${QUESTIONS.length} (${QUESTIONS.length - 1} not attempted) |`)
  })
})

describe('the runner', () => {
  const run = (args: readonly string[], cwd: string) =>
    execFileAsync(process.execPath, ['--import', tsx, cli, ...args], { cwd, maxBuffer: 32 * 1024 * 1024 })

  it('writes arm inputs without the gold, then scores an answers file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-bench-run-'))
    try {
      await run(['fixtures', '--out', join(dir, 'fixtures')], process.cwd())
      await run(['gold', '--out', join(dir, 'gold.json')], process.cwd())
      const manifest = JSON.parse(await readFile(join(dir, 'fixtures', 'manifest.json'), 'utf8')) as typeof bench.manifest
      expect(manifest.files).toEqual(bench.manifest.files)
      const prompts = (await readFile(join(dir, 'fixtures', 'prompts.jsonl'), 'utf8')).trim().split('\n')
      expect(prompts.length).toBeGreaterThan(QUESTIONS.length)
      await expect(readFile(join(dir, 'fixtures', 'gold.json'), 'utf8')).rejects.toThrow()

      const answersPath = join(dir, 'answers.json')
      await writeFile(answersPath, JSON.stringify({
        arm: 'gold-replay',
        answers: QUESTIONS.map((question) => ({ question: question.id, variant: 0, answer: bench.gold[question.id] })),
      }))
      await run(['score', answersPath, '--fixtures', join(dir, 'fixtures'), '--out', join(dir, 'report.md'), '--json', join(dir, 'score.json')], process.cwd())
      const parsed = JSON.parse(await readFile(join(dir, 'score.json'), 'utf8')) as { canonical: { correct: number; attempts: number } }
      expect(parsed.canonical.correct).toBe(QUESTIONS.length)
      expect(parsed.canonical.attempts).toBe(QUESTIONS.length)
      expect(await readFile(join(dir, 'report.md'), 'utf8')).toContain('gold-replay')

      // The prompts an arm was given are checked too, not only the session bytes.
      await writeFile(join(dir, 'fixtures', 'prompts.jsonl'), 'reworded\n')
      await expect(run(['score', answersPath, '--fixtures', join(dir, 'fixtures')], process.cwd()))
        .rejects.toThrow(/prompts\.jsonl/)

      await writeFile(join(dir, 'fixtures', bench.manifest.files[0]!), 'tampered\n')
      await expect(run(['score', answersPath, '--fixtures', join(dir, 'fixtures')], process.cwd()))
        .rejects.toThrow(/differs from the generated bytes/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes its usage to stderr when it is given no command', async () => {
    await expect(run([], process.cwd())).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('Usage:') })
  })
})
