import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyVerdict,
  findingReplayStep,
  findingTrajectoryId,
  parseVerifyFindingsArgs,
  readFindingsFile,
  renderVerifiedFindingsSection,
  resolveFindingReplayability,
  type VerifiableFinding,
  verifyFindings,
} from '../src/analyze-verify.js'
import { SUBMIT_ACTION_SIGNATURE } from '../src/replay-corpus.js'
import type { ReplayExecBackend, ReplayExecResult, ReplayVerdict } from '../src/replay-verify.js'
import { fixtureStep, writeFixtureCorpus } from './replay-corpus-fixture.js'

let root: string
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'analyze-verify-test-'))
  return root
}

function wrappedPayload(command: string): string {
  const match = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| sh$/.exec(command)
  if (!match) throw new Error(`not a wrapped exec command: ${command}`)
  return Buffer.from(match[1]!, 'base64').toString('utf8')
}

function scriptedBackend(
  script: (action: string) => ReplayExecResult,
): ReplayExecBackend & { executed: string[][] } {
  const executed: string[][] = []
  return {
    executed,
    async open() {
      const session: string[] = []
      executed.push(session)
      return {
        async exec(command: string): Promise<ReplayExecResult> {
          const action = wrappedPayload(command)
          session.push(action)
          return script(action)
        },
        async close() {},
      }
    },
  }
}

const steps = () => [
  fixtureStep(1, 'ls', 0, 'files'),
  fixtureStep(2, 'sed -i broken file.c', 0),
  fixtureStep(3, 'make target', 2, 'file.c:9:2: error: broken build\nstopped'),
  fixtureStep(4, 'echo probe', 0, 'probe'),
  fixtureStep(5, `echo ${SUBMIT_ACTION_SIGNATURE} && git diff`, null),
]

function finding(overrides: Partial<VerifiableFinding> & { subject?: string }): VerifiableFinding {
  return {
    finding_id: 'f_test0001',
    analyst_id: 'dspy-rlm',
    area: 'incorrect',
    claim: 'Step 3 is incorrect.',
    subject: 'incorrect-step-3',
    evidence_refs: [{ kind: 'span', uri: 'trace://traj-ok/span/step-3', excerpt: 'make target' }],
    ...overrides,
  }
}

describe('findingReplayStep', () => {
  it('prefers metadata.block_first_step over the subject', () => {
    expect(findingReplayStep(finding({ subject: 'incorrect-step-9', metadata: { block_first_step: 3 } }))).toBe(3)
  })

  it('parses both subject forms and rejects everything else', () => {
    expect(findingReplayStep(finding({ subject: 'incorrect-step-7' }))).toBe(7)
    expect(findingReplayStep(finding({ subject: 'incorrect-steps-4-6-unescaped-consequence-8' }))).toBe(4)
    expect(findingReplayStep(finding({ subject: 'knowledge-gap-tooling' }))).toBeNull()
    expect(findingReplayStep({})).toBeNull()
  })
})

describe('findingTrajectoryId', () => {
  it('reads the trajectory from trace:// evidence refs', () => {
    expect(findingTrajectoryId(finding({}))).toBe('traj-ok')
    expect(findingTrajectoryId(finding({ evidence_refs: [{ kind: 'artifact', uri: 'file:///x' }] }))).toBeNull()
    expect(findingTrajectoryId(finding({ evidence_refs: [] }))).toBeNull()
  })
})

