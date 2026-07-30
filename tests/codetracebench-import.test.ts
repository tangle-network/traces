import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  importCodeTraceBench,
  type CodeTraceBenchStep,
} from '../src/codetracebench.js'

const execFileAsync = promisify(execFile)
const REVISION_40 = 'a'.repeat(40)
const REVISION_64 = 'B'.repeat(64)

function row(
  trajId: string,
  stepCount: number,
): Record<string, unknown> {
  return {
    traj_id: trajId,
    agent: 'mini-SWE-agent',
    model: 'Anthropic/Claude-Sonnet-4',
    task_name: `task-${trajId}`,
    step_count: stepCount,
    annotation_relpath: `agent_failure_analysis/step_annotations_all/${trajId}`,
    incorrect_stages: [
      {
        stage_id: 1,
        incorrect_step_ids: [stepCount],
        unuseful_step_ids: [],
      },
    ],
  }
}

function step(
  stepId: number,
  observation: string | null = `<returncode>0</returncode>\nstep ${stepId}`,
): CodeTraceBenchStep {
  return {
    step_id: stepId,
    action: `echo step-${stepId}`,
    observation,
    action_ref: {
      path: 'agent-logs/mini.traj.json',
      line_start: stepId * 10,
      line_end: stepId * 10 + 2,
      content: `{"role":"assistant","content":"echo step-${stepId}"}`,
    },
    observation_ref:
      observation === null
        ? null
        : {
            path: 'agent-logs/mini.traj.json',
            line_start: stepId * 10 + 3,
            line_end: stepId * 10 + 4,
            content: `{"role":"user","content":"step ${stepId}"}`,
          },
  }
}

