/**
 * The pull requests a session created and merged, read from the command spans.
 *
 * The measured gap this closes: on a private battery of thirteen Codex
 * sessions the free facts sheet answered "which pull requests did the agent
 * create, and which did it merge?" with nothing at all, scoring 0.31 against a
 * subagent fleet's 0.97 — while every command, exit code and printed
 * pull-request URL was already in the spans.
 *
 * Every rollout below is written here by hand. None comes from a recorded
 * session, and the URLs point at `example.test`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/adapters/codex.js'
import { computeSessionFacts, type SessionFacts } from '../src/session-facts.js'
import {
  at,
  command,
  commandItem,
  ms,
  type Row,
  script,
  scriptOutput,
  task,
  userItem,
  writeRollout as writeRolloutIn,
} from './codex-facts-fixture.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-facts-prs-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const writeRollout = (name: string, rows: readonly Row[]) => writeRolloutIn(dir, name, rows)

/** A model-issued `exec_command` call and the output it got back. */
const execCall = (t: number, callId: string, cmd: string): Row => ({
  t,
  type: 'response_item',
  payload: { type: 'function_call', call_id: callId, name: 'exec_command', arguments: JSON.stringify({ cmd }) },
})
const execOutput = (t: number, callId: string, output: string): Row => ({
  t,
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ exit_code: 0, output }) },
})

async function factsFor(name: string, rows: readonly Row[]): Promise<SessionFacts> {
  const spans = await new CodexAdapter().parse(writeRollout(name, rows))
  const [facts, ...rest] = computeSessionFacts(spans)
  expect(rest).toEqual([])
  return facts!
}

const ids = (entries: readonly { identifier: string | null }[]) => entries.map((entry) => entry.identifier)

const HEREDOC_NOTE = [
  "cat > /tmp/pr-note.md <<'EOF'",
  'Reviewers: run gh pr create --head feat/never-ran when the branch is ready,',
  'then gh-drew pr merge 999 --squash.',
  'EOF',
].join('\n')

/**
 * One shipping turn: a script that pushes and opens a PR, a second create
 * through the `gh-drew` wrapper, a create whose stdout was redirected away, a
 * heredoc that only talks about `gh pr create`, and a later `gh pr list` whose
 * output is the first place the redirected PR's number appears.
 */
const SHIP_SCRIPT = [
  'const first = await tools.exec_command({ cmd: "git push -u origin feat/parser && gh pr create --base main --fill" })',
  'const second = await tools.exec_command({ cmd: "gh-drew pr create --head feat/docs --base main --fill" })',
  'const third = await tools.exec_command({ cmd: "gh pr create --head feat/quiet --base main --fill > /tmp/pr.txt" })',
  'const note = await tools.exec_command({ cmd: "cat > /tmp/pr-note.md" })',
  'text([first.output, second.output, third.output, note.output].join("\\n"))',
].join('\n')