describe('resolveFindingReplayability', () => {
  it('direct source: resolves a replayable finding with the recorded returncode', () => {
    const dir = makeRoot()
    const stepsPath = join(dir, 'steps.json')
    writeFileSync(stepsPath, JSON.stringify(steps()))
    const result = resolveFindingReplayability(finding({}), {
      kind: 'direct',
      stepsPath,
      image: 'img:replay',
      cwd: '/repo',
      caseId: 'traj-ok',
    })
    expect(result).toMatchObject({
      replayable: true,
      resolved: { caseId: 'traj-ok', at: 3, recordedReturncode: 2, image: 'img:replay' },
    })
  })

  it('direct source: names the precise not-replayable reason', () => {
    const dir = makeRoot()
    const stepsPath = join(dir, 'steps.json')
    writeFileSync(stepsPath, JSON.stringify(steps()))
    const source = { kind: 'direct', stepsPath, image: 'img:replay', cwd: '/repo', caseId: 'traj-ok' } as const
    expect(resolveFindingReplayability(finding({ subject: 'no-step-here' }), source)).toMatchObject({
      replayable: false,
      reason: expect.stringContaining('names no trajectory step'),
    })
    expect(resolveFindingReplayability(finding({ subject: 'incorrect-step-99' }), source)).toMatchObject({
      replayable: false,
      reason: expect.stringContaining('outside the trajectory'),
    })
    expect(resolveFindingReplayability(finding({ subject: 'incorrect-step-5' }), source)).toMatchObject({
      replayable: false,
      reason: expect.stringContaining('submit action'),
    })
    const noReturncode = [...steps().slice(0, 3), fixtureStep(4, 'echo probe', null)]
    writeFileSync(stepsPath, JSON.stringify(noReturncode))
    expect(resolveFindingReplayability(finding({ subject: 'incorrect-step-4' }), source)).toMatchObject({
      replayable: false,
      reason: expect.stringContaining('recorded no returncode'),
    })
    expect(
      resolveFindingReplayability(
        finding({ evidence_refs: [{ kind: 'span', uri: 'trace://other-traj/span/step-3' }] }),
        source,
      ),
    ).toMatchObject({
      replayable: false,
      reason: expect.stringContaining("cites trajectory 'other-traj'"),
    })
  })

  it('corpus source: resolves through the corpus and surfaces exclusion reasons', () => {
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'wire', [
      {
        trajId: 'traj-ok',
        steps: steps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/img:1', runConfigCwd: '/repo', timeoutSeconds: 9 },
      },
      { trajId: 'traj-not-swe', steps: steps(), goldIncorrectSteps: [3] },
    ])
    expect(resolveFindingReplayability(finding({}), { kind: 'corpus', corpora: [corpus] })).toMatchObject({
      replayable: true,
      resolved: { caseId: 'traj-ok', image: 'example/img:1', cwd: '/repo', at: 3, recordedStepTimeoutMs: 9000 },
    })
    expect(
      resolveFindingReplayability(
        finding({ evidence_refs: [{ kind: 'span', uri: 'trace://traj-not-swe/span/step-3' }] }),
        { kind: 'corpus', corpora: [corpus] },
      ),
    ).toMatchObject({ replayable: false, reason: expect.stringContaining('no-swe-raw-trajectory') })
    expect(
      resolveFindingReplayability(finding({ evidence_refs: [] }), { kind: 'corpus', corpora: [corpus] }),
    ).toMatchObject({ replayable: false, reason: expect.stringContaining('no trace://') })
  })
})

describe('classifyVerdict', () => {
  const verdict = (armAMatch: boolean, armB: { failureVanished: boolean } | null): ReplayVerdict =>
    ({
      armA: { failureSignatureMatch: armAMatch },
      armB,
    }) as unknown as ReplayVerdict

  it('maps arm outcomes onto the enum', () => {
    expect(classifyVerdict(verdict(true, null))).toBe('reproduced')
    expect(classifyVerdict(verdict(true, { failureVanished: true }))).toBe('fix-flipped')
    expect(classifyVerdict(verdict(true, { failureVanished: false }))).toBe('reproduced')
    expect(classifyVerdict(verdict(false, null))).toBe('divergent')
    expect(classifyVerdict(verdict(false, { failureVanished: true }))).toBe('divergent')
  })
})

