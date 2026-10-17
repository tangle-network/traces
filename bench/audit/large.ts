/**
 * The large-session arm: one synthetic Codex session of about 50,000 spans,
 * where an agent reading the raw file pays the most. It answers four questions
 * that `traces facts` answers, scored by the same rules as the 19, and reported
 * apart from them; it does not decide the release rule.
 *
 * Like `fixtures.ts`, every planted fact is recorded while its record is
 * written, so the gold comes from the plan. Every command is a plain
 * `exec_command` call, so "how many commands" has one reading.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Clock, CodexWriter, type GoldAnswers, type BenchManifest, mulberry32, shellOutput, uuidV7 } from './fixtures.js'
import type { Question } from './questions.js'
import { type AnswersFile, scoreAnswer } from './score.js'

/** Tool calls in the arm's session; at this size `traces convert` writes about 50,000 spans. */
export const LARGE_TOOL_CALLS = 40_000

const SEED = 0x1a26_e5e5
const START_MS = Date.UTC(2026, 3, 2, 8, 0, 0)
const CWD = '/work/atlas'
const REPO = 'acme/atlas'
const TURNS = 40

const count = { kind: 'count' } as const

export const LARGE_QUESTIONS: readonly Question[] = [
  {
    id: 'large.commands',
    session: 'codex-large',
    probes: ['F2'],
    text: 'How many exec_command calls did the session make, and how many of those exited with a non-zero code? A write_stdin poll is not an exec_command call.',
    paraphrases: [],
    schema: { exec_commands: count, nonzero_exits: count },
  },
  {
    id: 'large.pull-requests',
    session: 'codex-large',
    probes: ['F2', 'F4'],
    text: 'Which pull requests did the session create, and which did it merge? Give their numbers.',
    paraphrases: [],
    schema: { created: { kind: 'set', of: 'integer' }, merged: { kind: 'set', of: 'integer' } },
  },
  {
    id: 'large.test-runs',
    session: 'codex-large',
    probes: ['F2'],
    text: 'How many times did the session run `pnpm test`, with any arguments?',
    paraphrases: [],
    schema: { pnpm_test_runs: count },
  },
  {
    id: 'large.last-human-turn',
    session: 'codex-large',
    probes: ['F1'],
    text: 'What is the last message the person typed into the session? Give its text verbatim.',
    paraphrases: [],
    schema: { text: { kind: 'string' } },
  },
]

export interface LargeBench {
  readonly manifest: BenchManifest
  readonly files: ReadonlyArray<{ path: string; content: string }>
  readonly gold: GoldAnswers
}

const PACKAGES = ['core', 'cli', 'web', 'store', 'sync', 'auth'] as const
const FILES = ['src/index.ts', 'src/graph.ts', 'src/store.ts', 'src/retry.ts', 'src/cache.ts', 'test/graph.test.ts'] as const
const WORDS = ['retryBudget', 'flushQueue', 'openStore', 'resolveGraph', 'cacheKey', 'syncCursor'] as const

