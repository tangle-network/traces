import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  importCodeTraceBench,
  type CodeTraceBenchStep,
} from '../src/codetracebench.js'

const REVISION = 'c'.repeat(40)

function memoryRef(content: string): CodeTraceBenchStep['action_ref'] {
  return { path: '<memory>', line_start: 1, line_end: 1, content }
}

// swe_raw OpenHands trials normalize into tool-call steps: thinking text,
// tool_type per call, <memory> refs, and a trailing cut-off step whose
// observation is null.
const openHandsSteps: CodeTraceBenchStep[] = [
  {
    step_id: 1,
    action: 'find . -name "*.cfg" -maxdepth 2',
    observation: 'setup.cfg\ntox.cfg',
    thinking: 'Locate the configuration files first.',
    tool_type: 'execute_bash',
    action_ref: memoryRef('{"id":"call_1","function":{"name":"execute_bash"}}'),
    observation_ref: memoryRef('{"tool_call_id":"call_1"}'),
  },
  {
    step_id: 2,
    action: 'str_replace_editor({"command":"view","path":"/repo/setup.cfg"})',
    observation: '[metadata]\nname = demo',
    tool_type: 'str_replace_editor',
    action_ref: memoryRef('{"id":"call_2","function":{"name":"str_replace_editor"}}'),
    observation_ref: memoryRef('{"tool_call_id":"call_2"}'),
  },
  {
    step_id: 3,
    action: 'python -m pytest tests/ -x -q',
    observation: null,
    tool_type: 'execute_bash',
    action_ref: memoryRef('{"id":"call_3","function":{"name":"execute_bash"}}'),
    observation_ref: null,
  },
]

// Terminus2 trials normalize into command-level steps: an episode's commands
// share a parallel_group, only its final command carries the next episode's
// terminal output, and blank keystrokes render as their JSON literal.
const terminus2Steps: CodeTraceBenchStep[] = [
  {
    step_id: 1,
    action: 'sqlite3 app.db ".tables"\n',
    observation: null,
    thinking: 'Inspect the database, then replay the WAL.',
    parallel_group: 0,
    action_ref: {
      path: 'agent-logs/episode-0/response.txt',
      line_start: 1,
      line_end: 12,
      content: '{"analysis":"...","commands":[{"keystrokes":"sqlite3 app.db \\".tables\\"\\n"}]}',
    },
    observation_ref: null,
  },
  {
    step_id: 2,
    action: '"\\n"',
    observation: 'users orders\nsqlite>',
    parallel_group: 0,
    action_ref: {
      path: 'agent-logs/episode-0/response.txt',
      line_start: 1,
      line_end: 12,
      content: '{"analysis":"...","commands":[{"keystrokes":"\\n"}]}',
    },
    observation_ref: {
      path: 'agent-logs/episode-1/prompt.txt',
      line_start: 1,
      line_end: 4,
      content: 'New Terminal Output:\nusers orders\nsqlite>',
    },
  },
  {
    step_id: 3,
    action: '.recover --wal\n',
    observation: 'recovered 12 rows',
    parallel_group: 1,
    action_ref: {
      path: 'agent-logs/episode-1/response.txt',
      line_start: 1,
      line_end: 9,
      content: '{"commands":[{"keystrokes":".recover --wal\\n"}]}',
    },
    observation_ref: {
      path: 'agent-logs/episode-2/prompt.txt',
      line_start: 1,
      line_end: 2,
      content: 'New Terminal Output:\nrecovered 12 rows',
    },
  },
]

