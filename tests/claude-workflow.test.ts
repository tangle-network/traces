import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import type { OtlpSpan } from '../src/otlp.js'
import type { SessionRef } from '../src/types.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-claude-workflow-'))
const outsideDir = mkdtempSync(join(tmpdir(), 'traces-claude-workflow-outside-'))
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outsideDir, { recursive: true, force: true })
})

function refFor(path: string): SessionRef {
  return { harness: 'claude-code', sessionId: 'fixture', path, cwd: null, mtimeMs: 0 }
}

function contents(spans: readonly OtlpSpan[]): string[] {
  return spans.flatMap((item) =>
    typeof item.attributes.content === 'string' ? [item.attributes.content] : [])
}

function workflowEvents(input: {
  turn: string
  minute: string
  workflowDir: string
  runId?: string
  includeStructuredResult?: boolean
}): unknown[] {
  const { turn, minute, workflowDir } = input
  const runId = input.runId ?? `wf-${turn}`
  return [
    {
      type: 'user',
      uuid: `turn-${turn}`,
      sessionId: 'workflow-trace',
      timestamp: `2026-01-01T00:${minute}:00Z`,
      message: { role: 'user', content: `${turn.toUpperCase()} TASK` },
    },
    {
      type: 'assistant',
      uuid: `answer-${turn}`,
      sessionId: 'workflow-trace',
      timestamp: `2026-01-01T00:${minute}:01Z`,
      message: {
        id: `workflow-message-${turn}`,
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: `workflow-call-${turn}`,
          name: 'Workflow',
          input: { script: `${turn}()` },
        }],
      },
    },
    {
      type: 'user',
      uuid: `result-${turn}`,
      sessionId: 'workflow-trace',
      timestamp: `2026-01-01T00:${minute}:02Z`,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: `workflow-call-${turn}`,
          content: `Workflow launched\nTranscript dir: ${workflowDir}\nRun ID: ${runId}`,
        }],
      },
      ...(input.includeStructuredResult === false
        ? {}
        : { toolUseResult: { runId, transcriptDir: workflowDir } }),
    },
  ]
}

