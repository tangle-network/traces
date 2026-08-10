import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import {
  assembleSessionBundle,
  listSessionBundleFiles,
  writeSessionBundleManifest,
  type SessionBundleManifest,
} from '../src/bundle.js'
import {
  classifyEvidenceOnlyPath,
  findSessionTextLeaks,
  projectSessionBundle,
  sessionTextSignatures,
} from '../src/bundle-view.js'
import type { SessionRef } from '../src/types.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-bundle-view-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let outSeq = 0
function newDir(prefix: string): string {
  outSeq += 1
  return join(dir, `${prefix}-${outSeq}`)
}

/**
 * One sentence the session wrote and then copied into a ledger file, which is
 * the leak this view exists to stop: the file is not the transcript, but the
 * words are.
 */
const LEAKED_SENTENCE =
  'The retry budget was the wrong lever and the queue depth is what actually decides tail latency here.'

/** A sentence only the transcript holds, used to prove the view carries none of it. */
const TRANSCRIPT_ONLY_SENTENCE =
  'I rewrote the scheduler so that every queued item carries the deadline it was admitted under.'

function refFor(path: string, cwd: string | null = null): SessionRef {
  return {
    harness: 'claude-code',
    sessionId: 'view-fixture',
    path,
    cwd,
    mtimeMs: Date.parse('2026-01-01T00:00:05Z'),
  }
}

function writeTranscript(path: string): void {
  writeFileSync(
    path,
    [
      {
        type: 'user',
        uuid: 'root-user',
        sessionId: 'view-fixture',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: `${LEAKED_SENTENCE} ${TRANSCRIPT_ONLY_SENTENCE}` },
      },
      {
        type: 'assistant',
        uuid: 'root-assistant',
        sessionId: 'view-fixture',
        timestamp: '2026-01-01T00:00:01Z',
        message: {
          id: 'root-message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-one', name: 'Bash', input: { command: "cat > REPORT.md <<'EOF'" } }],
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n'),
  )
}

function writeChild(subDir: string): void {
  mkdirSync(subDir, { recursive: true })
  writeFileSync(
    join(subDir, 'agent-worker.jsonl'),
    [
      {
        type: 'user',
        uuid: 'child-user',
        timestamp: '2026-01-01T00:00:02Z',
        isSidechain: true,
        message: { role: 'user', content: 'worker TASK' },
      },
      {
        type: 'assistant',
        uuid: 'child-assistant',
        timestamp: '2026-01-01T00:00:03Z',
        message: { id: 'child-message', role: 'assistant', content: 'worker ANSWER' },
      },
    ].map((event) => JSON.stringify(event)).join('\n'),
  )
  writeFileSync(join(subDir, 'agent-worker.meta.json'), JSON.stringify({ agentType: 'worker', toolUseId: 'call-one' }))
}

/**
 * A `.evolve` ledger with both kinds of allow-listed file: `current.json`
 * repeats a sentence from the transcript, `scorecard.json` and
 * `skill-runs.jsonl` hold structured rows only.
 */
async function writeEvolveFixture(root: string): Promise<void> {
  const evolve = join(root, '.evolve')
  await mkdir(join(evolve, 'reflections'), { recursive: true })
  await writeFile(
    join(evolve, 'experiments.jsonl'),
    `${JSON.stringify({ ts: '2026-01-01T00:00:03Z', round: 1, verdict: 'KEEP', note: LEAKED_SENTENCE })}\n`,
    'utf8',
  )
  await writeFile(
    join(evolve, 'skill-runs.jsonl'),
    `${JSON.stringify({ skill: '/verify', ts: '2026-01-01T00:00:04Z', exitCode: 0 })}\n`,
    'utf8',
  )
  await writeFile(join(evolve, 'current.json'), `${JSON.stringify({ mode: 'research', decision: LEAKED_SENTENCE })}\n`, 'utf8')
  await writeFile(join(evolve, 'scorecard.json'), `${JSON.stringify({ flows: [{ flow: 'latency', score: 0.9 }] })}\n`, 'utf8')
  await writeFile(join(evolve, 'progress.md'), `# Progress\n\n${LEAKED_SENTENCE}\n`, 'utf8')
  await writeFile(join(evolve, 'handoff-2026-01-02-latest.md'), `# Handoff\n\n${LEAKED_SENTENCE}\n`, 'utf8')
  await writeFile(join(evolve, 'reflections', '2026-01-01.md'), `# Reflection\n\n${LEAKED_SENTENCE}\n`, 'utf8')
}

