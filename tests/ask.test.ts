/**
 * `traces ask` through the built CLI (spec U12). The only fakes are process
 * boundaries: the model endpoint (an HTTP server) and the DSPy bridge (a stub
 * child process named by TRACES_PYTHON, or run as `uvx`). The engine, its
 * model proxy, Runtime's router transport, the shared ledger, the retry and
 * the citation check are the shipped code.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ASK_KEY, type BridgeScript, type EndpointReply, type FakeEndpoint, startEndpoint, writeAskSession, writeStubBridge } from './fixtures/ask.js'
import { CLI, type CliRun, runCli } from './run-cli.js'

const AGENT_EVAL = (JSON.parse(await readFile(join(dirname(CLI), '..', 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
}).dependencies['@tangle-network/agent-eval']!

interface Answers {
  ok: boolean
  budgetUsd: number
  questionBudgetUsd: number
  questionTimeoutMs: number
  concurrency: number
  engine: { model: string }
  questions: Array<{
    id: string
    status: string
    answer: string | null
    failure?: { kind: string; message: string }
    citations: Array<{ uri: string; resolved: boolean }>
    parsedAnswer?: unknown
  }>
}

let dir: string
let session: Awaited<ReturnType<typeof writeAskSession>>
let endpoint: FakeEndpoint | undefined
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'traces-ask-'))
  session = await writeAskSession(dir)
})
afterEach(async () => {
  await endpoint?.close()
  endpoint = undefined
})

const cite = () => `trace://${session.traceId}/span/${session.toolSpanId}`

/** A run against a fresh endpoint and stub bridge, in a fresh home. */
async function ask(
  argv: readonly string[],
  opts: { replies?: readonly EndpointReply[]; bridge?: readonly BridgeScript[]; env?: Record<string, string> } = {},
): Promise<CliRun & { endpoint: FakeEndpoint; bridgeLog: string }> {
  const run = await mkdtemp(join(dir, 'run-'))
  endpoint = await startEndpoint(opts.replies ?? ['ok'])
  const bridge = await writeStubBridge(join(run, 'bridge'), opts.bridge ?? [{ match: '', answer: `It failed at ${cite()}.` }])
  const result = await runCli(argv, {
    env: {
      HOME: join(run, 'home'),
      XDG_STATE_HOME: join(run, 'state'),
      TANGLE_API_KEY: ASK_KEY,
      OPENAI_BASE_URL: endpoint.baseUrl,
      TRACES_PYTHON: bridge.path,
      ...opts.env,
    },
    timeoutMs: 120_000,
  })
  return { ...result, endpoint, bridgeLog: bridge.log }
}

const errorOf = (stderr: string): { error: string; code: string } => JSON.parse(stderr.trim().split('\n').at(-1)!) as { error: string; code: string }

describe('traces ask: before it spends', () => {
  it('needs --budget, a question and well-formed questions, and spends nothing without them', async () => {
    const noBudget = await ask(['ask', session.path, '--question', 'Which command failed first?'])
    expect(noBudget.code).toBe(2)
    expect(noBudget.stderr).toContain('ask needs --budget USD, the most the run may spend')
    expect(noBudget.stderr).toContain(`traces ask ${session.path} --question 'Which command failed first?' --budget 1`)

    const noQuestion = await ask(['ask', session.path, '--budget', '1', '--format', 'json'])
    expect(noQuestion.code).toBe(2)
    expect(errorOf(noQuestion.stderr)).toMatchObject({ code: 'usage', error: expect.stringContaining('ask needs --question') })

    const file = join(dir, 'typo.json')
    await writeFile(file, JSON.stringify([{ question: 'Anything?', schema: { type: 'string' } }]), 'utf8')
    const typo = await ask(['ask', session.path, '--questions', file, '--budget', '1', '--format', 'json'])
    expect(errorOf(typo.stderr)).toMatchObject({ code: 'usage', error: expect.stringContaining('entry 1 has unknown key "schema"') })

    const long = await ask(['ask', session.path, '--question', 'x'.repeat(2_000), '--budget', '1'])
    expect(long.code).toBe(2)
    expect(long.stderr).toMatch(/the limit is \d+ so the model sees it whole/u)

    for (const run of [noBudget, noQuestion, typo, long]) {
      expect(run.stdout).toBe('')
      expect(run.endpoint.requests).toHaveLength(0)
      expect(existsSync(run.bridgeLog)).toBe(false)
    }
  })

  it('refuses a model it cannot price, since it could not bound the spend', async () => {
    const run = await ask(['ask', session.path, '--question', 'q', '--model', 'no-such-model-s18', '--budget', '1', '--format', 'json'])
    expect(run.code).toBe(2)
    expect(errorOf(run.stderr)).toMatchObject({ code: 'model', error: expect.stringContaining('ask cannot price --model no-such-model-s18') })
    expect(run.endpoint.requests).toHaveLength(0)
    expect(existsSync(run.bridgeLog)).toBe(false)
  })

  it('names every missing requirement, the key and the Python bridge, before any spend', async () => {
    const out = join(dir, 'never-written')
    const run = await ask(['ask', session.path, '--question', 'q', '--budget', '0.1', '--out', out, '--format', 'json'], {
      env: { TANGLE_API_KEY: '', TRACES_PYTHON: '', PATH: join(dir, 'empty-bin') },
    })
    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
    const error = errorOf(run.stderr)
    expect(error.code).toBe('setup')
    expect(error.error).toContain('TANGLE_API_KEY')
    expect(error.error).toContain('install uv')
    expect(error.error).toContain(`TRACES_PYTHON to a Python with agent-eval-rpc[dspy]==${AGENT_EVAL}`)
    expect(error.error).toContain('Nothing was spent')
    expect(run.endpoint.requests).toHaveLength(0)
    expect(existsSync(out)).toBe(false)
  })
})