async function familyFixture(): Promise<{
  rowsPath: string
  trajectoryDir: string
  outDir: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'traces-ctb-families-'))
  const rowsPath = join(root, 'rows.jsonl')
  const trajectoryDir = join(root, 'normalized')
  await mkdir(trajectoryDir)
  const rows = [
    {
      traj_id: 'openhands-case',
      agent: 'OpenHands',
      model: 'OpenAI/GPT-5',
      task_name: 'django__django-11099',
      step_count: 3,
      annotation_relpath: 'merged_cleaned_step25/openhands__verified/django__django-11099',
      incorrect_stages: [
        { stage_id: 1, incorrect_step_ids: [2], unuseful_step_ids: [] },
      ],
    },
    {
      traj_id: 'terminus2-case',
      agent: 'Terminus2',
      model: 'Anthropic/Claude-Sonnet-4-20250514-Thinking',
      task_name: 'db-wal-recovery',
      step_count: 3,
      annotation_relpath: 'merged_cleaned_step25/terminus2-claude/db-wal-recovery',
      incorrect_stages: [],
      solved: null,
    },
  ]
  await writeFile(
    rowsPath,
    `${rows.map((item) => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  )
  await mkdir(join(trajectoryDir, 'openhands-case'))
  await writeFile(
    join(trajectoryDir, 'openhands-case', 'steps.json'),
    `${JSON.stringify(openHandsSteps, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(trajectoryDir, 'openhands-case', 'task.md'),
    'Fix the failing configuration parser in django.\n',
    'utf8',
  )
  await mkdir(join(trajectoryDir, 'terminus2-case'))
  await writeFile(
    join(trajectoryDir, 'terminus2-case', 'steps.json'),
    `${JSON.stringify(terminus2Steps, null, 2)}\n`,
    'utf8',
  )
  return { rowsPath, trajectoryDir, outDir: join(root, 'traces') }
}

function parseJsonl(text: string): Record<string, unknown>[] {
  return text.trim().split('\n').map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  )
}

describe('CodeTraceBench OpenHands and Terminus2 imports', () => {
  it('imports both family shapes with the miniswe span invariant intact', async () => {
    const test = await familyFixture()
    const result = await importCodeTraceBench({
      rowsPath: test.rowsPath,
      trajectoryDir: test.trajectoryDir,
      outDir: test.outDir,
      revision: REVISION,
      concurrency: 2,
    })

    expect(result.receipt.counts).toEqual({
      rows: 2,
      traces: 2,
      steps: 6,
      // Each trace: 1 root + 1 task + per-step LLM + per-observation TOOL.
      spans: 5 + 2 + 5 + 2,
    })
    expect(result.receipt.traces.map((item) => item.taskSource)).toEqual([
      'task.md',
      'task_name',
    ])

    const openhands = parseJsonl(
      await readFile(join(test.outDir, 'openhands-case.otlp.jsonl'), 'utf8'),
    )
    const openhandsActions = openhands.filter((span) => span.kind === 'LLM')
    expect(openhandsActions.map((span) => span.span_id)).toEqual([
      'step-1',
      'step-2',
      'step-3',
    ])
    const firstAttributes = openhandsActions[0]!.attributes as Record<string, unknown>
    expect(firstAttributes['agent.name']).toBe('OpenHands')
    expect(firstAttributes.content).toBe(
      'Locate the configuration files first.\nfind . -name "*.cfg" -maxdepth 2',
    )
    const openhandsTools = openhands.filter((span) => span.kind === 'TOOL')
    expect(openhandsTools).toHaveLength(2)
    expect(openhandsTools.map((span) => span.name)).toEqual([
      'tool.execute_bash',
      'tool.str_replace_editor',
    ])

    const terminus2 = parseJsonl(
      await readFile(join(test.outDir, 'terminus2-case.otlp.jsonl'), 'utf8'),
    )
    const terminus2Actions = terminus2.filter((span) => span.kind === 'LLM')
    expect(terminus2Actions.map((span) => span.span_id)).toEqual([
      'step-1',
      'step-2',
      'step-3',
    ])
    const blankKeystroke = terminus2Actions[1]!.attributes as Record<string, unknown>
    expect(blankKeystroke.content).toBe('"\\n"')
    expect(terminus2.filter((span) => span.kind === 'TOOL')).toHaveLength(2)
    for (const output of ['openhands-case', 'terminus2-case']) {
      const text = await readFile(join(test.outDir, `${output}.otlp.jsonl`), 'utf8')
      expect(text).not.toContain('incorrect_step_ids')
      expect(text).not.toContain('merged_cleaned_step25/')
    }
  })

  it('keeps rejecting steps the family normalizers may not emit', async () => {
    const test = await familyFixture()
    const badSteps = [...terminus2Steps]
    badSteps[0] = { ...badSteps[0]!, action: '   ' }
    await writeFile(
      join(test.trajectoryDir, 'terminus2-case', 'steps.json'),
      `${JSON.stringify(badSteps, null, 2)}\n`,
      'utf8',
    )
    await expect(
      importCodeTraceBench({
        rowsPath: test.rowsPath,
        trajectoryDir: test.trajectoryDir,
        outDir: test.outDir,
        revision: REVISION,
        concurrency: 1,
      }),
    ).rejects.toThrow(/action must be a non-empty string/)
  })
})
