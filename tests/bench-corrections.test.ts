/**
 * `pnpm bench:corrections`: the turn signals of `traces facts` scored against
 * labels, beside the 0.23.1 lexical classifier, on one synthetic Claude Code
 * session with a planted interrupt, rejected tool and completion claim. The
 * facts rows come from the built CLI; the scorer is spawned the way the
 * package script runs it.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { TEXT } from './fixtures/conversation.js'
import { runCli } from './run-cli.js'

const SESSION = 'b3c0c0a1-1111-4111-8111-111111111111'
const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs')
const score = join(process.cwd(), 'bench', 'corrections', 'score.ts')
const at = (second: number): string => new Date(Date.parse('2026-10-14T10:00:00.000Z') + second * 1000).toISOString()

/**
 * The session, in order. `label` is the judge's verdict on each typed turn.
 *
 *   t+00  human  "Fix the build; be concise."                   no   (lexical-any: "be concise")
 *   t+05  agent  "Done: the build passes."                           (a completion claim)
 *   t+10  human  "no, that's wrong: the build still fails."     yes  after-claim; lexical
 *   t+15  agent  Bash `rm -rf build`, which the person rejects, then interrupts
 *   t+25  human  "Leave the build directory alone."             yes  interrupt, rejected-tool
 *   t+30  agent  "Working on it; the fix will be ready after the cache rebuild."  (not a claim: it opens with progress)
 *   t+35  human  "Why did you clear the cache?"                 yes  no signal; lexical
 *   t+40  agent  "Fixed. The cache is back."                         (a completion claim)
 *   t+45  human  "Great, ship it."                              no   after-claim
 *   t+50  agent  "Shipping now."
 *   t+55  human  "don't forget the changelog"                   no   lexical
 */
function session(cwd: string): string {
  let previous: string | null = null
  let n = 0
  const record = (second: number, type: 'user' | 'assistant', message: unknown) => {
    n += 1
    const uuid = `${SESSION.slice(0, 8)}-r${n}`
    const row = { sessionId: SESSION, cwd, version: '2.1.0', gitBranch: 'main', userType: 'external', type, uuid, parentUuid: previous, timestamp: at(second), message }
    previous = uuid
    return row
  }
  const user = (second: number, content: unknown) => record(second, 'user', { role: 'user', content })
  const assistant = (second: number, content: unknown) =>
    record(second, 'assistant', { id: `msg-${second}`, role: 'assistant', model: 'claude-opus-5-5', content, usage: { input_tokens: 10, output_tokens: 4 } })
  const say = (second: number, text: string) => assistant(second, [{ type: 'text', text }])
  return [
    user(0, 'Fix the build; be concise.'),
    say(5, 'Done: the build passes.'),
    user(10, "no, that's wrong: the build still fails."),
    assistant(15, [{ type: 'tool_use', id: 'toolu-1', name: 'Bash', input: { command: 'rm -rf build' } }]),
    user(18, [{ type: 'tool_result', tool_use_id: 'toolu-1', content: TEXT.refusal, is_error: true }]),
    user(19, '[Request interrupted by user for tool use]'),
    user(25, 'Leave the build directory alone.'),
    say(30, 'Working on it; the fix will be ready after the cache rebuild.'),
    user(35, 'Why did you clear the cache?'),
    say(40, 'Fixed. The cache is back.'),
    user(45, 'Great, ship it.'),
    say(50, 'Shipping now.'),
    user(55, "don't forget the changelog"),
  ].map((row) => JSON.stringify(row)).join('\n') + '\n'
}

const LABELS: ReadonlyArray<readonly [number, boolean]> = [[0, false], [10, true], [25, true], [35, true], [45, false], [55, false], [99, true]]

function labels(overrides: Readonly<Record<number, boolean>> = {}): string {
  return LABELS.map(([second, label]) => JSON.stringify({ session: SESSION, at: at(second), label: overrides[second] ?? label })).join('\n') + '\n'
}

interface Run {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

function bench(args: readonly string[], input?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--import', tsx, score, ...args], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error)
      resolve({ stdout, stderr, code: typeof error?.code === 'number' ? error.code : 0 })
    })
    child.stdin?.end(input ?? '')
  })
}

interface Arm {
  arm: string
  fires: number
  truePositives: number
  recall: number | null
  precision: number | null
}

