/**
 * Deterministic generator for the public audit benchmark.
 *
 * Every session here is synthetic. Each planted fact is recorded while its
 * record is written, so the gold answers come from the plan, never from parsing
 * the files back. The gold therefore does not depend on any traces adapter, and
 * an adapter defect shows up as a wrong answer instead of a wrong answer key.
 *
 * Every timestamp the gold scores as a time is more than the scorer's 1 s
 * tolerance away from any other record time in its file, so the tolerance can
 * never accept a neighboring record's time. That is the property the tolerance
 * rests on, and `fixtures.test.ts` asserts it. It is narrower than a uniform
 * spacing: the child's inherited history all carries the fork timestamp, as
 * Codex rewrites it, and no scored time is read from that block.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type BenchSessionId = 'codex-operator' | 'codex-child' | 'claude'

export interface BenchSession {
  id: BenchSessionId
  harness: 'codex' | 'claude-code'
  /** Path relative to the fixture root. */
  path: string
  sessionId: string
}

export interface BenchManifest {
  version: 1
  sessions: BenchSession[]
  /** Every file under the fixture root, relative, sorted. */
  files: string[]
}

/** Gold answers keyed by question id, in the answer shape an arm submits. */
export type GoldAnswers = Record<string, Record<string, unknown>>

export interface BenchFile {
  path: string
  content: string
}

export interface GeneratedBench {
  manifest: BenchManifest
  files: BenchFile[]
  gold: GoldAnswers
}

const SEED = 0x5eed_a0d1
const OPERATOR_START_MS = Date.UTC(2026, 2, 14, 9, 0, 0)
const CLAUDE_START_MS = Date.UTC(2026, 2, 15, 14, 0, 0)
const CODEX_MODEL = 'gpt-5-codex'
const CLAUDE_MODEL = 'claude-sonnet-4-5'
const REPO = 'acme/orbit'
const OPERATOR_CWD = '/work/orbit'
const CLAUDE_CWD = '/work/ledger'
/** More than 500, so a paged search over this command reports more hits than one page holds. */
const STATUS_POLLS = 523

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

type Random = () => number

function hex(random: Random, length: number): string {
  let out = ''
  for (let index = 0; index < length; index += 1) out += Math.floor(random() * 16).toString(16)
  return out
}

function base62(random: Random, length: number): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let out = ''
  for (let index = 0; index < length; index += 1) out += alphabet[Math.floor(random() * alphabet.length)]
  return out
}