describe('verifyFindings', () => {
  function fixtureSource(dir: string) {
    const corpus = writeFixtureCorpus(dir, 'wire', [
      {
        trajId: 'traj-ok',
        steps: steps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/img:1', runConfigCwd: '/repo' },
      },
    ])
    return { kind: 'corpus', corpora: [corpus] } as const
  }

  const reproducingBackend = () =>
    scriptedBackend((action) =>
      action === 'make target'
        ? { exitCode: 2, stdout: 'stopped', stderr: 'file.c:9:2: error: broken build' }
        : action === 'fix file.c && make target'
          ? { exitCode: 0, stdout: 'built ok', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
    )

  it('reproduces a finding and writes an executed receipt', async () => {
    const dir = makeRoot()
    const backend = reproducingBackend()
    const run = await verifyFindings([finding({})], {
      source: fixtureSource(dir),
      out: join(dir, 'out'),
      backend,
    })
    expect(run.counts).toEqual({ reproduced: 1, 'fix-flipped': 0, divergent: 0, 'not-replayable': 0 })
    expect(run.executions).toBe(1)
    const verification = run.verifications[0]!
    expect(verification.verified).toBe('reproduced')
    expect(verification.step).toBe(3)
    const receipt = JSON.parse(readFileSync(join(verification.receipt, 'receipt.json'), 'utf8'))
    expect(receipt).toMatchObject({
      finding_id: 'f_test0001',
      verified: 'reproduced',
      trajectory_id: 'traj-ok',
      step: 3,
      execution: {
        armA: { command: 'make target', exitCode: 2, failureSignatureMatch: true },
        recordedReturncode: 2,
        armB: null,
      },
    })
    expect(existsSync(verification.verdict_path!)).toBe(true)
    expect(existsSync(join(run.out, 'verifications.json'))).toBe(true)
    expect(backend.executed).toEqual([['ls', 'sed -i broken file.c', 'make target']])
  })

  it('fix-flips when the supplied corrected command makes the failure vanish', async () => {
    const dir = makeRoot()
    const run = await verifyFindings([finding({})], {
      source: fixtureSource(dir),
      out: join(dir, 'out'),
      backend: reproducingBackend(),
      fixCommand: 'fix file.c && make target',
    })
    expect(run.verifications[0]!.verified).toBe('fix-flipped')
    const receipt = JSON.parse(readFileSync(join(run.verifications[0]!.receipt, 'receipt.json'), 'utf8'))
    expect(receipt.execution.armB).toMatchObject({ exitCode: 0, failureVanished: true })
  })

  it('marks a non-reproducing execution divergent', async () => {
    const dir = makeRoot()
    const run = await verifyFindings([finding({})], {
      source: fixtureSource(dir),
      out: join(dir, 'out'),
      backend: scriptedBackend(() => ({ exitCode: 0, stdout: 'all fine', stderr: '' })),
    })
    expect(run.verifications[0]!.verified).toBe('divergent')
    expect(run.counts.divergent).toBe(1)
  })

  it('writes an honest not-replayable receipt without touching the sandbox', async () => {
    const dir = makeRoot()
    const backend = scriptedBackend(() => ({ exitCode: 0, stdout: '', stderr: '' }))
    const run = await verifyFindings(
      [finding({ subject: 'incorrect-step-5', evidence_refs: [{ kind: 'span', uri: 'trace://traj-ok/span/step-5' }] })],
      { source: fixtureSource(dir), out: join(dir, 'out'), backend },
    )
    const verification = run.verifications[0]!
    expect(verification.verified).toBe('not-replayable')
    expect(verification.reason).toContain('submit action')
    expect(verification.verdict_path).toBeNull()
    expect(backend.executed).toEqual([])
    const receipt = JSON.parse(readFileSync(join(verification.receipt, 'receipt.json'), 'utf8'))
    expect(receipt.reason).toContain('submit action')
    expect(receipt.execution).toBeNull()
  })

  it('shares one executed proof across findings accusing the same step', async () => {
    const dir = makeRoot()
    const backend = reproducingBackend()
    const run = await verifyFindings(
      [
        finding({}),
        finding({ finding_id: 'f_test0002', subject: 'incorrect-step-4', metadata: { block_first_step: 3 } }),
      ],
      { source: fixtureSource(dir), out: join(dir, 'out'), backend },
    )
    expect(run.executions).toBe(1)
    expect(backend.executed).toHaveLength(1)
    expect(run.verifications[1]!).toMatchObject({
      verified: 'reproduced',
      deduplicated_with: run.verifications[0]!.receipt,
      verdict_path: run.verifications[0]!.verdict_path,
    })
    const sharedReceipt = JSON.parse(readFileSync(join(run.verifications[1]!.receipt, 'receipt.json'), 'utf8'))
    expect(sharedReceipt.execution).toMatchObject({ armA: { exitCode: 2 } })
  })

  it('fails loud when replayable findings exist but the sandbox is unreachable', async () => {
    const dir = makeRoot()
    await expect(
      verifyFindings([finding({})], {
        source: fixtureSource(dir),
        out: join(dir, 'out'),
        apiKey: 'k',
        baseUrl: 'http://127.0.0.1:1',
      }),
    ).rejects.toThrow(/sandbox API unreachable/)
    await expect(
      verifyFindings([finding({})], { source: fixtureSource(dir), out: join(dir, 'out') }),
    ).rejects.toThrow(/SANDBOX_API_KEY/)
  })

  it('rejects an empty findings array', async () => {
    const dir = makeRoot()
    await expect(
      verifyFindings([], { source: fixtureSource(dir), out: join(dir, 'out') }),
    ).rejects.toThrow(/no findings/)
  })
})

describe('renderVerifiedFindingsSection', () => {
  it('marks each finding VERIFIED with its receipt or UNVERIFIABLE with the reason', async () => {
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'wire', [
      {
        trajId: 'traj-ok',
        steps: steps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/img:1', runConfigCwd: '/repo' },
      },
    ])
    const run = await verifyFindings(
      [finding({}), finding({ finding_id: 'f_test0002', subject: 'not-a-step' })],
      {
        source: { kind: 'corpus', corpora: [corpus] },
        out: join(dir, 'out'),
        backend: scriptedBackend((action) =>
          action === 'make target'
            ? { exitCode: 2, stdout: '', stderr: 'file.c:9:2: error: broken build' }
            : { exitCode: 0, stdout: '', stderr: '' },
        ),
      },
    )
    const section = renderVerifiedFindingsSection(run)
    expect(section).toContain('## Verified findings (executed replay)')
    expect(section).toContain('2 finding(s) → 1 reproduced, 0 fix-flipped, 0 divergent, 1 not replayable')
    expect(section).toContain('**VERIFIED** — reproduced')
    expect(section).toContain(run.verifications[0]!.receipt)
    expect(section).toContain('UNVERIFIABLE — subject')
  })
})