function writeWorkflowChild(
  workflowDir: string,
  turn: string,
  minute: string,
): void {
  mkdirSync(workflowDir, { recursive: true })
  writeFileSync(
    join(workflowDir, `agent-${turn}.jsonl`),
    [
      {
        type: 'user',
        uuid: `worker-task-${turn}`,
        timestamp: `2026-01-01T00:${minute}:03Z`,
        isSidechain: true,
        message: { role: 'user', content: `${turn.toUpperCase()} WORKFLOW TASK` },
      },
      {
        type: 'assistant',
        uuid: `worker-answer-${turn}`,
        timestamp: `2026-01-01T00:${minute}:04Z`,
        message: {
          id: `worker-message-${turn}`,
          role: 'assistant',
          content: [{ type: 'text', text: `${turn.toUpperCase()} WORKFLOW ANSWER` }],
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n'),
  )
  writeFileSync(
    join(workflowDir, `agent-${turn}.meta.json`),
    JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }),
  )
}

describe('Claude Workflow subagents', () => {
  it('binds every workflow child to the exact Workflow tool call', async () => {
    const path = join(dir, 'linked.jsonl')
    const workflowDir = join(dir, 'linked', 'subagents', 'workflows', 'wf-linked')
    writeFileSync(
      path,
      workflowEvents({
        turn: 'linked',
        minute: '00',
        workflowDir,
      }).map((event) => JSON.stringify(event)).join('\n'),
    )
    writeWorkflowChild(workflowDir, 'linked', '00')

    const spans = await new ClaudeAdapter().parse(refFor(path))
    const workflowCall = spans.find((item) => item.attributes['tool.name'] === 'Workflow')
    const workflowSpans = spans.filter(
      (item) => item.attributes['agent.name'] === 'subagent:workflow-subagent',
    )

    expect(workflowSpans).toHaveLength(2)
    expect(workflowSpans.every((item) => item.parent_span_id === workflowCall?.span_id)).toBe(true)
    expect(workflowSpans.every(
      (item) => item.span_id.startsWith('workflows:wf-linked:agent-linked:'),
    )).toBe(true)
    expect(spans[0]?.end_time).toBe('2026-01-01T00:00:04Z')
  })

  it('scopes resumed workflows by run ID with structured and text results', async () => {
    const path = join(dir, 'scoped.jsonl')
    const subDir = join(dir, 'scoped', 'subagents', 'workflows')
    const oldDir = join(subDir, 'wf-old')
    const newDir = join(subDir, 'wf-new')
    writeFileSync(
      path,
      [
        ...workflowEvents({ turn: 'old', minute: '00', workflowDir: oldDir }),
        ...workflowEvents({
          turn: 'new',
          minute: '01',
          workflowDir: newDir,
          includeStructuredResult: false,
        }),
      ].map((event) => JSON.stringify(event)).join('\n'),
    )
    writeWorkflowChild(oldDir, 'old', '00')
    writeWorkflowChild(newDir, 'new', '01')

    const adapter = new ClaudeAdapter()
    const all = await adapter.parse(refFor(path))
    const latest = await adapter.parse(refFor(path), { taskScope: 'latest' })
    const old = await adapter.parse(refFor(path), {
      taskScope: 'turn',
      taskTurnId: 'turn-old',
    })

    expect(contents(all)).toEqual(expect.arrayContaining([
      'OLD WORKFLOW ANSWER',
      'NEW WORKFLOW ANSWER',
    ]))
    expect(contents(latest)).toContain('NEW WORKFLOW ANSWER')
    expect(contents(latest)).not.toContain('OLD WORKFLOW ANSWER')
    expect(contents(old)).toContain('OLD WORKFLOW ANSWER')
    expect(contents(old)).not.toContain('NEW WORKFLOW ANSWER')
  })

  it('partitions a resumed run across the Workflow call active when each child started', async () => {
    const path = join(dir, 'resumed.jsonl')
    const workflowDir = join(dir, 'resumed', 'subagents', 'workflows', 'wf-shared')
    writeFileSync(
      path,
      [
        ...workflowEvents({
          turn: 'initial',
          minute: '00',
          workflowDir,
          runId: 'wf-shared',
        }),
        ...workflowEvents({
          turn: 'resumed-one',
          minute: '01',
          workflowDir,
          runId: 'wf-shared',
        }),
        ...workflowEvents({
          turn: 'resumed-two',
          minute: '02',
          workflowDir,
          runId: 'wf-shared',
        }),
      ].map((event) => JSON.stringify(event)).join('\n'),
    )
    writeWorkflowChild(workflowDir, 'initial-a', '00')
    writeWorkflowChild(workflowDir, 'initial-b', '00')
    writeWorkflowChild(workflowDir, 'resumed-one', '01')
    writeWorkflowChild(workflowDir, 'resumed-two', '02')

    const adapter = new ClaudeAdapter()
    const all = await adapter.parse(refFor(path))
    const latest = await adapter.parse(refFor(path), { taskScope: 'latest' })
    const initial = await adapter.parse(refFor(path), {
      taskScope: 'turn',
      taskTurnId: 'turn-initial',
    })
    const workflowCalls = all.filter(
      (item) => item.attributes['tool.name'] === 'Workflow',
    )
    const childParent = (content: string) =>
      all.find((item) => item.attributes.content === content)?.parent_span_id

    expect(workflowCalls).toHaveLength(3)
    expect(childParent('INITIAL-A WORKFLOW TASK')).toBe(workflowCalls[0]?.span_id)
    expect(childParent('INITIAL-B WORKFLOW TASK')).toBe(workflowCalls[0]?.span_id)
    expect(childParent('RESUMED-ONE WORKFLOW TASK')).toBe(workflowCalls[1]?.span_id)
    expect(childParent('RESUMED-TWO WORKFLOW TASK')).toBe(workflowCalls[2]?.span_id)
    expect(contents(latest)).toContain('RESUMED-TWO WORKFLOW ANSWER')
    expect(contents(latest)).not.toContain('INITIAL-A WORKFLOW ANSWER')
    expect(contents(latest)).not.toContain('RESUMED-ONE WORKFLOW ANSWER')
    expect(contents(initial)).toEqual(expect.arrayContaining([
      'INITIAL-A WORKFLOW ANSWER',
      'INITIAL-B WORKFLOW ANSWER',
    ]))
    expect(contents(initial)).not.toContain('RESUMED-ONE WORKFLOW ANSWER')
    expect(contents(initial)).not.toContain('RESUMED-TWO WORKFLOW ANSWER')
  })

  it('allows one run ID to resume into a different session transcript directory', async () => {
    const path = join(dir, 'cross-session.jsonl')
    const previousDir = join(
      dir,
      'previous-session',
      'subagents',
      'workflows',
      'wf-shared-dir',
    )
    const currentDir = join(
      dir,
      'current-session',
      'subagents',
      'workflows',
      'wf-shared-dir',
    )
    writeFileSync(
      path,
      [
        ...workflowEvents({
          turn: 'previous',
          minute: '00',
          workflowDir: previousDir,
          runId: 'wf-shared-dir',
        }),
        ...workflowEvents({
          turn: 'current',
          minute: '01',
          workflowDir: currentDir,
          runId: 'wf-shared-dir',
        }),
      ].map((event) => JSON.stringify(event)).join('\n'),
    )
    writeWorkflowChild(currentDir, 'current', '01')

    const adapter = new ClaudeAdapter()
    const spans = await adapter.parse(refFor(path))
    const latest = await adapter.parse(refFor(path), { taskScope: 'latest' })
    const previous = await adapter.parse(refFor(path), {
      taskScope: 'turn',
      taskTurnId: 'turn-previous',
    })
    const sourcePaths = await adapter.sourcePaths(refFor(path))
    const calls = spans.filter((item) => item.attributes['tool.name'] === 'Workflow')
    const child = spans.find(
      (item) => item.attributes.content === 'CURRENT WORKFLOW TASK',
    )

    expect(calls).toHaveLength(2)
    expect(child?.parent_span_id).toBe(calls[1]?.span_id)
    expect(contents(latest)).toContain('CURRENT WORKFLOW ANSWER')
    expect(contents(previous)).not.toContain('CURRENT WORKFLOW ANSWER')
    expect(sourcePaths).toEqual(expect.arrayContaining([
      join(currentDir, 'agent-current.jsonl'),
      join(currentDir, 'agent-current.meta.json'),
    ]))
  })

  it('rejects two matching Workflow calls at the same timestamp', async () => {
    const path = join(dir, 'ambiguous-call.jsonl')
    const workflowDir = join(
      dir,
      'ambiguous-call',
      'subagents',
      'workflows',
      'wf-ambiguous',
    )
    writeFileSync(
      path,
      [
        ...workflowEvents({
          turn: 'first',
          minute: '00',
          workflowDir,
          runId: 'wf-ambiguous',
        }),
        ...workflowEvents({
          turn: 'second',
          minute: '00',
          workflowDir,
          runId: 'wf-ambiguous',
        }),
      ].map((event) => JSON.stringify(event)).join('\n'),
    )
    writeWorkflowChild(workflowDir, 'child', '01')

    await expect(new ClaudeAdapter().parse(refFor(path))).rejects.toThrow(
      'parent call is ambiguous',
    )
  })

  it('rejects a Workflow transcript directory outside the selected trace store', async () => {
    const path = join(dir, 'escaping.jsonl')
    const workflowDir = join(
      outsideDir,
      'other-session',
      'subagents',
      'workflows',
      'wf-escaping',
    )
    writeFileSync(
      path,
      workflowEvents({
        turn: 'escaping',
        minute: '00',
        workflowDir,
        runId: 'wf-escaping',
      }).map((event) => JSON.stringify(event)).join('\n'),
    )

    await expect(new ClaudeAdapter().parse(refFor(path))).rejects.toThrow(
      'transcript directory escapes',
    )
  })

  it('rejects a child whose declared transcript directory does not match its files', async () => {
    const path = join(dir, 'mismatched.jsonl')
    const actualDir = join(dir, 'mismatched', 'subagents', 'workflows', 'wf-real')
    const declaredDir = join(
      dir,
      'elsewhere',
      'subagents',
      'workflows',
      'wf-real',
    )
    writeFileSync(
      path,
      workflowEvents({
        turn: 'real',
        minute: '00',
        workflowDir: declaredDir,
      }).map((event) => JSON.stringify(event)).join('\n'),
    )
    writeWorkflowChild(actualDir, 'real', '00')

    await expect(new ClaudeAdapter().parse(refFor(path))).rejects.toThrow(
      'transcript directory does not match',
    )
  })

  it('rejects conflicting structured and text Workflow identities', async () => {
    const path = join(dir, 'conflicting.jsonl')
    const textDir = join(dir, 'conflicting', 'subagents', 'workflows', 'wf-text')
    const structuredDir = join(dir, 'conflicting', 'subagents', 'workflows', 'wf-structured')
    const events = workflowEvents({
      turn: 'text',
      minute: '00',
      workflowDir: textDir,
      includeStructuredResult: false,
    }) as Array<Record<string, unknown>>
    events[2]!.toolUseResult = {
      runId: 'wf-structured',
      transcriptDir: structuredDir,
    }
    writeFileSync(path, events.map((event) => JSON.stringify(event)).join('\n'))

    await expect(new ClaudeAdapter().parse(refFor(path))).rejects.toThrow(
      'conflicting structured and text run metadata',
    )
  })

  it('rejects malformed structured Workflow identity instead of trusting text', async () => {
    const path = join(dir, 'malformed-structured.jsonl')
    const textDir = join(dir, 'malformed-structured', 'subagents', 'workflows', 'wf-text')
    const events = workflowEvents({
      turn: 'text',
      minute: '00',
      workflowDir: textDir,
      includeStructuredResult: false,
    }) as Array<Record<string, unknown>>
    events[2]!.toolUseResult = {
      runId: 'wf-text',
      transcriptDir: join(dir, 'wrong-name'),
    }
    writeFileSync(path, events.map((event) => JSON.stringify(event)).join('\n'))

    await expect(new ClaudeAdapter().parse(refFor(path))).rejects.toThrow(
      'invalid structured run metadata',
    )
  })
})