describe('traces ask: answers', () => {
  it('answers through the bridge, checks each citation, and writes answers.json and report.md under --out', async () => {
    const out = join(dir, 'answered')
    const run = await ask(['ask', session.path, '--question', 'Which command failed first?', '--budget', '5', '--out', out], {
      bridge: [{ match: 'failed first', answer: `# Bash\n\nThe bash call failed first (**${cite()}**).` }],
    })
    expect(run.code, run.stderr).toBe(0)
    expect(run.stdout).toMatch(new RegExp(`^answers → ${out} {2}\\(answers\\.json, report\\.md: 1/1 answered, \\$0\\.00040, \\d+\\.\\d s\\)\\n$`, 'u'))
    expect(run.endpoint.requests).toEqual([{ model: 'gpt-5.6-luna', authorized: true }])
    // The bridge's DSPy refuses an OpenAI reasoning model whose completion cap is below 16,000.
    const [bridged] = (await readFile(run.bridgeLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { modelProxy: { model: string; maxOutputTokens: number } })
    expect(bridged!.modelProxy.model).toBe('gpt-5.6-luna')
    expect(bridged!.modelProxy.maxOutputTokens).toBeGreaterThanOrEqual(16_000)

    const answers = JSON.parse(await readFile(join(out, 'answers.json'), 'utf8')) as Answers
    // Discovery's per-question values are the defaults: min(budget, $2), 1800 s, 4 at once.
    expect(answers).toMatchObject({ ok: true, budgetUsd: 5, questionBudgetUsd: 2, questionTimeoutMs: 1_800_000, concurrency: 4 })
    expect(answers.questions[0]).toMatchObject({ id: 'q1', status: 'answered', citations: [{ uri: cite(), resolved: true }] })
    const report = await readFile(join(out, 'report.md'), 'utf8')
    // The answer's own heading sits under its question's section.
    expect(report).toContain('## q1: Which command failed first?\n\n### Bash')
    expect(report).toContain('Citations:** 1 of 1 resolve to a span in the trace')
  })

  it('prints every answer as JSON, and keeps a small budget small', async () => {
    const run = await ask(['ask', session.path, '--question', 'Which command failed first?', '--budget', '1.5', '--format', 'json'])
    expect(run.code, run.stderr).toBe(0)
    const answers = JSON.parse(run.stdout) as Answers & { report?: string }
    expect(answers).not.toHaveProperty('report')
    expect(answers).toMatchObject({ ok: true, budgetUsd: 1.5, questionBudgetUsd: 1.5 })
    expect(answers.questions[0]!.citations).toEqual([expect.objectContaining({ uri: cite(), resolved: true })])
  })

  it('runs the pinned bridge with uv when TRACES_PYTHON is unset', async () => {
    const bin = join(dir, 'uv-bin')
    await mkdir(bin, { recursive: true })
    const uvx = await writeStubBridge(join(bin, 'uvx'), [{ match: '', answer: `It failed at ${cite()}.` }])
    const run = await ask(['ask', session.path, '--question', 'Which command failed first?', '--budget', '1'], {
      env: { TRACES_PYTHON: '', PATH: bin },
    })
    expect(run.code, run.stderr).toBe(0)
    const [call] = (await readFile(uvx.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { argv: string[] })
    expect(call!.argv.slice(0, 6)).toEqual(['--from', `agent-eval-rpc[dspy]==${AGENT_EVAL}`, 'python', '-m', 'agent_eval_rpc.dspy_rlm_bridge', '--max-input-bytes'])
  })

  it('exits 2 with code partial when only some questions are answered, and still writes every answer', async () => {
    const out = join(dir, 'partial')
    const missing = `trace://${session.traceId}/span/00000000deadbeef`
    const run = await ask([
      'ask', session.path, '--budget', '3', '--out', out, '--format', 'json',
      '--question', 'Which command failed first?',
      '--question', 'Which file changed?',
      '--question', 'What did the bridge say?',
    ], {
      bridge: [
        { match: 'failed first', answer: `The bash call (${cite()}).` },
        { match: 'file changed', answer: `None changed (${missing}).` },
        { match: 'bridge say', modelCalls: 0, fail: "DSPY-BRIDGE-FAILURE: ModuleNotFoundError: No module named 'agent_eval_rpc'" },
      ],
    })
    expect(run.code).toBe(2)
    expect(JSON.parse(run.stdout)).toMatchObject({ out, answered: 1, questions: 3 })
    const error = errorOf(run.stderr)
    expect(error.code).toBe('partial')
    expect(error.error).toContain('2 of 3 question(s) unanswered (q2: unresolved-citations, q3: error)')
    // A bridge that is missing or the wrong version gets the line that fixes it.
    expect(error.error).toContain(`agent-eval-rpc[dspy]==${AGENT_EVAL}, or unset it to let uv run that version`)
    const answers = JSON.parse(await readFile(join(out, 'answers.json'), 'utf8')) as Answers
    expect(answers.questions.map((answer) => [answer.id, answer.status, answer.failure?.kind ?? null])).toEqual([
      ['q1', 'answered', null],
      ['q2', 'failed', 'unresolved-citations'],
      ['q3', 'failed', 'error'],
    ])
    expect(answers.questions[1]!.citations).toEqual([expect.objectContaining({ uri: missing, resolved: false })])
    expect(await readFile(join(out, 'report.md'), 'utf8')).toContain(`**Unresolved:** ${missing}`)
  })
})

describe('traces ask: a model endpoint that refuses', () => {
  it('retries a busy endpoint inside the call: a billing outage costs a wait, not the question', async () => {
    const run = await ask(['ask', session.path, '--question', 'Which command failed first?', '--budget', '1'], {
      replies: ['billing', 'billing', 'ok'],
    })
    expect(run.code, run.stderr).toBe(0)
    expect(run.endpoint.requests).toHaveLength(3)
    expect(run.stderr).toContain('[analyst] WARN model call failed (503: Billing is temporarily unavailable. Retry shortly.); attempt 2 of 10 in')
    expect(run.stdout).toContain('**1 answered, 0 failed.**')
  }, 60_000)

  it.each([
    ['a key that cannot pay', 'payment', 'gpt-5.6-luna', 'auth', 'the model endpoint refused the key (402: Inference requires verified paid access.'],
    ['a model the key cannot use, refused with a 503', 'pricing', 'gpt-6-luna', 'model', 'cannot serve --model gpt-6-luna (503: Trusted pricing is unavailable'],
    ['a completion from another model', 'substituted', 'glm-5.3', 'model', 'the endpoint served "accounts/fireworks/models/glm-5p3" for --model "glm-5.3"'],
  ] as const)('stops every question at the first refused call on %s: exit 2 with its code, nothing retried', async (_case, reply, model, code, says) => {
    const out = join(dir, `refused-${reply}`)
    const questions = ['first', 'second', 'third', 'fourth', 'fifth'].flatMap((word) => ['--question', `Which command ran ${word}?`])
    const run = await ask(['ask', session.path, ...questions, '--model', model, '--budget', '2', '--out', out, '--format', 'json'], {
      replies: [reply],
    })
    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
    const error = errorOf(run.stderr)
    expect(error.code).toBe(code)
    expect(error.error).toContain(says)
    expect(error.error).toContain('ask stopped every question at the first refused call')
    // Four questions start at once; each reaches the endpoint at most once, and the fifth never starts.
    expect(run.endpoint.requests.length).toBeGreaterThanOrEqual(1)
    expect(run.endpoint.requests.length).toBeLessThanOrEqual(4)
    const answers = JSON.parse(await readFile(join(out, 'answers.json'), 'utf8')) as Answers
    expect(answers.questions.every((answer) => answer.status === 'failed')).toBe(true)
    expect(answers.questions[4]!.failure?.kind).toBe('aborted')
  }, 60_000)
})