/** A UUIDv7 whose timestamp field is `ms`, as Codex session and turn ids are. */
function uuidV7(ms: number, random: Random): string {
  const time = ms.toString(16).padStart(12, '0')
  const variant = (8 + Math.floor(random() * 4)).toString(16)
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex(random, 3)}-${variant}${hex(random, 3)}-${hex(random, 12)}`
}

function uuidV4(random: Random): string {
  const variant = (8 + Math.floor(random() * 4)).toString(16)
  return `${hex(random, 8)}-${hex(random, 4)}-4${hex(random, 3)}-${variant}${hex(random, 3)}-${hex(random, 12)}`
}

class Clock {
  constructor(private ms: number, private readonly random: Random) {}

  get now(): number {
    return this.ms
  }

  next(minMs = 2_000, maxMs = 12_000): string {
    this.ms += minMs + Math.floor(this.random() * (maxMs - minMs))
    return new Date(this.ms).toISOString()
  }

  /** Move past `ms` so the next record follows everything written on another clock. */
  passAt(ms: number): void {
    this.ms = Math.max(this.ms, ms)
  }
}

/** Where a planted record landed: its 1-based line and its timestamp. */
interface Placed {
  line: number
  at: string
}

interface Call extends Placed {
  callId: string
  kind: 'function' | 'custom'
}

class Jsonl {
  readonly rows: string[] = []

  push(row: unknown): number {
    this.rows.push(JSON.stringify(row))
    return this.rows.length
  }

  text(): string {
    return `${this.rows.join('\n')}\n`
  }
}

const cite = (file: string, line: number): string => `${file}:${line}`
const quote = (file: string, placed: Placed, text: string) => ({ text, cite: cite(file, placed.line) })

class CodexWriter {
  readonly out = new Jsonl()

  constructor(readonly clock: Clock, private readonly random: Random) {}

  row(type: string, payload: Record<string, unknown>, at = this.clock.next()): Placed {
    return { line: this.out.push({ timestamp: at, type, payload }), at }
  }

  message(role: 'user' | 'assistant', text: string): Placed {
    return this.row('response_item', {
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    })
  }

  call(name: string, args: Record<string, unknown>): Call {
    const callId = `call_${base62(this.random, 24)}`
    const placed = this.row('response_item', { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId })
    return { ...placed, callId, kind: 'function' }
  }

  custom(name: string, input: string): Call {
    const callId = `call_${base62(this.random, 24)}`
    const placed = this.row('response_item', { type: 'custom_tool_call', status: 'completed', call_id: callId, name, input })
    return { ...placed, callId, kind: 'custom' }
  }

  output(call: Call, output: string): Placed {
    return this.row('response_item', {
      type: call.kind === 'function' ? 'function_call_output' : 'custom_tool_call_output',
      call_id: call.callId,
      output,
    })
  }
}

/** The shell-tool output envelope Codex writes for `exec_command` and `write_stdin`. */
function shellOutput(random: Random, result: number | { running: number }, body: string): string {
  const status = typeof result === 'number'
    ? `Process exited with code ${result}`
    : `Process running with session ID ${result.running}`
  return [
    `Chunk ID: ${hex(random, 6)}`,
    `Wall time: ${(0.2 + random() * 4).toFixed(4)} seconds`,
    status,
    `Original token count: ${Math.max(1, Math.ceil(body.length / 4))}`,
    'Output:',
    body,
  ].join('\n')
}

const PATCH_ACTIONS: Record<string, string> = { Add: 'A', Update: 'M', Delete: 'D' }

/** The summary Codex prints after a successful patch. */
function patchSummary(text: string): string {
  const lines = [...text.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((match) => `${PATCH_ACTIONS[match[1]!]} ${match[2]}`)
  return `Success. Updated the following files:\n${lines.join('\n')}\n`
}

interface TokenUsage {
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
  total_tokens: number
}

interface Spawn {
  name: string
  failed: boolean
}

interface PullRequest {
  created_at: string
  merged_at?: string
  reviewed_before_merge?: boolean
}

interface OperatorPlan {
  file: string
  sessionId: string
  rows: string[]
  first: Placed
  last: Placed
  child: { sessionId: string; agentPath: string; forkRows: string[]; spawnAtMs: number }
  gold: GoldAnswers
}

function operatorSession(random: Random): OperatorPlan {
  const clock = new Clock(OPERATOR_START_MS, random)
  const w = new CodexWriter(clock, random)
  const sessionId = uuidV7(OPERATOR_START_MS, random)
  const file = `codex/sessions/2026/03/14/rollout-2026-03-14T09-00-00-${sessionId}.jsonl`
  const prUrl = (number: number): string => `https://github.com/${REPO}/pull/${number}`

  const humans: Array<Placed & { text: string }> = []
  const corrections: Array<Placed & { text: string }> = []
  const spawns: Spawn[] = []
  const prs = new Map<number, PullRequest>()
  const changedPaths = new Set<string>()
  const runs = { launched: 0, failed: 0, cancelled: 0, specs: new Set<string>(), betaVariants: new Set<string>() }
  const exits: number[] = []
  const launchedIds: string[] = []
  let statusPolls = 0
  let toolCalls = 0
  let turnId = ''
  let child: OperatorPlan['child'] | undefined
  const cumulative: TokenUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 }
  let lastTokenEvent: Record<string, unknown> | undefined

  const tokenCount = (): void => {
    const input = 20_000 + Math.floor(random() * 40_000)
    const output = 200 + Math.floor(random() * 1_800)
    const last: TokenUsage = {
      input_tokens: input,
      cached_input_tokens: Math.floor(input * 0.85),
      output_tokens: output,
      reasoning_output_tokens: Math.floor(output * 0.3),
      total_tokens: input + output,
    }
    for (const key of Object.keys(cumulative) as Array<keyof TokenUsage>) cumulative[key] += last[key]
    lastTokenEvent = { type: 'token_count', info: { last_token_usage: last, total_token_usage: { ...cumulative }, model_context_window: 272_000 } }
    w.row('event_msg', lastTokenEvent)
  }
  const afterTool = (): void => {
    toolCalls += 1
    if (toolCalls % 8 === 0) tokenCount()
  }
  const startTurn = (): void => {
    const at = clock.next()
    turnId = uuidV7(Date.parse(at), random)
    w.row('event_msg', { type: 'task_started', turn_id: turnId, started_at: Math.floor(Date.parse(at) / 1_000), model_context_window: 272_000 }, at)
    w.row('turn_context', { cwd: OPERATOR_CWD, approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' }, model: CODEX_MODEL })
  }
  const endTurn = (message: string): void => {
    w.message('assistant', message)
    w.row('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: message })
  }
  const human = (text: string, correction = false): void => {
    const placed = { ...w.message('user', text), text }
    humans.push(placed)
    if (correction) corrections.push(placed)
  }
  const exec = (cmd: string, result: number | { running: number }, body: string): Call & { output: Placed } => {
    const call = w.call('exec_command', { cmd, workdir: OPERATOR_CWD, yield_time_ms: 10_000 })
    const output = w.output(call, shellOutput(random, result, body))
    if (typeof result === 'number' && result !== 0) exits.push(result)
    // Counted here, so the two `labctl status` calls that name a run that does not exist count too.
    if (cmd.startsWith('labctl status ')) statusPolls += 1
    afterTool()
    return { ...call, output }
  }
  const writeStdin = (sessionIdValue: number, result: number | { running: number }, body: string): Call => {
    const call = w.call('write_stdin', { session_id: sessionIdValue, chars: '', yield_time_ms: 5_000 })
    w.output(call, shellOutput(random, result, body))
    afterTool()
    return call
  }
  const script = (source: string, body: string): Call => {
    const call = w.custom('exec', source)
    w.output(call, `Script completed\nWall time ${(0.5 + random() * 30).toFixed(1)} seconds\nOutput:\n${body}`)
    afterTool()
    return call
  }
  const patch = (text: string, paths: readonly string[]): Call => {
    const call = w.custom('apply_patch', text)
    w.output(call, JSON.stringify({ output: patchSummary(text), metadata: { exit_code: 0, duration_seconds: 0.1 } }))
    for (const path of paths) changedPaths.add(path)
    afterTool()
    return call
  }
  const spawn = (name: string, message: string, failure?: string): void => {
    const agentPath = `/root/${name}`
    const call = w.call('spawn_agent', { task_name: agentPath, message })
    let agentId: string | undefined
    if (failure) {
      w.output(call, `spawn_agent failed: ${failure}`)
    } else {
      agentId = uuidV7(Date.parse(call.at) + 500, random)
      w.output(call, JSON.stringify({ agent_id: agentId, task_name: agentPath, nickname: `Agent-${name.slice(0, 4)}` }))
    }
    spawns.push({ name: agentPath, failed: Boolean(failure) })
    if (name === 'flaky_test_hunt' && agentId) {
      // A forked child starts with the parent's history up to the spawn call.
      child = { sessionId: agentId, agentPath, forkRows: w.out.rows.slice(1, call.line - 1), spawnAtMs: Date.parse(call.at) }
    }
    afterTool()
  }
  const launch = (spec: string, args: string, result: number, body: string, runId?: string): void => {
    exec(`labctl run ${spec}${args}`, result, body)
    if (result !== 0) {
      runs.failed += 1
      return
    }
    runs.launched += 1
    runs.specs.add(spec)
    if (runId) launchedIds.push(runId)
  }
  const poll = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
      const runId = launchedIds[Math.floor(random() * launchedIds.length)] ?? 'a-01'
      const step = 1 + Math.floor(random() * 40)
      exec(`labctl status ${runId}`, 0, `${runId} running step=${step}/40\n`)
    }
  }

  const first = w.row('session_meta', {
    id: sessionId,
    timestamp: new Date(OPERATOR_START_MS).toISOString(),
    cwd: OPERATOR_CWD,
    originator: 'codex_cli_rs',
    cli_version: '0.150.0',
    source: 'cli',
    model_provider: 'openai',
  }, new Date(OPERATOR_START_MS).toISOString())
  w.message('user', '# AGENTS.md instructions for /work/orbit\n\n<INSTRUCTIONS>\nRun pnpm test before every commit.\nOpen one pull request per change.\n</INSTRUCTIONS>')
  w.message('user', '<environment_context>\n  <cwd>/work/orbit</cwd>\n  <approval_policy>on-request</approval_policy>\n  <sandbox_mode>workspace-write</sandbox_mode>\n  <shell>zsh</shell>\n</environment_context>')

  // Turn 1: fix, open three pull requests, spawn the first helpers.
  startTurn()
  human('Ship the retry budget change. Open a PR for each part, merge each one once its checks pass, then start the alpha, beta and gamma sweeps.')
  w.message('assistant', 'Checking the tree and the current test result first.')
  exec('git status --short', 0, ' M packages/retry/src/budget.ts\n')
  exec('pnpm test --filter @acme/retry', 1, 'FAIL packages/retry/test/budget.test.ts\n  expected 3 attempts, received 4\n')
  patch('*** Begin Patch\n*** Update File: packages/retry/src/budget.ts\n@@\n-  return attempts <= budget.max\n+  return attempts < budget.max\n*** End Patch', ['packages/retry/src/budget.ts'])
  exec('pnpm test --filter @acme/retry', 0, 'Test Files 6 passed (6)\n')
  exec('rg -n "export async function runGraph" node_modules/@acme/runtime/dist', 0, 'node_modules/@acme/runtime/dist/graph.js:14:export async function runGraph(graph, options = {}) {\n')
  spawn('schema_audit', 'Check every retry config schema for fields the budget change removed.')
  spawn('flaky_test_hunt', 'Find which retry tests fail intermittently and why.')
  spawn('cache_probe', 'Measure cache hit rate of the retry lookup table.', 'agent thread limit reached (2 running, limit 2)')
  spawn('docs_sweep', 'List docs pages that mention the old retry attempts default.')
  const pr41 = script([
    'const push = await tools.exec_command({ cmd: "git push -u origin feat/retry-budget" })',
    'const pr = await tools.exec_command({ cmd: "gh pr create --title \\"feat(retry): cap attempts per budget\\" --body-file .github/pr-retry.md" })',
    'await tools.update_plan({ plan: [{ step: "Open the retry pull request", status: "completed" }] })',
    'text(push.output + pr.output)',
  ].join('\n'), `branch 'feat/retry-budget' set up to track 'origin/feat/retry-budget'.\n${prUrl(41)}\n`)
  prs.set(41, { created_at: pr41.at })
  const pr42 = exec('gh pr create --title "feat(retry-cli): expose the budget flag" --fill', 0, `${prUrl(42)}\n`)
  prs.set(42, { created_at: pr42.at })
  exec('pnpm dev --filter orbit-web', { running: 51200 }, 'ready on http://localhost:5173\n')
  // The create command's own output has no URL; only a later poll of its process does.
  const pr43 = exec('gh pr create --title "docs(retry): budget guide" --fill', { running: 73012 }, `Creating pull request for docs/retry-guide into main in ${REPO}\n`)
  prs.set(43, { created_at: pr43.at })
  writeStdin(51200, { running: 51200 }, 'hmr update /src/app.tsx\n')
  exec('gh pr list --state open', 0, '40\tchore: bump dependencies\tdeps/bump\tOPEN\n41\tfeat(retry): cap attempts per budget\tfeat/retry-budget\tOPEN\n42\tfeat(retry-cli): expose the budget flag\tfeat/retry-cli\tOPEN\n')
  exec('gh pr merge 41 --squash', 1, `X Pull request ${REPO}#41 is not mergeable: required status checks have not passed\n`)
  endTurn('PR 41 is not mergeable yet; its checks are still running.')

  // Turn 2: merge 41 properly, link 43, launch runs.
  startTurn()
  human("no, don't merge before the checks finish. wait for them next time.", true)
  w.message('assistant', 'Understood. Waiting for the checks on 41 before merging.')
  exec('gh pr checks 41 --watch', 0, 'All checks were successful\n')
  exec('gh pr view 41 --json reviews', 0, '{"reviews":[]}\n')
  const merged41 = exec('gh pr merge 41 --squash --delete-branch', 0, `Squashed and merged pull request ${REPO}#41 (feat(retry): cap attempts per budget)\nDeleted branch feat/retry-budget\n`)
  prs.set(41, { ...prs.get(41)!, merged_at: merged41.at, reviewed_before_merge: false })
  writeStdin(73012, 0, `${prUrl(43)}\n`)
  launch('alpha-sweep', '', 0, 'started run a-01 (spec alpha-sweep)\n', 'a-01')
  launch('alpha-sweep', '', 0, 'started run a-02 (spec alpha-sweep)\n', 'a-02')
  launch('beta-probe', ' --variant v1', 0, 'started run b-01 (spec beta-probe, variant v1)\n', 'b-01')
  runs.betaVariants.add('v1')
  launch('beta-probe', ' --variant v2', 0, 'started run b-02 (spec beta-probe, variant v2)\n', 'b-02')
  runs.betaVariants.add('v2')
  launch('gamma-grid', '', 1, 'error: config gamma-grid.yaml: missing required field seed\n')
  patch('*** Begin Patch\n*** Add File: docs/runs.md\n+# Sweep runs\n+\n+Start a sweep with `labctl run alpha-sweep` and stop one with `labctl cancel <run>`.\n*** End Patch', ['docs/runs.md'])
  launch('gamma-grid', ' --seed 7', 0, 'started run g-01 (spec gamma-grid)\n', 'g-01')
  spawn('alpha_monitor', 'Watch run a-01 and report when its loss stops improving.')
  spawn('beta_monitor', 'Watch the beta-probe runs and compare their variants.')
  spawn('gamma_monitor', 'Watch run g-01 and report any failed step.')
  spawn('seed_review', 'Check whether gamma-grid seeds collide across shards.')
  spawn('config_review', 'Compare the three sweep configs for unintended differences.')
  w.message('user', '<subagent_notification>\n{"agent_path":"/root/schema_audit","status":"completed"}\n</subagent_notification>')
  poll(90)
  endTurn('Runs a-01, a-02, b-01, b-02 and g-01 are running; PR 43 is open.')

  // Turn 3: status question, two scripted launches, more helpers.
  startTurn()
  human("what's the status of the alpha sweep?")
  exec('labctl list', 0, 'a-01  alpha-sweep  running\na-02  alpha-sweep  running\nb-01  beta-probe/v1  running\nb-02  beta-probe/v2  running\ng-01  gamma-grid  running\n')
  poll(60)
  script([
    'for (const variant of ["v3", "v4"]) {',
    '  const run = await tools.exec_command({ cmd: `labctl run beta-probe --variant ${variant}` })',
    '  text(run.output)',
    '}',
  ].join('\n'), 'started run b-03 (spec beta-probe, variant v3)\nstarted run b-04 (spec beta-probe, variant v4)\n')
  runs.launched += 2
  runs.specs.add('beta-probe')
  runs.betaVariants.add('v3')
  runs.betaVariants.add('v4')
  launchedIds.push('b-03', 'b-04')
  launch('alpha-sweep', '', 0, 'started run a-03 (spec alpha-sweep)\n', 'a-03')
  spawn('cache_probe', 'Measure cache hit rate of the retry lookup table.')
  spawn('log_digest', 'Summarize the error lines from every running sweep.')
  spawn('pr_watch', 'Watch pull requests 42 and 43 and report check results.')
  poll(60)
  endTurn('Alpha runs a-01, a-02 and a-03 are running; a-01 is at step 31 of 40.')

  // Turn 4: cancels, merge 42, the local graph runner.
  startTurn()
  human('stop launching new runs. cancel the stale alpha runs first.', true)
  exec('labctl cancel a-01', 0, 'cancelled a-01\n')
  exec('labctl cancel a-2', 2, 'error: no such run: a-2\n')
  exec('labctl cancel a-02', 0, 'cancelled a-02\n')
  exec('labctl cancel a-03', 0, 'cancelled a-03\n')
  runs.cancelled += 3
  launchedIds.splice(0, launchedIds.length, ...launchedIds.filter((id) => !id.startsWith('a-')))
  exec('labctl status b-1', 2, 'error: no such run: b-1\n')
  poll(45)
  exec('gh pr view 42 --json reviews', 0, '{"reviews":[{"author":{"login":"review-bot"},"state":"APPROVED"}]}\n')
  // The merge command backgrounds itself; only a later poll of its process shows that it succeeded.
  const merged42 = exec('gh pr merge 42 --squash --delete-branch', { running: 66401 }, `Merging pull request ${REPO}#42 (feat(retry-cli): expose the budget flag)\n`)
  prs.set(42, { ...prs.get(42)!, merged_at: merged42.at, reviewed_before_merge: true })
  spawn('budget_review', 'Review the budget arithmetic for off-by-one errors.')
  spawn('api_diff', 'Diff the public retry API before and after the change.')
  script([
    'const patch = await tools.apply_patch(`*** Begin Patch',
    '*** Add File: tools/mini-graph.mjs',
    '+// Runs the sweep graph locally: topological order and per-node retries.',
    '+export async function runLocalGraph(nodes, run) {',
    '+  const done = new Set()',
    '+  for (const node of nodes) {',
    '+    for (const dep of node.after ?? []) if (!done.has(dep)) throw new Error(`unmet ${dep}`)',
    '+    await run(node)',
    '+    done.add(node.id)',
    '+  }',
    '+}',
    '*** End Patch`)',
    'const check = await tools.exec_command({ cmd: "node tools/mini-graph.mjs --check" })',
    'text(patch.output + check.output)',
  ].join('\n'), 'Success. Updated the following files:\nA tools/mini-graph.mjs\ngraph ok: 4 nodes\n')
  changedPaths.add('tools/mini-graph.mjs')
  exec('labctl status b-1', 2, 'error: no such run: b-1\n')
  poll(45)
  endTurn('Cancelled a-01, a-02 and a-03, merged PR 42, and added a local graph runner for the sweep.')

  // Turn 5: correction, scripted patch, merge 43 inside a verification script, the large log.
  startTurn()
  human("that's not what I asked for. keep the change inside the retry package.", true)
  writeStdin(66401, 0, `Squashed and merged pull request ${REPO}#42 (feat(retry-cli): expose the budget flag)\nDeleted branch feat/retry-cli\n`)
  script([
    'await tools.apply_patch(`*** Begin Patch',
    '*** Update File: packages/retry/src/budget.ts',
    '@@',
    '-export const DEFAULT_ATTEMPTS = 4',
    '+export const DEFAULT_ATTEMPTS = 3',
    '*** Delete File: packages/retry/src/legacy.ts',
    '*** End Patch`)',
    'const test = await tools.exec_command({ cmd: "pnpm test --filter @acme/retry" })',
    'text(test.output)',
  ].join('\n'), 'Test Files 6 passed (6)\n')
  changedPaths.add('packages/retry/src/budget.ts')
  changedPaths.add('packages/retry/src/legacy.ts')
  patch('*** Begin Patch\n*** Add File: packages/retry/test/budget.test.ts\n+import { withinBudget } from \'../src/budget\'\n+\n+test(\'caps attempts\', () => expect(withinBudget(3, { max: 3 })).toBe(false))\n*** Update File: packages/retry/src/index.ts\n@@\n+export { withinBudget } from \'./budget\'\n*** End Patch', ['packages/retry/test/budget.test.ts', 'packages/retry/src/index.ts'])
  spawn('bench_compare', 'Compare retry latency before and after the budget change.')
  spawn('release_notes', 'Draft release notes for the retry budget change.')
  poll(80)
  exec('gh pr view 43 --json reviews', 0, '{"reviews":[]}\n')
  // A single nested tool plus a checks command gives this script span a verification name.
  const merged43 = script([
    'const checks = await tools.exec_command({ cmd: "gh pr checks 43 --watch" })',
    'const merge = await tools.exec_command({ cmd: "gh pr merge 43 --squash" })',
    'text(checks.output + merge.output)',
  ].join('\n'), `All checks were successful\nSquashed and merged pull request ${REPO}#43 (docs(retry): budget guide)\n`)
  prs.set(43, { ...prs.get(43)!, merged_at: merged43.at, reviewed_before_merge: false })
  const logLines: string[] = []
  const logStart = clock.now - 3_600_000
  for (let step = 1; logLines.join('\n').length < 24 * 1024; step += 1) {
    const at = new Date(logStart + step * 7_000).toISOString()
    logLines.push(`${at} g-01 step=${(step % 40) + 1} shard=${step % 4} loss=${(2 + random()).toFixed(4)} seed=7`)
  }
  const lastLogLine = 'g-01 finished: status=failed step=40 reason=seed collision on shard 3'
  logLines.push(lastLogLine)
  const logOutputLine = exec('labctl logs g-01', 0, `${logLines.join('\n')}\n`).output.line
  endTurn('PR 43 is merged. Run g-01 failed at step 40.')

  // Turns 6 to 8: praise, a substantive question, then a short follow-up.
  startTurn()
  human('thanks, that looks right')
  poll(60)
  endTurn('Thanks. The beta-probe runs are still going.')
  startTurn()
  human('why does the gamma grid keep failing at step 40? is it the seed or the config?')
  poll(50)
  endTurn('Looking at the g-01 log now.')
  startTurn()
  human('ya?')
  poll(STATUS_POLLS - statusPolls)
  endTurn('The g-01 log ends with a seed collision on shard 3, so it is the seed, not the config.')
  tokenCount()
  // Codex writes a repeated token count with an unchanged cumulative total; summing deltas would double it.
  w.row('event_msg', lastTokenEvent!)
  w.message('user', '<subagent_notification>\n{"agent_path":"/root/release_notes","status":"completed"}\n</subagent_notification>')
  const last = w.message('user', '<environment_context>\n  <cwd>/work/orbit/packages/retry</cwd>\n</environment_context>')

  if (!child) throw new Error('operator plan did not spawn the forked child')
  const last2 = humans.at(-2)!
  const lastHuman = humans.at(-1)!
  const gold: GoldAnswers = {
    'op.subagents': {
      spawn_calls: spawns.length,
      failed_spawns: spawns.filter((item) => item.failed).length,
      task_names: [...new Set(spawns.filter((item) => !item.failed).map((item) => item.name))].sort(),
    },
    'op.pull-requests': {
      prs: [...prs.entries()].sort(([a], [b]) => a - b).map(([number, pr]) => ({ number, ...pr })),
    },
    'op.runs': {
      launched: runs.launched,
      failed_launches: runs.failed,
      cancelled: runs.cancelled,
      specs: [...runs.specs].sort(),
      beta_probe_variants: [...runs.betaVariants].sort(),
    },
    'op.last-human-turn': {
      last: quote(file, lastHuman, lastHuman.text),
      last_at: lastHuman.at,
      previous: quote(file, last2, last2.text),
    },
    'op.role': {
      role: 'operator',
      merged_prs: [...prs.values()].filter((pr) => pr.merged_at).length,
      launched_runs: runs.launched,
      spawn_calls: spawns.length,
    },
    'op.local-copy': { path: 'tools/mini-graph.mjs' },
    'op.corrections': { corrections: corrections.map((item) => quote(file, item, item.text)) },
    'op.time-bounds': { first_record_at: first.at, last_record_at: last.at },
    'op.exit-codes': { nonzero_exec_commands: exits.length, codes: [...new Set(exits)].sort((a, b) => a - b) },
    'op.changed-files': { paths: [...changedPaths].sort() },
    'op.status-polls': { status_commands: statusPolls },
    'op.large-output': { last_line: quote(file, { line: logOutputLine, at: '' }, lastLogLine) },
    'op.tokens': {
      input_tokens: cumulative.input_tokens,
      cached_input_tokens: cumulative.cached_input_tokens,
      output_tokens: cumulative.output_tokens,
    },
  }
  return { file, sessionId, rows: w.out.rows, first, last, child, gold }
}