async function assembleFullBundle(): Promise<{ bundleDir: string; manifest: SessionBundleManifest }> {
  const ctxRoot = newDir('ctx')
  await mkdir(ctxRoot, { recursive: true })
  await writeEvolveFixture(ctxRoot)
  const transcript = join(dir, `session-${outSeq}.jsonl`)
  writeTranscript(transcript)
  writeChild(join(dir, `session-${outSeq}`, 'subagents'))

  const bundleDir = newDir('bundle')
  const { manifest } = await assembleSessionBundle({
    adapter: new ClaudeAdapter(),
    ref: refFor(transcript, ctxRoot),
    outDir: bundleDir,
    generatedAt: '2026-01-01T01:00:00.000Z',
  })
  return { bundleDir, manifest }
}

/** A bundle written by hand, so a test can control the bytes of a derived artifact. */
async function writeSyntheticBundle(files: Record<string, string>): Promise<string> {
  const bundleDir = newDir('synthetic')
  for (const [path, content] of Object.entries(files)) {
    const target = join(bundleDir, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  const manifest: SessionBundleManifest = {
    schemaVersion: 2,
    kind: 'traces.session_bundle',
    view: 'full',
    createdAt: '2026-01-01T01:00:00.000Z',
    provenance: {
      sessionId: 'synthetic',
      harness: 'claude-code',
      cwd: null,
      transcriptPath: join(bundleDir, 'session', 'transcript.jsonl'),
      transcriptSha256: createHash('sha256').update(files['session/transcript.jsonl'] ?? '').digest('hex'),
      contextRoot: null,
      tracesVersion: '0.0.0-test',
      sessionWindow: { firstSpanAt: null, lastSpanAt: null, padMs: 0 },
    },
    files: await Promise.all(
      (await listSessionBundleFiles(bundleDir)).map(async (path) => {
        const bytes = await readFile(join(bundleDir, path))
        return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      }),
    ),
    absent: [],
    excluded: [],
    ledgerSlices: [],
    knownLimits: [],
  }
  await writeSessionBundleManifest(bundleDir, manifest)
  return bundleDir
}

describe('evidence-only bundle view', () => {
  it('carries the counted artifacts, excludes every prose source by name, and names its own view', async () => {
    const { bundleDir, manifest: full } = await assembleFullBundle()

    // The bundle `traces bundle` writes says which view it is, and that it drops nothing.
    expect(full.schemaVersion).toBe(2)
    expect(full.view).toBe('full')
    expect(full.excluded).toEqual([])
    expect(full.projection).toBeUndefined()

    const outDir = newDir('view')
    const { manifest, leakCheck } = await projectSessionBundle({
      bundleDir,
      outDir,
      view: 'evidence-only',
      generatedAt: '2026-01-01T02:00:00.000Z',
    })

    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.view).toBe('evidence-only')
    expect(manifest.createdAt).toBe('2026-01-01T02:00:00.000Z')

    // What is on disk, and nothing else.
    const written = await listSessionBundleFiles(outDir)
    expect(written).toEqual([
      'derived/evidence.jsonl',
      'derived/session-index.json',
      'ledger/scorecard.json',
      'ledger/skill-runs.jsonl',
      'manifest.json',
    ])
    expect(manifest.files.map((file) => file.path)).toEqual(written.filter((path) => path !== 'manifest.json'))

    // The session's own words are gone, by name and by rule.
    const excludedByPath = new Map(manifest.excluded.map((entry) => [entry.path, entry] as const))
    expect(excludedByPath.get('session/transcript.jsonl')?.rule).toBe('session-source')
    expect(excludedByPath.get('session/subagents/agent-worker.jsonl')?.rule).toBe('session-source')
    expect(excludedByPath.get('derived/report.md')?.rule).toBe('session-text-derived')
    expect(excludedByPath.get('derived/trace.otlp.jsonl')?.rule).toBe('session-text-derived')
    expect(excludedByPath.get('ledger/progress.md')?.rule).toBe('authored-prose')
    expect(excludedByPath.get('ledger/handoff-2026-01-02-latest.md')?.rule).toBe('authored-prose')
    expect(excludedByPath.get('ledger/reflections/2026-01-01.md')?.rule).toBe('authored-prose')
    expect(excludedByPath.get('ledger/experiments.jsonl')?.rule).toBe('authored-prose')
    for (const entry of manifest.excluded) {
      expect(entry.reason.length).toBeGreaterThan(0)
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
    }

    // Every excluded hash is the full bundle's own hash for that file, so an
    // auditor can prove which bytes were dropped without holding them.
    const fullByPath = new Map(full.files.map((file) => [file.path, file] as const))
    for (const entry of manifest.excluded) {
      expect(entry.sha256).toBe(fullByPath.get(entry.path)!.sha256)
      expect(entry.bytes).toBe(fullByPath.get(entry.path)!.bytes)
    }
    // Carried bytes are the full bundle's bytes, unchanged.
    for (const file of manifest.files) expect(file.sha256).toBe(fullByPath.get(file.path)!.sha256)

    // The projection points back at exactly the bundle it came from.
    const sourceManifestBytes = await readFile(join(bundleDir, 'manifest.json'))
    expect(manifest.projection!.sourceDirectory).toBe(bundleDir)
    expect(manifest.projection!.sourceManifestSha256).toBe(
      createHash('sha256').update(sourceManifestBytes).digest('hex'),
    )
    expect(manifest.projection!.leakCheck).toEqual(leakCheck)
    expect(leakCheck.matches).toBe(0)
    expect(leakCheck.signatureWords).toBe(8)
    // Every path excluded by classification supplied signatures. A path
    // excluded BY the check cannot also be one of its sources.
    expect(leakCheck.comparedSources).toEqual(
      manifest.excluded.filter((entry) => entry.rule !== 'content-signature').map((entry) => entry.path),
    )
    expect(leakCheck.carried.map((entry) => entry.path)).toEqual([
      'derived/evidence.jsonl',
      'derived/session-index.json',
      'ledger/scorecard.json',
      'ledger/skill-runs.jsonl',
    ])
    for (const entry of leakCheck.carried) expect(entry.carries.length).toBeGreaterThan(0)

    // Ledger slices are narrowed to what survived, and the view states its own limits.
    expect(manifest.ledgerSlices.map((slice) => slice.path)).toEqual(['ledger/skill-runs.jsonl', 'ledger/scorecard.json'])
    expect(manifest.knownLimits).toEqual(expect.arrayContaining([...full.knownLimits]))
    expect(manifest.knownLimits.some((limit) => limit.includes('paraphrase-tight'))).toBe(true)
  })

  it('carries no content signature from any excluded source', async () => {
    const { bundleDir } = await assembleFullBundle()
    const outDir = newDir('view')
    const { manifest } = await projectSessionBundle({ bundleDir, outDir, view: 'evidence-only' })

    // The check the guarantee rests on, run over the view that was actually
    // written, against every file the view says it dropped.
    const report = await findSessionTextLeaks({
      viewDir: outDir,
      sourceDir: bundleDir,
      carriedPaths: (await listSessionBundleFiles(outDir)).filter((path) => path !== 'manifest.json'),
      excludedPaths: manifest.excluded.map((entry) => entry.path),
    })
    expect(report.leaks).toEqual([])
    expect(report.comparedSources.length).toBe(manifest.excluded.length)
    expect(report.sourceSignatures).toBeGreaterThan(0)

    // The same read the naive check makes, and the reason it is not enough on
    // its own: neither the sentence nor the authoring call survives anywhere.
    const viewText = (
      await Promise.all(
        (await listSessionBundleFiles(outDir)).map((path) => readFile(join(outDir, path), 'utf8')),
      )
    ).join('\n')
    expect(viewText).not.toContain(LEAKED_SENTENCE)
    expect(viewText).not.toContain(TRANSCRIPT_ONLY_SENTENCE)
    expect(viewText).not.toContain("cat > REPORT.md <<'EOF'")
  })

  it('drops an allow-listed ledger file whose own text repeats an excluded source', async () => {
    const { bundleDir } = await assembleFullBundle()
    const outDir = newDir('view')
    const { manifest } = await projectSessionBundle({ bundleDir, outDir, view: 'evidence-only' })

    const dropped = manifest.excluded.find((entry) => entry.path === 'ledger/current.json')!
    expect(dropped.rule).toBe('content-signature')
    expect(dropped.contentMatch!.signatures).toBeGreaterThan(0)
    expect(dropped.contentMatch!.sources).toContain('session/transcript.jsonl')
    // The record counts the overlap; it never quotes it, or the manifest would
    // carry the text the view removed.
    expect(JSON.stringify(dropped)).not.toContain(LEAKED_SENTENCE)
    expect(dropped.reason).toContain('content check')
  })

  it('refuses to write a view when a traces-derived artifact repeats session text', async () => {
    const bundleDir = await writeSyntheticBundle({
      'session/transcript.jsonl': `${JSON.stringify({ message: { content: LEAKED_SENTENCE } })}\n`,
      'derived/evidence.jsonl': `${JSON.stringify({ kind: 'traces.policy_evidence.session', note: LEAKED_SENTENCE })}\n`,
      'derived/report.md': '# report\n',
    })
    const outDir = newDir('view')

    await expect(projectSessionBundle({ bundleDir, outDir, view: 'evidence-only' })).rejects.toThrow(
      /derived\/evidence\.jsonl repeats \d+ 8-word run\(s\).*defect in the derivation/s,
    )
    // Nothing was written, so a caller cannot mistake a partial directory for a view.
    await expect(listSessionBundleFiles(outDir)).resolves.toEqual([])
  })

  it('drops a path nobody put on the allow-list', async () => {
    const bundleDir = await writeSyntheticBundle({
      'session/transcript.jsonl': `${JSON.stringify({ message: { content: 'hello' } })}\n`,
      'derived/session-index.json': `${JSON.stringify({ kind: 'traces.session_index' })}\n`,
      'derived/future-artifact.md': 'a section a later version of traces added\n',
    })
    const outDir = newDir('view')
    const { manifest } = await projectSessionBundle({ bundleDir, outDir, view: 'evidence-only' })

    const unknown = manifest.excluded.find((entry) => entry.path === 'derived/future-artifact.md')!
    expect(unknown.rule).toBe('not-allow-listed')
    expect(await listSessionBundleFiles(outDir)).toEqual(['derived/session-index.json', 'manifest.json'])
  })

  it('refuses a bundle whose bytes drifted from its manifest', async () => {
    const bundleDir = await writeSyntheticBundle({
      'session/transcript.jsonl': `${JSON.stringify({ message: { content: 'hello' } })}\n`,
      'derived/session-index.json': `${JSON.stringify({ kind: 'traces.session_index' })}\n`,
    })
    await writeFile(join(bundleDir, 'derived', 'session-index.json'), '{"kind":"tampered"}\n', 'utf8')

    await expect(
      projectSessionBundle({ bundleDir, outDir: newDir('view'), view: 'evidence-only' }),
    ).rejects.toThrow(/does not match its manifest hash/)
  })

  it('refuses a non-bundle directory, an older manifest, a view of a view, and an unknown view', async () => {
    const empty = newDir('empty')
    await mkdir(empty, { recursive: true })
    await expect(
      projectSessionBundle({ bundleDir: empty, outDir: newDir('view'), view: 'evidence-only' }),
    ).rejects.toThrow(/is not a traces session bundle/)

    const v1 = newDir('v1')
    await mkdir(v1, { recursive: true })
    await writeFile(
      join(v1, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, kind: 'traces.session_bundle' }),
      'utf8',
    )
    await expect(
      projectSessionBundle({ bundleDir: v1, outDir: newDir('view'), view: 'evidence-only' }),
    ).rejects.toThrow(/schemaVersion 1; this traces reads 2/)

    const { bundleDir } = await assembleFullBundle()
    const viewDir = newDir('view')
    await projectSessionBundle({ bundleDir, outDir: viewDir, view: 'evidence-only' })
    await expect(
      projectSessionBundle({ bundleDir: viewDir, outDir: newDir('view'), view: 'evidence-only' }),
    ).rejects.toThrow(/already the evidence-only view/)
    await expect(
      projectSessionBundle({ bundleDir, outDir: newDir('view'), view: 'full' }),
    ).rejects.toThrow(/unsupported bundle view "full"/)
    await expect(
      projectSessionBundle({ bundleDir, outDir: viewDir, view: 'evidence-only' }),
    ).rejects.toThrow(/is not empty/)
  })
})