function shipRollout(): Row[] {
  return [
    { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
    { t: 0.5, type: 'turn_context', payload: { cwd: '/workspace/demo', model: 'gpt-fixture' } },
    task(1, 'task_started', 'turn-1'),
    userItem(2, [{ type: 'input_text', text: 'ship the parser fix and the docs branch' }]),
    script(3, 'call-ship', SHIP_SCRIPT),
    command(
      4,
      commandItem(
        'item-push-create',
        '51001',
        'git push -u origin feat/parser && gh pr create --base main --fill',
        0,
        "branch 'feat/parser' set up to track 'origin/feat/parser'.\nhttps://example.test/acme/demo/pull/41\n",
      ),
      { start: 3.1, end: 4 },
    ),
    command(
      5,
      commandItem('item-drew', '51002', 'gh-drew pr create --head feat/docs --base main --fill', 0, 'https://example.test/acme/demo/pull/42\n'),
      { start: 4.1, end: 5 },
    ),
    command(
      6,
      commandItem('item-quiet', '51003', 'gh pr create --head feat/quiet --base main --fill > /tmp/pr.txt', 0, ''),
      { start: 5.1, end: 6 },
    ),
    command(7, commandItem('item-note', '51004', HEREDOC_NOTE, 0, ''), { start: 6.1, end: 7 }),
    scriptOutput(8, 'call-ship', 'Script completed\nWall time 4.0 seconds\nOutput:\nok'),
    // The only record that ties feat/quiet to a number.
    execCall(9, 'call-list', 'gh pr list --state open'),
    command(
      10,
      commandItem(
        'item-list',
        '51005',
        'gh pr list --state open',
        0,
        'feat/parser  https://example.test/acme/demo/pull/41  OPEN\nfeat/quiet  https://example.test/acme/demo/pull/43  OPEN\n',
      ),
      { start: 9.1, end: 10 },
    ),
    execOutput(11, 'call-list', 'feat/quiet https://example.test/acme/demo/pull/43 OPEN'),
    // A verification call: the adapter names it `exec_command.verify`, and the
    // merge lives inside the script that call ran.
    execCall(12, 'call-verify', 'gh-drew pr checks 41 && gh-drew pr merge 41 --squash --match-head-commit deadbeef'),
    command(
      13,
      commandItem(
        'item-verify',
        '51006',
        'gh-drew pr checks 41 && gh-drew pr merge 41 --squash --match-head-commit deadbeef',
        0,
        'All checks were successful\nSquashed and merged pull request demo#41\n',
      ),
      { start: 12.1, end: 13 },
    ),
    execOutput(14, 'call-verify', 'Squashed and merged pull request demo#41'),
    task(15, 'task_complete', 'turn-1'),
  ]
}

describe('session facts: pull requests', () => {
  it('names every pull request the commands created, however the number reached the spans', async () => {
    const facts = await factsFor('ship', shipRollout())
    const created = facts.pullRequests.value!.created
    expect(ids(created)).toEqual(['41', '42', '43'])

    const [pushed, wrapper, redirected] = created
    // The command printed the URL itself.
    expect(pushed).toMatchObject({ number: '41', headBranch: 'feat/parser' })
    expect(pushed!.evidence).toContain('printed')
    // The head branch came from the `git push` in the same script, not a flag.
    expect(pushed!.command).toContain('gh pr create --base main --fill')

    // The `gh-drew` wrapper is the same command.
    expect(wrapper).toMatchObject({ number: '42', headBranch: 'feat/docs' })
    expect(wrapper!.command.startsWith('gh-drew pr create')).toBe(true)

    // stdout went to a file; the number only appears in a later command's output.
    expect(redirected).toMatchObject({ number: '43', headBranch: 'feat/quiet' })
    expect(redirected!.evidence).toContain('a later output states for this branch')
    expect(redirected!.spanIds.length).toBeGreaterThan(1)
  })

  it('reads a merge that ran inside a verification script', async () => {
    const spans = await new CodexAdapter().parse(writeRollout('ship-merge', shipRollout()))
    const verify = spans.find((span) => span.attributes['tool.name'] === 'exec_command.verify')
    expect(verify).toBeDefined()

    const [facts] = computeSessionFacts(spans)
    expect(ids(facts!.pullRequests.value!.merged)).toEqual(['41'])
    expect(facts!.pullRequests.value!.merged[0]!.evidence).toContain('the pull request the command names')
  })

  it('does not count a gh command that only appears inside a heredoc body', async () => {
    const facts = await factsFor('heredoc', shipRollout())
    const everything = [...facts.pullRequests.value!.created, ...facts.pullRequests.value!.merged]
    expect(everything.map((entry) => entry.identifier)).not.toContain('feat/never-ran')
    expect(everything.map((entry) => entry.identifier)).not.toContain('999')
  })

  it('cites a real span for every pull request it names', async () => {
    const spans = await new CodexAdapter().parse(writeRollout('cites', shipRollout()))
    const known = new Set(spans.map((span) => span.span_id))
    const [facts] = computeSessionFacts(spans)
    const cited = [...facts!.pullRequests.value!.created, ...facts!.pullRequests.value!.merged]
      .flatMap((entry) => entry.spanIds)
    expect(cited.length).toBeGreaterThan(0)
    for (const spanId of cited) expect(known.has(spanId)).toBe(true)
    expect(facts!.pullRequests.spanIds).toEqual(expect.arrayContaining(cited))
  })

  it('leaves a create the shell never reached out of the list', async () => {
    const facts = await factsFor('unreached', [
      { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
      task(1, 'task_started', 'turn-1'),
      userItem(2, [{ type: 'input_text', text: 'push and open the PR' }]),
      execCall(3, 'call-fail', 'git push -u origin feat/broken && gh pr create --fill'),
      command(
        4,
        commandItem(
          'item-fail',
          '52001',
          'git push -u origin feat/broken && gh pr create --fill',
          1,
          "error: failed to push some refs to 'origin'\n",
        ),
        { start: 3.1, end: 4 },
      ),
      task(5, 'task_complete', 'turn-1'),
    ])
    expect(facts.pullRequests.value).toEqual({ created: [], merged: [] })
    expect(facts.pullRequests.unavailable).toBeNull()
  })

  it('counts one pull request when a failed create is retried on the same branch', async () => {
    const facts = await factsFor('retry', [
      { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
      task(1, 'task_started', 'turn-1'),
      userItem(2, [{ type: 'input_text', text: 'open it' }]),
      execCall(3, 'call-a', 'gh pr create --head feat/retry --base main --fill'),
      command(
        4,
        commandItem(
          'item-a',
          '53001',
          'gh pr create --head feat/retry --base main --fill',
          1,
          'pull request create failed: GraphQL: No commits between main and feat/retry\n',
        ),
        { start: 3.1, end: 4 },
      ),
      execCall(5, 'call-b', 'gh pr create --head feat/retry --base main --fill'),
      command(
        6,
        commandItem('item-b', '53002', 'gh pr create --head feat/retry --base main --fill', 0, 'https://example.test/acme/demo/pull/44\n'),
        { start: 5.1, end: 6 },
      ),
      task(7, 'task_complete', 'turn-1'),
    ])
    expect(ids(facts.pullRequests.value!.created)).toEqual(['44'])
  })

  it('says the spans cannot answer when none of them carries a command', async () => {
    const facts = await factsFor('no-commands', [
      { t: 0, type: 'session_meta', payload: { id: 'facts-session', cwd: '/workspace/demo' } },
      task(1, 'task_started', 'turn-1'),
      userItem(2, [{ type: 'input_text', text: 'did you open the PR?' }]),
      {
        t: 3,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I opened PR 91.' }] },
      },
      task(4, 'task_complete', 'turn-1'),
    ])
    // Zero pull requests and "the spans cannot say" are different answers, and
    // an audit that reports the first for the second is stating a fact it has not read.
    expect(facts.pullRequests.value).toBeNull()
    expect(facts.pullRequests.unavailable).toContain('no span in this trace carries an executed command')
    expect(facts.pullRequests.spanIds).toEqual([])
  })

  it('keeps its start and end times inside the fixture window', async () => {
    const facts = await factsFor('window', shipRollout())
    expect(facts.firstRecordAt.value).toBe(at(0))
    expect(Date.parse(facts.lastRecordAt.value!)).toBeLessThanOrEqual(ms(20))
  })
})