describe('readFindingsFile', () => {
  it('accepts a bare array and an object with findings', () => {
    const dir = makeRoot()
    const arrayPath = join(dir, 'array.json')
    writeFileSync(arrayPath, JSON.stringify([finding({})]))
    expect(readFindingsFile(arrayPath)).toHaveLength(1)
    const objectPath = join(dir, 'object.json')
    writeFileSync(objectPath, JSON.stringify({ findings: [finding({}), finding({})] }))
    expect(readFindingsFile(objectPath)).toHaveLength(2)
  })

  it('fails loud on anything else', () => {
    const dir = makeRoot()
    const badPath = join(dir, 'bad.json')
    writeFileSync(badPath, JSON.stringify({ observations: [] }))
    expect(() => readFindingsFile(badPath)).toThrow(/neither a findings array/)
    writeFileSync(badPath, JSON.stringify([finding({}), 'not-an-object']))
    expect(() => readFindingsFile(badPath)).toThrow(/must be an object/)
  })
})

describe('parseVerifyFindingsArgs', () => {
  it('parses the direct form', () => {
    const parsed = parseVerifyFindingsArgs([
      '--findings', 'f.json', '--out', 'o', '--steps', 's.json', '--image', 'img:1', '--cwd', '/repo',
      '--case', 'traj-ok', '--fix-command', 'true', '--prefix-limit', '2',
    ])
    expect(parsed).toMatchObject({
      findingsPath: 'f.json',
      out: 'o',
      fixCommand: 'true',
      prefixLimit: 2,
      source: { kind: 'direct', stepsPath: 's.json', image: 'img:1', cwd: '/repo', caseId: 'traj-ok' },
    })
  })

  it('parses the corpus form and rejects mixing or missing sources', () => {
    const parsed = parseVerifyFindingsArgs([
      '--findings', 'f.json', '--out', 'o', '--corpus', 'h2=labels.json::prepared',
    ])
    expect(parsed).toMatchObject({
      source: { kind: 'corpus', corpora: [{ name: 'h2', labelsPath: 'labels.json', preparedDir: 'prepared' }] },
    })
    expect(() =>
      parseVerifyFindingsArgs([
        '--findings', 'f.json', '--out', 'o', '--steps', 's.json', '--image', 'i', '--cwd', '/r',
        '--corpus', 'h2=l::p',
      ]),
    ).toThrow(/not both/)
    expect(() => parseVerifyFindingsArgs(['--findings', 'f.json', '--out', 'o'])).toThrow(/replay source/)
    expect(parseVerifyFindingsArgs(['--help'])).toBe('help')
  })
})