async function fixture(
  rows: readonly Record<string, unknown>[],
  steps: Readonly<Record<string, readonly unknown[]>>,
): Promise<{
  root: string
  rowsPath: string
  trajectoryDir: string
  outDir: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'traces-codetracebench-'))
  const rowsPath = join(root, 'verified.jsonl')
  const trajectoryDir = join(root, 'normalized')
  await mkdir(trajectoryDir)
  await writeFile(
    rowsPath,
    `${rows.map((item) => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  )
  for (const [trajId, records] of Object.entries(steps)) {
    const directory = join(trajectoryDir, trajId)
    await mkdir(directory)
    await writeFile(
      join(directory, 'steps.json'),
      `${JSON.stringify(records, null, 2)}\n`,
      'utf8',
    )
  }
  return {
    root,
    rowsPath,
    trajectoryDir,
    outDir: join(root, 'traces'),
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function waitFor(
  condition: () => Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function parseJsonl(text: string): Record<string, unknown>[] {
  return text.trim().split('\n').map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  )
}

describe('CodeTraceBench bulk import', () => {
  it('writes stable, label-free, single-trace OTLP files in native row order', async () => {
    const rows = [row('case-b', 2), row('case-a', 1)]
    const test = await fixture(rows, {
      'case-b': [step(1), step(2, null)],
      'case-a': [step(1)],
    })
    await writeFile(
      join(test.trajectoryDir, 'case-b', 'task.md'),
      'Repair the package installer.\n',
      'utf8',
    )

    const first = await importCodeTraceBench({
      rowsPath: test.rowsPath,
      trajectoryDir: test.trajectoryDir,
      outDir: test.outDir,
      revision: REVISION_40,
      concurrency: 2,
    })

    expect(await readdir(test.outDir)).toEqual([
      'case-a.otlp.jsonl',
      'case-b.otlp.jsonl',
      'codetracebench-import.json',
    ])
    expect(first.receipt.traces.map((item) => item.traceId)).toEqual([
      'case-b',
      'case-a',
    ])
    expect(first.receipt.traces.map((item) => item.index)).toEqual([0, 1])
    expect(first.receipt.counts).toEqual({
      rows: 2,
      traces: 2,
      steps: 3,
      spans: 9,
    })
    expect(first.receipt.traces.map((item) => item.taskSource)).toEqual([
      'task.md',
      'task_name',
    ])
    expect(first.receipt.input.rowsSha256).toBe(
      createHash('sha256').update(await readFile(test.rowsPath)).digest('hex'),
    )
    expect(first.receipt.safety).toEqual({
      labelLeakScan: 'passed',
      outputDirectoryCreatedExclusively: true,
      filesPublishedAtomically: true,
    })

    for (const imported of first.receipt.traces) {
      const output = await readFile(join(test.outDir, imported.output.path), 'utf8')
      const spans = parseJsonl(output)
      expect(new Set(spans.map((item) => item.trace_id))).toEqual(
        new Set([imported.traceId]),
      )
      expect(
        spans
          .filter((item) => item.kind === 'LLM')
          .map((item) => item.span_id),
      ).toEqual(
        Array.from(
          { length: imported.stepCount },
          (_, index) => `step-${index + 1}`,
        ),
      )
      expect(output).not.toContain('incorrect_stages')
      expect(output).not.toContain('incorrect_step_ids')
      expect(output).not.toContain('annotation_relpath')
      expect(output).not.toContain('agent_failure_analysis')
      expect(imported.output.sha256).toBe(
        createHash('sha256').update(output).digest('hex'),
      )
    }

    const secondOut = join(test.root, 'traces-repeat')
    const second = await importCodeTraceBench({
      rowsPath: test.rowsPath,
      trajectoryDir: test.trajectoryDir,
      outDir: secondOut,
      revision: REVISION_40,
      concurrency: 1,
    })
    expect(second.receipt.input.sha256).toBe(first.receipt.input.sha256)
    expect(second.receipt.outputSha256).toBe(first.receipt.outputSha256)
    for (const imported of first.receipt.traces) {
      expect(await readFile(join(secondOut, imported.output.path), 'utf8')).toBe(
        await readFile(join(test.outDir, imported.output.path), 'utf8'),
      )
    }
  })

  it('fails without publishing when steps are missing or malformed', async () => {
    const missing = await fixture([row('missing', 1)], {})
    await expect(
      importCodeTraceBench({
        rowsPath: missing.rowsPath,
        trajectoryDir: missing.trajectoryDir,
        outDir: missing.outDir,
        revision: REVISION_40,
      }),
    ).rejects.toThrow('missing: steps.json is missing')
    expect(await exists(missing.outDir)).toBe(false)
    expect(await exists(`${missing.outDir}.lock`)).toBe(false)
    expect(
      (await readdir(missing.root)).some((name) => name.startsWith('.traces.tmp-')),
    ).toBe(false)

    const malformedStep = { ...step(1), step_id: 2 }
    const malformed = await fixture(
      [row('malformed', 1)],
      { malformed: [malformedStep] },
    )
    await expect(
      importCodeTraceBench({
        rowsPath: malformed.rowsPath,
        trajectoryDir: malformed.trajectoryDir,
        outDir: malformed.outDir,
        revision: REVISION_40,
      }),
    ).rejects.toThrow('step_id is 2; expected 1')
    expect(await exists(malformed.outDir)).toBe(false)

    const missingObservation = { ...step(1) } as Record<string, unknown>
    delete missingObservation.observation
    const incomplete = await fixture(
      [row('incomplete', 1)],
      { incomplete: [missingObservation] },
    )
    await expect(
      importCodeTraceBench({
        rowsPath: incomplete.rowsPath,
        trajectoryDir: incomplete.trajectoryDir,
        outDir: incomplete.outDir,
        revision: REVISION_40,
      }),
    ).rejects.toThrow('observation is required and may be null')
    expect(await exists(incomplete.outDir)).toBe(false)
  })

  it('rejects annotation keys, paths, and serialized labels in visible content', async () => {
    const labels = row('contaminated', 1)
    const contaminated = await fixture([labels], {
      contaminated: [
        {
          ...step(1),
          action: 'print({"incorrect_step_ids":[1]})',
        },
      ],
    })
    await expect(
      importCodeTraceBench({
        rowsPath: contaminated.rowsPath,
        trajectoryDir: contaminated.trajectoryDir,
        outDir: contaminated.outDir,
        revision: REVISION_40,
      }),
    ).rejects.toThrow('generated trace contains CodeTraceBench annotation data')
    expect(await exists(contaminated.outDir)).toBe(false)

    const pathLeak = await fixture([row('path-leak', 1)], {
      'path-leak': [step(1)],
    })
    await writeFile(
      join(pathLeak.trajectoryDir, 'path-leak', 'task.md'),
      'Read agent_failure_analysis/step_annotations_all/path-leak before acting.',
      'utf8',
    )
    await expect(
      importCodeTraceBench({
        rowsPath: pathLeak.rowsPath,
        trajectoryDir: pathLeak.trajectoryDir,
        outDir: pathLeak.outDir,
        revision: REVISION_40,
      }),
    ).rejects.toThrow('generated trace contains CodeTraceBench annotation data')
    expect(await exists(pathLeak.outDir)).toBe(false)
  })

  it('honors cancellation and refuses an existing output directory', async () => {
    const cancelled = await fixture([row('cancelled', 1)], {
      cancelled: [step(1)],
    })
    const controller = new AbortController()
    controller.abort(new Error('stop import'))
    await expect(
      importCodeTraceBench({
        rowsPath: cancelled.rowsPath,
        trajectoryDir: cancelled.trajectoryDir,
        outDir: cancelled.outDir,
        revision: REVISION_40,
        signal: controller.signal,
      }),
    ).rejects.toThrow('stop import')
    expect(await exists(cancelled.outDir)).toBe(false)

    const existing = await fixture([row('existing', 1)], {
      existing: [step(1)],
    })
    await mkdir(existing.outDir)
    await writeFile(join(existing.outDir, 'keep.txt'), 'unchanged', 'utf8')
    await expect(
      importCodeTraceBench({
        rowsPath: existing.rowsPath,
        trajectoryDir: existing.trajectoryDir,
        outDir: existing.outDir,
        revision: REVISION_40,
      }),
    ).rejects.toThrow('output directory already exists')
    expect(await readFile(join(existing.outDir, 'keep.txt'), 'utf8')).toBe(
      'unchanged',
    )
  })

  it('rejects duplicate rows and unbounded worker counts before writing', async () => {
    const duplicate = await fixture(
      [row('duplicate', 1), row('duplicate', 1)],
      { duplicate: [step(1)] },
    )
    await expect(
      importCodeTraceBench({
        rowsPath: duplicate.rowsPath,
        trajectoryDir: duplicate.trajectoryDir,
        outDir: duplicate.outDir,
        revision: REVISION_40,
      }),
    ).rejects.toThrow("duplicate traj_id 'duplicate'")
    expect(await exists(duplicate.outDir)).toBe(false)

    const concurrency = await fixture([row('bounded', 1)], {
      bounded: [step(1)],
    })
    await expect(
      importCodeTraceBench({
        rowsPath: concurrency.rowsPath,
        trajectoryDir: concurrency.trajectoryDir,
        outDir: concurrency.outDir,
        revision: REVISION_40,
        concurrency: 65,
      }),
    ).rejects.toThrow('concurrency must be an integer from 1 to 64')
    expect(await exists(concurrency.outDir)).toBe(false)
  })

  it('allows exactly one concurrent importer to work on a new output directory', async () => {
    const payload = 'x'.repeat(2 * 1024 * 1024)
    const first = await fixture([row('race-a', 1)], {
      'race-a': [{ ...step(1), action: `echo race-a\n${payload}` }],
    })
    const second = await fixture([row('race-b', 1)], {
      'race-b': [{ ...step(1), action: `echo race-b\n${payload}` }],
    })
    const outputDirectory = first.outDir
    const lockPath = `${outputDirectory}.lock`

    const settled = Promise.allSettled([
      importCodeTraceBench({
        rowsPath: first.rowsPath,
        trajectoryDir: first.trajectoryDir,
        outDir: outputDirectory,
        revision: REVISION_40,
      }),
      importCodeTraceBench({
        rowsPath: second.rowsPath,
        trajectoryDir: second.trajectoryDir,
        outDir: outputDirectory,
        revision: REVISION_64,
      }),
    ])
    await waitFor(
      async () =>
        (await readdir(first.root)).some((name) =>
          name.startsWith('.traces.tmp-'),
        ),
      'one concurrent importer workspace',
    )
    expect(
      (await readdir(first.root)).filter((name) =>
        name.startsWith('.traces.tmp-'),
      ),
    ).toHaveLength(1)
    const results = await settled
    const successes = results.filter((item) => item.status === 'fulfilled')
    const failures = results.filter((item) => item.status === 'rejected')
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)

    const success = successes[0]
    const failure = failures[0]
    if (success?.status !== 'fulfilled' || failure?.status !== 'rejected') {
      throw new Error('Expected one successful and one rejected importer')
    }
    const failureMessage =
      failure.reason instanceof Error
        ? failure.reason.message
        : String(failure.reason)
    expect(failureMessage).toContain('import already in progress')
    expect(failureMessage).toContain(`Lock: ${lockPath}`)
    expect(failureMessage).toContain(`PID ${process.pid} on ${hostname()}`)
    expect(failureMessage).toContain('started ')
    expect(failureMessage).toContain('remove the lock only after confirming')

    const winner = success.value.receipt.traces[0]!.traceId
    const loser = winner === 'race-a' ? 'race-b' : 'race-a'
    expect((await readdir(outputDirectory)).sort()).toEqual(
      [`${winner}.otlp.jsonl`, 'codetracebench-import.json'].sort(),
    )
    expect(await exists(join(outputDirectory, `${loser}.otlp.jsonl`))).toBe(false)
    expect(await exists(lockPath)).toBe(false)
    expect(
      (await readdir(first.root)).some((name) => name.startsWith('.traces.tmp-')),
    ).toBe(false)
  })

  it('preserves an empty output directory created after conversion starts', async () => {
    const payload = 'y'.repeat(4 * 1024 * 1024)
    const test = await fixture([row('external-directory', 1)], {
      'external-directory': [
        { ...step(1), action: `echo external-directory\n${payload}` },
      ],
    })
    const lockPath = `${test.outDir}.lock`
    const attempt = importCodeTraceBench({
      rowsPath: test.rowsPath,
      trajectoryDir: test.trajectoryDir,
      outDir: test.outDir,
      revision: REVISION_40,
    })
    const rejection = expect(attempt).rejects.toThrow(
      'output directory appeared while import was running; refusing to replace it',
    )

    await waitFor(
      async () =>
        (await readdir(test.root)).some((name) =>
          name.startsWith('.traces.tmp-'),
        ),
      'CodeTraceBench conversion staging',
    )
    expect(await exists(lockPath)).toBe(true)
    expect(
      JSON.parse(await readFile(lockPath, 'utf8')),
    ).toMatchObject({
      kind: 'traces.codetracebench-import-lock',
      pid: process.pid,
      hostname: hostname(),
      revision: REVISION_40,
      outputDirectory: test.outDir,
    })
    await mkdir(test.outDir)
    await rejection

    expect(await readdir(test.outDir)).toEqual([])
    expect(await exists(lockPath)).toBe(false)
    expect(
      (await readdir(test.root)).some((name) => name.startsWith('.traces.tmp-')),
    ).toBe(false)
  })

  it.each([
    ['friendly name', 'revision-1'],
    ['39-character digest', 'a'.repeat(39)],
    ['65-character digest', 'A'.repeat(65)],
    ['non-hex digest', 'g'.repeat(40)],
    ['whitespace-padded digest', ` ${REVISION_40}`],
  ])('rejects an immutable revision written as a %s', async (_label, revision) => {
    const test = await fixture([row('revision-case', 1)], {
      'revision-case': [step(1)],
    })
    await expect(
      importCodeTraceBench({
        rowsPath: test.rowsPath,
        trajectoryDir: test.trajectoryDir,
        outDir: test.outDir,
        revision,
      }),
    ).rejects.toThrow(
      'revision must be a full 40- or 64-character hexadecimal commit or digest',
    )
    expect(await exists(test.outDir)).toBe(false)
    expect(await exists(`${test.outDir}.lock`)).toBe(false)
  })

  it('exposes the same bulk import through the CLI', async () => {
    const test = await fixture([row('cli-case', 1)], {
      'cli-case': [step(1)],
    })
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'import-codetracebench',
        test.rowsPath,
        '--trajectory-dir',
        test.trajectoryDir,
        '--out',
        test.outDir,
        '--revision',
        REVISION_64,
        '--concurrency',
        '2',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    )

    expect(stdout).toContain('imported 1 CodeTraceBench trajectory')
    expect(stdout).toContain('(1 step, 4 spans)')
    expect(await exists(join(test.outDir, 'cli-case.otlp.jsonl'))).toBe(true)
    expect(await exists(join(test.outDir, 'codetracebench-import.json'))).toBe(
      true,
    )

    const { stdout: help } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'import-codetracebench', '--help'],
      {
        cwd: process.cwd(),
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    )
    expect(help).toContain('--revision <40-or-64-character-hex>')
  })
})