/** The large session, `toolCalls` tool calls long, and the gold for {@link LARGE_QUESTIONS}. */
export function generateLarge(toolCalls = LARGE_TOOL_CALLS): LargeBench {
  const random = mulberry32(SEED)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const clock = new Clock(START_MS, random)
  const w = new CodexWriter(clock, random)
  const sessionId = uuidV7(START_MS, random)
  const file = `codex/sessions/2026/04/02/rollout-2026-04-02T08-00-00-${sessionId}.jsonl`
  const prUrl = (number: number): string => `https://github.com/${REPO}/pull/${number}`
  const gold = { execCommands: 0, nonzero: 0, created: [] as number[], merged: [] as number[], pnpmTests: 0, lastHuman: '' }
  let calls = 0
  let turnId = ''
  let processId = 9_000
  const cumulative = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 }

  const exec = (cmd: string, result: number | { running: number }, body: string): void => {
    const call = w.call('exec_command', { cmd, workdir: CWD, yield_time_ms: 10_000 })
    w.output(call, shellOutput(random, result, body))
    gold.execCommands += 1
    if (typeof result === 'number' && result !== 0) gold.nonzero += 1
    if (/^pnpm test(?: |$)/u.test(cmd)) gold.pnpmTests += 1
    tick()
  }
  const poll = (session: number, result: number | { running: number }, body: string): void => {
    const call = w.call('write_stdin', { session_id: session, chars: '', yield_time_ms: 5_000 })
    w.output(call, shellOutput(random, result, body))
    tick()
  }
  const tick = (): void => {
    calls += 1
    if (calls % 4 === 0) w.message('assistant', `Checked ${pick(FILES)}; continuing with ${pick(WORDS)}.`)
    if (calls % 8 !== 0) return
    const input = 30_000 + Math.floor(random() * 50_000)
    const output = 300 + Math.floor(random() * 1_500)
    const last = { input_tokens: input, cached_input_tokens: Math.floor(input * 0.9), output_tokens: output, reasoning_output_tokens: Math.floor(output / 3), total_tokens: input + output }
    for (const key of Object.keys(cumulative) as Array<keyof typeof cumulative>) cumulative[key] += last[key]
    w.row('event_msg', { type: 'token_count', info: { last_token_usage: last, total_token_usage: { ...cumulative }, model_context_window: 272_000 } })
  }
  /** One ordinary command, chosen at random; some fail. */
  const work = (): void => {
    const roll = random()
    const pkg = pick(PACKAGES)
    if (roll < 0.3) {
      const word = pick(WORDS)
      const hit = random() < 0.8
      exec(`rg -n ${word} packages/${pkg}/src`, hit ? 0 : 1, hit ? `packages/${pkg}/src/${pick(FILES).slice(4)}:${1 + Math.floor(random() * 300)}:  ${word}(next)\n` : '')
    } else if (roll < 0.5) {
      exec(`sed -n 1,80p packages/${pkg}/${pick(FILES)}`, 0, `export function ${pick(WORDS)}() {\n  return next\n}\n`)
    } else if (roll < 0.62) {
      const failed = random() < 0.35
      exec(`pnpm test --filter @acme/${pkg}`, failed ? 1 : 0, failed ? `FAIL packages/${pkg}/test/graph.test.ts\n  expected 3, received 4\n` : 'Test Files 4 passed (4)\n')
    } else if (roll < 0.72) {
      exec(`pnpm lint --filter @acme/${pkg}`, random() < 0.1 ? 1 : 0, 'done\n')
    } else if (roll < 0.86) {
      exec('git status --short', 0, ` M packages/${pkg}/${pick(FILES)}\n`)
    } else if (roll < 0.95) {
      exec(`ls packages/${pkg}/src`, 0, FILES.map((path) => path.split('/').at(-1)).join('\n'))
    } else {
      // A dev server polled in the background; its poll may report a crash, which is not an exec_command exit.
      processId += 1
      exec(`pnpm dev --filter @acme/${pkg}`, { running: processId }, 'ready on http://localhost:5173\n')
      poll(processId, random() < 0.5 ? 1 : { running: processId }, random() < 0.5 ? 'error: port in use\n' : 'hmr update\n')
    }
  }

  w.row('session_meta', { id: sessionId, timestamp: new Date(START_MS).toISOString(), cwd: CWD, originator: 'codex_cli_rs', cli_version: '0.150.0', source: 'cli', model_provider: 'openai' }, new Date(START_MS).toISOString())
  w.message('user', '# AGENTS.md instructions for /work/atlas\n\n<INSTRUCTIONS>\nRun pnpm test before every commit.\n</INSTRUCTIONS>')

  const perTurn = Math.floor(toolCalls / TURNS)
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const started = clock.next()
    turnId = uuidV7(Date.parse(started), random)
    w.row('event_msg', { type: 'task_started', turn_id: turnId, started_at: Math.floor(Date.parse(started) / 1_000), model_context_window: 272_000 }, started)
    w.row('turn_context', { cwd: CWD, approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' }, model: 'gpt-5-codex' })
    const text = turn === TURNS
      ? 'ship it once the sync tests pass, then stop'
      : `Turn ${turn}: keep going on the ${pick(PACKAGES)} package and fix what the tests show.`
    w.message('user', text)
    gold.lastHuman = text
    while (calls < perTurn * turn) work()
    if (turn === 12) {
      exec('gh pr create --title "fix(store): flush the queue on close" --fill', 0, `${prUrl(212)}\n`)
      gold.created.push(212)
    }
    if (turn === 20) {
      processId += 1
      exec('gh pr create --title "feat(sync): resume from the cursor" --fill', { running: processId }, `Creating pull request for feat/sync-cursor into main in ${REPO}\n`)
      poll(processId, 0, `${prUrl(219)}\n`)
      gold.created.push(219)
      exec('gh pr merge 212 --squash --delete-branch', 0, `Squashed and merged pull request ${REPO}#212 (fix(store): flush the queue on close)\n`)
      gold.merged.push(212)
    }
    if (turn === 33) {
      exec('gh pr create --title "test(graph): cover cycles" --fill', 0, `${prUrl(231)}\n`)
      gold.created.push(231)
      exec('gh pr merge 219 --squash --delete-branch', 0, `Squashed and merged pull request ${REPO}#219 (feat(sync): resume from the cursor)\n`)
      gold.merged.push(219)
    }
    const message = `Turn ${turn} done.`
    w.message('assistant', message)
    w.row('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: message })
  }
  // Injected after the last typed turn: a reader that trusts the user role reports one of these.
  w.message('user', '<environment_context>\n  <cwd>/work/atlas</cwd>\n  <shell>zsh</shell>\n</environment_context>')
  w.message('user', '<subagent_notification>\n{"agent_path":"/root/sync_check","status":"completed"}\n</subagent_notification>')

  return {
    manifest: { version: 1, sessions: [{ id: 'codex-large', harness: 'codex', path: file, sessionId }], files: [file] },
    files: [{ path: file, content: w.out.text() }],
    gold: {
      'large.commands': { exec_commands: gold.execCommands, nonzero_exits: gold.nonzero },
      'large.pull-requests': { created: gold.created, merged: gold.merged },
      'large.test-runs': { pnpm_test_runs: gold.pnpmTests },
      'large.last-human-turn': { text: gold.lastHuman },
    },
  }
}

/** Write the large session under `root`, with its manifest and prompts beside it. */
export async function writeLarge(root: string, bench: LargeBench, prompts: string): Promise<void> {
  for (const item of [...bench.files, { path: 'manifest.json', content: `${JSON.stringify(bench.manifest, null, 2)}\n` }, { path: 'prompts.jsonl', content: prompts }]) {
    await mkdir(dirname(join(root, item.path)), { recursive: true })
    await writeFile(join(root, item.path), item.content)
  }
}

/** No question here asks for a quote, so no citation is ever resolved. */
const NO_CITATIONS = { resolve: () => undefined, contains: () => false }

/** Score a large-session answers file: each answer's verdict, then the arm's tally and cost. */
export function scoreLarge(file: AnswersFile, gold: GoldAnswers): string {
  const rows = file.answers.map((row) => {
    const question = LARGE_QUESTIONS.find((item) => item.id === row.question)
    if (!question) throw new Error(`not a large-session question: ${row.question}`)
    return { row, verdict: scoreAnswer(question, row, gold, NO_CITATIONS).verdict }
  })
  const cost = rows.reduce((total, { row }) => total + (row.cost_usd ?? 0), 0)
  const missing = rows.filter(({ row }) => row.cost_usd == null).length
  const tally = (verdict: string) => rows.filter((item) => item.verdict === verdict).length
  return [
    `| ${file.arm} | correct / partial / wrong | cost |`,
    '|---|---|---|',
    ...rows.map(({ row, verdict }) => `| ${row.question} | ${verdict} | ${row.cost_usd == null ? 'missing' : `$${row.cost_usd.toFixed(4)}`} |`),
    `| **total** | **${tally('correct')} / ${tally('partial')} / ${tally('wrong')}** | **$${cost.toFixed(4)}**${missing ? ` (${missing} missing)` : ''} |`,
  ].join('\n')
}