describe('classifyEvidenceOnlyPath', () => {
  it('carries only the allow-list and denies everything else', () => {
    for (const path of [
      'derived/session-index.json',
      'derived/evidence.jsonl',
      'ledger/current.json',
      'ledger/scorecard.json',
      'ledger/skill-runs.jsonl',
    ]) {
      expect(classifyEvidenceOnlyPath(path)).toMatchObject({ carried: true })
    }
    expect(classifyEvidenceOnlyPath('session/transcript.jsonl')).toMatchObject({ carried: false, rule: 'session-source' })
    expect(classifyEvidenceOnlyPath('session/subagents/a.jsonl')).toMatchObject({ carried: false, rule: 'session-source' })
    expect(classifyEvidenceOnlyPath('derived/report.md')).toMatchObject({ carried: false, rule: 'session-text-derived' })
    expect(classifyEvidenceOnlyPath('derived/trace.otlp.jsonl')).toMatchObject({ carried: false, rule: 'session-text-derived' })
    expect(classifyEvidenceOnlyPath('ledger/progress.md')).toMatchObject({ carried: false, rule: 'authored-prose' })
    expect(classifyEvidenceOnlyPath('ledger/handoff-2026-01-01-x.md')).toMatchObject({ carried: false, rule: 'authored-prose' })
    expect(classifyEvidenceOnlyPath('ledger/reflections/2026-01-01.md')).toMatchObject({ carried: false, rule: 'authored-prose' })
    expect(classifyEvidenceOnlyPath('ledger/experiments.jsonl')).toMatchObject({ carried: false, rule: 'authored-prose' })
    expect(classifyEvidenceOnlyPath('repo/git-log.txt')).toMatchObject({ carried: false, rule: 'authored-prose' })
    expect(classifyEvidenceOnlyPath('derived/anything-new.json')).toMatchObject({ carried: false, rule: 'not-allow-listed' })
  })
})