let dir = ''
let factsRows = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'traces-bench-corrections-'))
  const home = join(dir, 'home')
  const cwd = join(home, 'w', 'app')
  const file = join(home, '.claude', 'projects', '-w-app', `${SESSION}.jsonl`)
  await mkdir(join(home, '.claude', 'projects', '-w-app'), { recursive: true })
  await writeFile(file, session(cwd))
  const run = await runCli(['facts', file, '--format', 'jsonl'], { env: { HOME: home, XDG_STATE_HOME: join(dir, 'state') } })
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  factsRows = run.stdout
  await writeFile(join(dir, 'facts.jsonl'), factsRows)
  await writeFile(join(dir, 'labels.jsonl'), labels())
  await writeFile(join(dir, 'labels-claim.jsonl'), labels({ 45: true }))
  // Two corrections only the signals find: neither lexical arm fires on these turns.
  await writeFile(join(dir, 'labels-unfired.jsonl'), [25, 45].map((second) => JSON.stringify({ session: SESSION, at: at(second), label: true })).join('\n') + '\n')
  // 2,001 corrections: the signals find 1,001 and the lexical arms 1,000, every hit correct. Both recalls round to 0.500.
  const many = Array.from({ length: 2001 }, (_, index) => ({ session: 'many', at: at(1000 + index) }))
  await writeFile(join(dir, 'facts-many.jsonl'), many.map((turn, index) =>
    JSON.stringify({ ...turn, text: index < 1001 ? 'ok' : "no, that's wrong", signals: index < 1001 ? ['interrupt'] : [] })).join('\n') + '\n')
  await writeFile(join(dir, 'labels-many.jsonl'), many.map((turn) => JSON.stringify({ ...turn, label: true })).join('\n') + '\n')
})

async function report(labelsFile: string, factsFile = 'facts.jsonl'): Promise<{ joined: number; corrections: number; unjoined: number; arms: Arm[]; section7: { title: string; reason: string } }> {
  const run = await bench([join(dir, labelsFile), join(dir, factsFile), '--format', 'json'])
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout)
}

const arm = (arms: readonly Arm[], name: string) => {
  const found = arms.find((entry) => entry.arm === name)!
  return { fires: found.fires, truePositives: found.truePositives, recall: found.recall, precision: found.precision }
}

describe('bench:corrections', () => {
  it('scores each signal, their union and the lexical baseline on the labelled turns that joined', async () => {
    const result = await report('labels.jsonl')
    expect(result).toMatchObject({ joined: 6, corrections: 3, unjoined: 1 })
    expect(arm(result.arms, 'interrupt')).toEqual({ fires: 1, truePositives: 1, recall: 0.333, precision: 1 })
    expect(arm(result.arms, 'rejected-tool')).toEqual({ fires: 1, truePositives: 1, recall: 0.333, precision: 1 })
    // "Working on it; … ready …" opens with progress, so the turn after it carries no after-claim.
    expect(arm(result.arms, 'after-claim')).toEqual({ fires: 2, truePositives: 1, recall: 0.333, precision: 0.5 })
    expect(arm(result.arms, 'union')).toEqual({ fires: 3, truePositives: 2, recall: 0.667, precision: 0.667 })
    expect(arm(result.arms, 'lexical')).toEqual({ fires: 3, truePositives: 2, recall: 0.667, precision: 0.667 })
    expect(arm(result.arms, 'lexical-any')).toEqual({ fires: 4, truePositives: 2, recall: 0.667, precision: 0.5 })
    expect(result.section7.title).toBe('Interrupts and rejections')
  })

  it('names the section "Correction signals" only when the union beats every lexical arm at no lower precision', async () => {
    const result = await report('labels-claim.jsonl')
    expect(arm(result.arms, 'union')).toEqual({ fires: 3, truePositives: 3, recall: 0.75, precision: 1 })
    expect(arm(result.arms, 'lexical')).toMatchObject({ recall: 0.5, precision: 0.667 })
    expect(result.section7.title).toBe('Correction signals')
  })

  it('keeps "Interrupts and rejections" when a lexical arm never fired, so its precision cannot be compared', async () => {
    const result = await report('labels-unfired.jsonl')
    expect(arm(result.arms, 'union')).toEqual({ fires: 2, truePositives: 2, recall: 1, precision: 1 })
    expect(arm(result.arms, 'lexical')).toEqual({ fires: 0, truePositives: 0, recall: 0, precision: null })
    expect(result.section7.title).toBe('Interrupts and rejections')
    expect(result.section7.reason).toContain('precision cannot be compared')
  })

  it('decides on the counts, not on rates rounded to three places', async () => {
    const result = await report('labels-many.jsonl', 'facts-many.jsonl')
    expect(arm(result.arms, 'union')).toEqual({ fires: 1001, truePositives: 1001, recall: 0.5, precision: 1 })
    expect(arm(result.arms, 'lexical')).toEqual({ fires: 1000, truePositives: 1000, recall: 0.5, precision: 1 })
    expect(result.section7.title).toBe('Correction signals')
  })

  it('reads facts rows from stdin and prints a table with the section title', async () => {
    const run = await bench([join(dir, 'labels.jsonl')], factsRows)
    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
    const lines = run.stdout.trimEnd().split('\n')
    expect(lines[0]).toBe('6 labelled turns scored (3 corrections) · labels with no facts row 1 · ambiguous 0')
    expect(lines.map((line) => line.split(/\s+/)[0])).toEqual(['6', 'arm', 'interrupt', 'rejected-tool', 'after-claim', 'union', 'lexical', 'lexical-any', 'analyze'])
    expect(lines.at(-1)).toMatch(/^analyze section 7: "Interrupts and rejections" \(union recall 0\.667 is not above lexical 0\.667/)
  })

  it('exits 2 and names the input it needs when the facts rows are not traces facts jsonl', async () => {
    const run = await bench([join(dir, 'labels.jsonl')], '{"sessions": []}\n')
    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('traces facts <refs> --format jsonl')
  })
})