function childSession(random: Random, parent: OperatorPlan): { file: string; content: string; gold: GoldAnswers } {
  const { sessionId, agentPath, forkRows, spawnAtMs } = parent.child
  const clock = new Clock(spawnAtMs + 1_000, random)
  const w = new CodexWriter(clock, random)
  const file = `codex/sessions/2026/03/14/rollout-${new Date(spawnAtMs + 1_000).toISOString().slice(0, 19).replaceAll(':', '-')}-${sessionId}.jsonl`
  const forkAt = new Date(spawnAtMs + 1_000).toISOString()
  w.row('session_meta', {
    id: sessionId,
    timestamp: forkAt,
    cwd: OPERATOR_CWD,
    originator: 'codex_cli_rs',
    cli_version: '0.150.0',
    parent_thread_id: parent.sessionId,
    thread_source: 'subagent',
    agent_nickname: 'Agent-flak',
    agent_path: agentPath,
    source: { subagent: { thread_spawn: { parent_thread_id: parent.sessionId, depth: 1, agent_path: agentPath, agent_nickname: 'Agent-flak' } } },
  }, forkAt)
  // Inherited history keeps its content but carries the fork time, as Codex rewrites it.
  for (const row of forkRows) {
    const parsed = JSON.parse(row) as Record<string, unknown>
    w.out.push({ ...parsed, timestamp: forkAt })
  }
  const startedAt = clock.next()
  const started = w.row('event_msg', { type: 'task_started', turn_id: sessionId, started_at: Math.floor(Date.parse(startedAt) / 1_000), model_context_window: 272_000 }, startedAt)
  w.row('turn_context', { cwd: OPERATOR_CWD, approval_policy: 'never', sandbox_policy: { mode: 'workspace-write' }, model: CODEX_MODEL })
  w.message('user', 'Find which retry tests fail intermittently and why.')
  let ownTools = 0
  let failed = 0
  const exec = (cmd: string, exit: number, body: string): void => {
    const call = w.call('exec_command', { cmd, workdir: OPERATOR_CWD, yield_time_ms: 10_000 })
    w.output(call, shellOutput(random, exit, body))
    ownTools += 1
    if (exit !== 0) failed += 1
  }
  exec('pnpm vitest run packages/retry --reporter dot', 1, 'FAIL packages/retry/test/jitter.test.ts > spreads retries\n  expected 120 to be less than 100\n')
  exec('pnpm vitest run packages/retry -t "spreads retries" --repeat 20', 0, '20 passed, 0 failed\n')
  exec('git log -3 --oneline -- packages/retry', 0, '9f1c2ab feat(retry): add jitter\n4d0e7aa test(retry): cover jitter bounds\n')
  const patchText = '*** Begin Patch\n*** Update File: packages/retry/test/jitter.test.ts\n@@\n-  const random = Math.random\n+  const random = seeded(42)\n*** End Patch'
  const patchCall = w.custom('apply_patch', patchText)
  w.output(patchCall, JSON.stringify({ output: patchSummary(patchText), metadata: { exit_code: 0, duration_seconds: 0.1 } }))
  ownTools += 1
  exec('pnpm vitest run packages/retry', 0, 'Test Files 7 passed (7)\n')
  const send = w.call('send_message', { target: parent.sessionId, message: 'jitter.test.ts used an unseeded random source; seeded it with 42.' })
  w.output(send, JSON.stringify({ delivered: true }))
  ownTools += 1
  w.message('assistant', 'The flaky test was jitter.test.ts: it used an unseeded random source. It now uses a seeded one.')
  w.row('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 18_000, cached_input_tokens: 15_000, output_tokens: 900, reasoning_output_tokens: 300, total_tokens: 18_900 }, total_token_usage: { input_tokens: 18_000, cached_input_tokens: 15_000, output_tokens: 900, reasoning_output_tokens: 300, total_tokens: 18_900 }, model_context_window: 272_000 } })
  w.row('event_msg', { type: 'task_complete', turn_id: sessionId, last_agent_message: 'Seeded the jitter test.' })
  return {
    file,
    content: w.out.text(),
    gold: {
      'child.lineage': { parent_session_id: parent.sessionId, agent_path: agentPath },
      'child.own-work': { task_started_at: started.at, own_tool_calls: ownTools, failed_commands: failed },
      'child.spawned': { spawned_session_ids: [] },
    },
  }
}

interface ClaudeTool {
  name: string
  input: Record<string, unknown>
  result: string | Array<{ type: 'text'; text: string }>
  isError?: boolean
}

class ClaudeWriter {
  readonly out = new Jsonl()
  private parent: string | null = null

  constructor(
    private readonly clock: Clock,
    private readonly random: Random,
    private readonly sessionId: string,
    private readonly sidechain: { agentId: string } | undefined,
  ) {}

  private base(type: 'user' | 'assistant', at: string): Record<string, unknown> {
    const uuid = uuidV4(this.random)
    const row = {
      parentUuid: this.parent,
      isSidechain: this.sidechain !== undefined,
      userType: 'external',
      cwd: CLAUDE_CWD,
      sessionId: this.sessionId,
      version: '2.1.0',
      ...(this.sidechain ? { agentId: this.sidechain.agentId } : {}),
      type,
      uuid,
      timestamp: at,
    }
    this.parent = uuid
    return row
  }

  user(content: string): Placed {
    const at = this.clock.next()
    return { line: this.out.push({ ...this.base('user', at), message: { role: 'user', content } }), at }
  }

  assistant(text: string | null, tools: Array<{ id: string; name: string; input: Record<string, unknown> }> = []): Placed {
    const at = this.clock.next()
    const content = [
      ...(text ? [{ type: 'text', text }] : []),
      ...tools.map((tool) => ({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input })),
    ]
    return {
      line: this.out.push({
        ...this.base('assistant', at),
        message: {
          id: `msg_${base62(this.random, 24)}`,
          type: 'message',
          role: 'assistant',
          model: CLAUDE_MODEL,
          content,
          usage: { input_tokens: 40 + Math.floor(this.random() * 200), cache_read_input_tokens: 12_000, output_tokens: 80 + Math.floor(this.random() * 400) },
        },
        requestId: `req_${base62(this.random, 24)}`,
      }),
      at,
    }
  }

  results(items: Array<{ id: string; tool: ClaudeTool }>): Placed {
    const at = this.clock.next()
    return {
      line: this.out.push({
        ...this.base('user', at),
        message: {
          role: 'user',
          content: items.map(({ id, tool }) => ({
            tool_use_id: id,
            type: 'tool_result',
            content: tool.result,
            ...(tool.isError ? { is_error: true } : {}),
          })),
        },
      }),
      at,
    }
  }

  /** One assistant tool call followed by its result record. */
  tool(tool: ClaudeTool, text: string | null = null): Placed {
    const id = `toolu_${base62(this.random, 24)}`
    this.assistant(text, [{ id, name: tool.name, input: tool.input }])
    return this.results([{ id, tool }])
  }
}

function claudeSession(random: Random): { files: BenchFile[]; session: BenchSession; gold: GoldAnswers } {
  const clock = new Clock(CLAUDE_START_MS, random)
  const sessionId = uuidV4(random)
  const dir = 'claude/projects/-work-ledger'
  const file = `${dir}/${sessionId}.jsonl`
  const w = new ClaudeWriter(clock, random, sessionId, undefined)
  let bashCalls = 0
  let bashErrors = 0
  let subagentBashErrors = 0
  const bash = (writer: ClaudeWriter, command: string, result: string, isError = false, inSubagent = false): Placed => {
    bashCalls += 1
    if (isError) {
      bashErrors += 1
      if (inSubagent) subagentBashErrors += 1
    }
    return writer.tool({ name: 'Bash', input: { command, description: `Run ${command.split(' ')[0]}` }, result, isError })
  }

  w.user('The nightly import job fails on the March CSV. Find the cause and fix it.')
  const firstErrorText = 'Exit code 1\nFAIL src/import.test.ts > parses the March file\nRangeError: Invalid time value'
  const firstError = bash(w, 'pnpm test --filter import', firstErrorText, true)
  bash(w, 'git log --oneline -5 -- src/import', 'a1b2c3d fix(import): trim byte order mark\n7e8f9a0 feat(import): stream rows')
  w.tool({ name: 'Read', input: { file_path: '/work/ledger/src/dates.ts' }, result: 'File does not exist.', isError: true })

  const tasks = [
    { description: 'Map the import pipeline', subagent_type: 'Explore', prompt: 'List every module the nightly import passes a row through, in order.' },
    { description: 'Reproduce the date failure', subagent_type: 'general-purpose', prompt: 'Reproduce the RangeError with the smallest CSV row you can find.' },
    { description: 'Survey date parsing', subagent_type: 'Explore', prompt: 'Find every place in src/ that parses a date string.' },
  ]
  const taskIds = tasks.map(() => `toolu_${base62(random, 24)}`)
  w.assistant('Splitting the investigation across three subagents.', tasks.map((input, index) => ({ id: taskIds[index]!, name: 'Task', input })))

  const subagentFiles: BenchFile[] = []
  const summaries: string[] = []
  const subagentScripts: Array<Array<{ command: string; result: string; isError?: boolean }>> = [
    [
      { command: 'rg -l "importRow" src', result: 'src/import.ts\nsrc/rows.ts\nsrc/parse-date.ts' },
      { command: 'sed -n 1,40p src/import.ts', result: 'export async function importFile(path) {\n  for await (const row of rows(path)) await importRow(row)\n}' },
    ],
    [
      { command: 'node scripts/import-one.mjs fixtures/march.csv', result: 'Exit code 1\nRangeError: Invalid time value at parseDate (src/parse-date.ts:18)', isError: true },
      { command: 'grep -n "2026-02-30" fixtures/march.csv', result: '412:2026-02-30,ACME,12.00' },
    ],
    [
      { command: 'rg -n "new Date\\(" src', result: 'src/parse-date.ts:18:  return new Date(value).toISOString()' },
    ],
  ]
  let subagentsDoneAt = clock.now
  for (const [index, task] of tasks.entries()) {
    const agentId = hex(random, 17)
    const subClock = new Clock(clock.now + index * 1_500, random)
    const sub = new ClaudeWriter(subClock, random, sessionId, { agentId })
    sub.user(task.prompt)
    for (const step of subagentScripts[index]!) bash(sub, step.command, step.result, step.isError ?? false, true)
    const summary = [
      'The row path is importFile, then rows, then importRow, then parseDate.',
      'Row 412 of fixtures/march.csv holds the impossible date 2026-02-30, and parseDate throws on it.',
      'Only src/parse-date.ts parses date strings, at line 18.',
    ][index]!
    sub.assistant(summary)
    subagentsDoneAt = Math.max(subagentsDoneAt, subClock.now)
    summaries.push(summary)
    const subPath = `${dir}/${sessionId}/subagents/agent-${agentId}.jsonl`
    subagentFiles.push({ path: subPath, content: sub.out.text() })
    subagentFiles.push({ path: subPath.replace(/\.jsonl$/, '.meta.json'), content: `${JSON.stringify({ agentType: task.subagent_type, toolUseId: taskIds[index] })}\n` })
  }
  // The Task results arrive after every child has finished.
  clock.passAt(subagentsDoneAt)
  w.results(tasks.map((_, index) => ({ id: taskIds[index]!, tool: { name: 'Task', input: {}, result: [{ type: 'text', text: summaries[index]! }] } })))
  bash(w, 'pnpm test --filter import -- -t "March"', 'Exit code 1\nFAIL src/import.test.ts > rejects 2026-02-30\nexpected parseDate to return null', true)
  w.tool({ name: 'Edit', input: { file_path: '/work/ledger/src/parse-date.ts', old_string: 'return new Date(value).toISOString()', new_string: 'const date = new Date(value)\n  return Number.isNaN(date.getTime()) ? null : date.toISOString()' }, result: 'The file has been updated.' })
  bash(w, 'pnpm test --filter import', 'Test Files 4 passed (4)')
  w.assistant('Fixed: parseDate now returns null for impossible dates such as 2026-02-30 instead of throwing.')

  return {
    files: [{ path: file, content: w.out.text() }, ...subagentFiles],
    session: { id: 'claude', harness: 'claude-code', path: file, sessionId },
    gold: {
      'claude.tasks': {
        task_calls: tasks.length,
        subagent_types: [...new Set(tasks.map((task) => task.subagent_type))].sort(),
        descriptions: tasks.map((task) => task.description).sort(),
      },
      'claude.bash': { bash_calls: bashCalls, failed_bash_calls: bashErrors, failed_in_subagents: subagentBashErrors },
      'claude.first-bash-error': { output: quote(file, firstError, firstErrorText) },
    },
  }
}

/** Build every fixture file and its gold in memory. The same seed always yields the same bytes. */
export function generateBench(): GeneratedBench {
  const random = mulberry32(SEED)
  const operator = operatorSession(random)
  const child = childSession(random, operator)
  const claude = claudeSession(random)
  const files: BenchFile[] = [
    { path: operator.file, content: `${operator.rows.join('\n')}\n` },
    { path: child.file, content: child.content },
    ...claude.files,
    // Code-unit order, the order `manifest.files` is asserted in and the order a
    // plain `sort()` gives, rather than a locale-dependent collation.
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const basenames = new Set(files.map((item) => item.path.split('/').at(-1)))
  if (basenames.size !== files.length) throw new Error('fixture file basenames must be unique so line citations resolve')
  return {
    manifest: {
      version: 1,
      sessions: [
        { id: 'codex-operator', harness: 'codex', path: operator.file, sessionId: operator.sessionId },
        { id: 'codex-child', harness: 'codex', path: child.file, sessionId: operator.child.sessionId },
        claude.session,
      ],
      files: files.map((item) => item.path),
    },
    files,
    gold: { ...operator.gold, ...child.gold, ...claude.gold },
  }
}

/** Write the fixture tree under `root`. Arms read only this tree, never the gold. */
export async function writeFixtures(root: string, bench: GeneratedBench = generateBench()): Promise<GeneratedBench> {
  for (const item of bench.files) {
    const path = join(root, item.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, item.content)
  }
  return bench
}