describe('sessionTextSignatures', () => {
  it('signs prose and ignores identifiers, structure, and package constants', () => {
    expect([...sessionTextSignatures(LEAKED_SENTENCE)].length).toBeGreaterThan(0)

    // A shared session path is the same identifier on both sides, not shared prose.
    const path = '/home/u/.claude/projects/-home-u-code-app/2f1c9d40-1111-2222-3333-444455556666.jsonl'
    expect(sessionTextSignatures(path).size).toBe(0)

    // A counted artifact's key/number structure is not a sentence.
    const counted = JSON.stringify({
      tokenUsage: { input: { n: 0, mean: null, p50: null, p95: null, stddev: null, min: null, max: null } },
    })
    expect(sessionTextSignatures(counted).size).toBe(0)

    // A JSON line signs its VALUES, so a field name can never collide with prose.
    const row = JSON.stringify({ decision: LEAKED_SENTENCE })
    expect([...sessionTextSignatures(row)]).toEqual([...sessionTextSignatures(LEAKED_SENTENCE)])

    // Signatures never span a line boundary: ten words on one line sign, the
    // same ten words split across two lines of five do not.
    const ten = 'the queue depth decides tail latency far more than the'
    expect(sessionTextSignatures(ten).size).toBeGreaterThan(0)
    expect(sessionTextSignatures(ten.split(' ').slice(0, 5).join(' ') + '\n' + ten.split(' ').slice(5).join(' ')).size).toBe(0)
  })
})
