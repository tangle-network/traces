/**
 * Claude Code sessions for `traces analyze`, written as the raw JSONL the
 * harness records. Each one plants what a section or a rule reads, so a test
 * can say what the report must show and what it must never show.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const REPO = '/w/analyzed-repo'
export const START = Date.parse('2026-10-14T10:00:00.000Z')
const at = (minute: number, second = 0): string => new Date(START + minute * 60_000 + second * 1000).toISOString()

type Row = Record<string, unknown>

/** One Claude Code transcript's record builders, numbering records in order. */
function transcript(sessionId: string) {
  let n = 0
  const base = { sessionId, cwd: REPO, version: '2.1.0', gitBranch: 'main' }
  const user = (time: string, content: unknown, extra: Row = {}): Row =>
    ({ ...base, type: 'user', uuid: `u${++n}`, parentUuid: null, timestamp: time, message: { role: 'user', content }, ...extra })
  const assistant = (time: string, content: unknown[]): Row => ({
    ...base, type: 'assistant', uuid: `a${++n}`, parentUuid: null, timestamp: time,
    message: { id: `msg-${n}`, role: 'assistant', model: 'claude-opus-5-5', content, usage: { input_tokens: 10, output_tokens: 2 } },
  })
  return {
    user,
    say: (time: string, text: string): Row => assistant(time, [{ type: 'text', text }]),
    call: (time: string, id: string, name: string, input: Row): Row => assistant(time, [{ type: 'tool_use', id, name, input }]),
    result: (time: string, id: string, text: string, isError = false): Row =>
      user(time, [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }]),
  }
}

export const WORKER_ID = 'a11a1a11-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/**
 * A worker that fails `pnpm test` three times in a row, edits, claims done with
 * no check, is interrupted and corrected, idles 15 minutes, passes, opens a
 * PR, and gets thanked 48 h 29 min after it started. A background notice
 * carries the words a lexical classifier read as a correction.
 */
export function workerSession(): Row[] {
  const { user, say, call, result } = transcript(WORKER_ID)
  return [
    user(at(0), 'Fix the failing parser test.'),
    call(at(1), 't1', 'Bash', { command: 'pnpm test' }), result(at(2), 't1', 'FAIL parse.test.ts', true),
    call(at(3), 't2', 'Bash', { command: 'pnpm test' }), result(at(4), 't2', 'FAIL parse.test.ts', true),
    call(at(5), 't3', 'Bash', { command: 'pnpm test' }), result(at(6), 't3', 'FAIL parse.test.ts', true),
    call(at(7), 'e1', 'Edit', { file_path: `${REPO}/src/parse.ts`, old_string: 'a', new_string: 'b' }), result(at(7, 30), 'e1', 'ok'),
    say(at(8), 'Done: the parser is fixed.'),
    user(at(9), [{ type: 'text', text: '[Request interrupted by user]' }]),
    user(at(9, 10), 'stop, run the tests before you say done'),
    say(at(24), 'Running the tests.'),
    call(at(25), 't4', 'Bash', { command: 'pnpm test' }), result(at(26), 't4', 'PASS parse.test.ts'),
    say(at(27), 'All tests pass.'),
    user(at(28), '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>no, stop, that is wrong</summary>\n</task-notification>'),
    call(at(29), 'p1', 'Bash', { command: 'gh pr create --title "fix: parser" --body "Fixes the parser."' }),
    result(at(30), 'p1', 'https://github.com/o/analyzed-repo/pull/12'),
    say(at(31), 'Opened #12.'),
    user(at(48 * 60 + 29), 'Thanks.'),
    say(at(48 * 60 + 29, 20), 'You are welcome.'),
  ]
}

export const REVIEW_ID = 'b22b2b22-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** A pull-request review that only reads with `gh`: its outputs name tests and builds, it runs none. */
export function ghReviewSession(): Row[] {
  const { user, say, call, result } = transcript(REVIEW_ID)
  const rows: Row[] = [user(at(0), 'Review PR #12 and say whether it is ready.')]
  let minute = 1
  for (let round = 0; round < 3; round++) {
    for (const [id, command, output] of [
      ['v', 'gh pr view 12 --json title,body,statusCheckRollup', 'fix: parser\nThe build passes and pnpm test is green; vitest ran 40 tests.'],
      ['d', 'gh pr diff 12', 'diff --git a/tests/parse.test.ts b/tests/parse.test.ts\n+  it("parses", () => {})'],
      ['c', 'gh pr checks 12', 'build\tpass\ntest\tpass\ntypecheck\tpass'],
    ] as const) {
      const callId = `${id}${round}`
      rows.push(call(at(minute), callId, 'Bash', { command }), result(at(minute, 20), callId, output))
      minute += 1
    }
  }
  rows.push(say(at(minute), 'Done: PR #12 is ready; every check passed.'))
  return rows
}

/** A run of `count` calls of one tool, with or without a check among them. */
export function toolRunSession(id: string, tool: string, count: number, check: boolean): Row[] {
  const { user, say, call, result } = transcript(id)
  const rows: Row[] = [user(at(0), `Use ${tool} to gather what you need.`)]
  for (let i = 0; i < count; i++) {
    const input = tool === 'Bash'
      ? { command: check && i === count - 1 ? 'pnpm test' : `echo step-${i}` }
      : { url: `https://example.com/${i}`, prompt: 'summarize' }
    rows.push(call(at(i + 1), `c${i}`, tool, input), result(at(i + 1, 20), `c${i}`, `ok ${i}`))
  }
  rows.push(say(at(count + 2), 'Gathered.'))
  return rows
}

export const jsonl = (rows: readonly Row[]): string => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`

export interface AnalyzeHome {
  readonly dir: string
  /** A HOME holding the worker and the review under one Claude Code project. */
  readonly home: string
  readonly env: Record<string, string>
  readonly worker: string
  readonly review: string
  /** Write `rows` as a session file of its own, outside the HOME. */
  file(name: string, rows: readonly Row[]): Promise<string>
}

export async function makeAnalyzeHome(): Promise<AnalyzeHome> {
  const dir = await mkdtemp(join(tmpdir(), 'traces-analyze-'))
  const home = join(dir, 'home')
  const project = join(home, '.claude', 'projects', REPO.replaceAll('/', '-'))
  await mkdir(project, { recursive: true })
  const worker = join(project, `${WORKER_ID}.jsonl`)
  const review = join(project, `${REVIEW_ID}.jsonl`)
  await writeFile(worker, jsonl(workerSession()))
  await writeFile(review, jsonl(ghReviewSession()))
  return {
    dir,
    home,
    env: { HOME: home, XDG_STATE_HOME: join(dir, 'state') },
    worker,
    review,
    async file(name, rows) {
      const path = join(dir, name)
      await writeFile(path, jsonl(rows))
      return path
    },
  }
}
