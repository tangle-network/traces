import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import { assembleSessionBundle, type SessionBundleManifest } from '../src/bundle.js'
import type { SessionRef } from '../src/types.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-bundle-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let outSeq = 0
function newOutDir(): string {
  outSeq += 1
  return join(dir, `out-${outSeq}`)
}

function refFor(path: string, cwd: string | null = null): SessionRef {
  return {
    harness: 'claude-code',
    sessionId: 'bundle-fixture',
    path,
    cwd,
    mtimeMs: Date.parse('2026-01-01T00:00:05Z'),
  }
}

/** Root transcript with one Agent tool call — the shape the Claude store writes. */
function writeTranscript(path: string): void {
  writeFileSync(
    path,
    [
      {
        type: 'user',
        uuid: 'root-user',
        sessionId: 'bundle-fixture',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'BUNDLE ROOT TASK' },
      },
      {
        type: 'assistant',
        uuid: 'root-assistant',
        sessionId: 'bundle-fixture',
        timestamp: '2026-01-01T00:00:01Z',
        message: {
          id: 'root-message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-one', name: 'Agent', input: {} }],
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n'),
  )
}

function writeChild(subDir: string, id: string, toolUseId: string, timestamp: string): void {
  mkdirSync(subDir, { recursive: true })
  writeFileSync(
    join(subDir, `agent-${id}.jsonl`),
    [
      {
        type: 'user',
        uuid: `${id}-user`,
        timestamp,
        isSidechain: true,
        message: { role: 'user', content: `${id} TASK` },
      },
      {
        type: 'assistant',
        uuid: `${id}-assistant`,
        timestamp: new Date(Date.parse(timestamp) + 1_000).toISOString(),
        message: { id: `${id}-message`, role: 'assistant', content: `${id} ANSWER` },
      },
    ].map((event) => JSON.stringify(event)).join('\n'),
  )
  writeFileSync(
    join(subDir, `agent-${id}.meta.json`),
    JSON.stringify({ agentType: 'worker', toolUseId }),
  )
}

/** A context root carrying the live `.evolve` convention: flat handoffs, progress.md, jsonl ledgers. */
async function writeEvolveFixture(root: string): Promise<void> {
  const evolve = join(root, '.evolve')
  await mkdir(join(evolve, 'reflections'), { recursive: true })
  await writeFile(
    join(evolve, 'experiments.jsonl'),
    [
      JSON.stringify({ ts: '2026-01-01T00:00:03Z', round: 1, verdict: 'KEEP' }),
      JSON.stringify({ ts: '2026-03-01T00:00:00Z', round: 2, verdict: 'DROP' }),
      JSON.stringify({ note: 'row without ts' }),
      'not-json',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    join(evolve, 'skill-runs.jsonl'),
    `${JSON.stringify({ skill: '/verify', ts: '2026-01-01T00:00:04Z' })}\n`,
    'utf8',
  )
  await writeFile(join(evolve, 'current.json'), '{"focus":"bundle"}\n', 'utf8')
  await writeFile(join(evolve, 'scorecard.json'), '{"score":1}\n', 'utf8')
  await writeFile(join(evolve, 'progress.md'), '# Progress\n\n2026-01-01: bundled.\n', 'utf8')
  await writeFile(join(evolve, 'handoff-2026-01-01-first.md'), '# Handoff first\n', 'utf8')
  await writeFile(join(evolve, 'handoff-2026-01-02-latest.md'), '# Handoff latest\n', 'utf8')
  await writeFile(join(evolve, 'reflections', '2026-01-01.md'), '# In-window reflection\n', 'utf8')
  await writeFile(join(evolve, 'reflections', '2026-03-05.md'), '# Out-of-window reflection\n', 'utf8')
  await writeFile(join(evolve, 'reflections', 'notes.md'), '# Undated notes\n', 'utf8')
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fileEntry(manifest: SessionBundleManifest, path: string) {
  return manifest.files.find((file) => file.path === path)
}

describe('assembleSessionBundle', () => {
  it('assembles transcript, subagents, derived artifacts, ledger slices, and a sha256 manifest', async () => {
    const ctxRoot = join(dir, 'ctx-full')
    await mkdir(ctxRoot, { recursive: true })
    await writeEvolveFixture(ctxRoot)
    const transcript = join(dir, 'full-session.jsonl')
    writeTranscript(transcript)
    writeChild(join(dir, 'full-session', 'subagents'), 'worker-a', 'call-one', '2026-01-01T00:00:02Z')

    const outDir = newOutDir()
    const { manifest, manifestPath, directory } = await assembleSessionBundle({
      adapter: new ClaudeAdapter(),
      ref: refFor(transcript, ctxRoot),
      outDir,
      generatedAt: '2026-01-01T01:00:00.000Z',
    })

    expect(directory).toBe(outDir)
    expect(manifest.kind).toBe('traces.session_bundle')
    expect(manifest.schemaVersion).toBe(2)
    // `traces bundle` assembles the auditor's copy, and says so: a reader
    // never has to infer which view a directory is from its file list.
    expect(manifest.view).toBe('full')
    expect(manifest.excluded).toEqual([])
    expect(manifest.projection).toBeUndefined()
    expect(manifest.createdAt).toBe('2026-01-01T01:00:00.000Z')
    expect(manifest.provenance.sessionId).toBe('bundle-fixture')
    expect(manifest.provenance.harness).toBe('claude-code')
    expect(manifest.provenance.cwd).toBe(ctxRoot)
    expect(manifest.provenance.contextRoot).toBe(ctxRoot)
    expect(manifest.provenance.transcriptPath).toBe(transcript)
    expect(manifest.provenance.sessionWindow.firstSpanAt).toBe('2026-01-01T00:00:00Z')

    // The transcript is copied byte-for-byte and its hash is the provenance anchor.
    const copied = await readFile(join(outDir, 'session', 'transcript.jsonl'))
    expect(sha256Hex(copied)).toBe(manifest.provenance.transcriptSha256)
    expect(copied.equals(await readFile(transcript))).toBe(true)

    // The subagents directory is copied verbatim, meta files included.
    expect(fileEntry(manifest, 'session/subagents/agent-worker-a.jsonl')).toBeDefined()
    expect(fileEntry(manifest, 'session/subagents/agent-worker-a.meta.json')).toBeDefined()

    // Derived artifacts exist and parse.
    const index = JSON.parse(await readFile(join(outDir, 'derived', 'session-index.json'), 'utf8'))
    expect(index.kind).toBe('traces.session_index')
    expect(index.totals.sessions).toBe(1)
    // The index context join sees the flat handoffs and progress.md of the live convention.
    const contextPaths = index.context.roots[0].files.map((file: { path: string }) => file.path)
    expect(contextPaths.some((p: string) => p.endsWith('handoff-2026-01-02-latest.md'))).toBe(true)
    expect(contextPaths.some((p: string) => p.endsWith('progress.md'))).toBe(true)
    expect(contextPaths.some((p: string) => p.endsWith('current.json'))).toBe(true)

    const evidenceRows = (await readFile(join(outDir, 'derived', 'evidence.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
    expect(evidenceRows).toHaveLength(1)
    expect(evidenceRows[0].kind).toBe('traces.policy_evidence.session')
    expect(evidenceRows[0].provenance.sourceSha256).toBe(manifest.provenance.transcriptSha256)
    expect(evidenceRows[0].provenance.otlpPath).toBe('derived/trace.otlp.jsonl')

    const report = await readFile(join(outDir, 'derived', 'report.md'), 'utf8')
    expect(report.length).toBeGreaterThan(0)
    expect(report).toContain('BUNDLE ROOT TASK')

    const otlpLines = (await readFile(join(outDir, 'derived', 'trace.otlp.jsonl'), 'utf8')).trim().split('\n')
    expect(otlpLines.length).toBeGreaterThan(0)
    for (const line of otlpLines) expect(() => JSON.parse(line)).not.toThrow()

    // Ledger jsonl slices keep only session-window rows, verbatim, with full counts.
    const experiments = manifest.ledgerSlices.find((slice) => slice.path === 'ledger/experiments.jsonl')
    expect(experiments).toMatchObject({
      rule: 'session-window-rows',
      totalRows: 4,
      keptRows: 1,
      unparseableTsRows: 2,
    })
    const keptRows = (await readFile(join(outDir, 'ledger', 'experiments.jsonl'), 'utf8')).trim().split('\n')
    expect(keptRows).toEqual([JSON.stringify({ ts: '2026-01-01T00:00:03Z', round: 1, verdict: 'KEEP' })])
    expect(manifest.ledgerSlices.find((slice) => slice.path === 'ledger/skill-runs.jsonl')).toMatchObject({
      rule: 'session-window-rows',
      totalRows: 1,
      keptRows: 1,
      unparseableTsRows: 0,
    })

    // Whole-copies, the lexically-latest flat handoff, and only the in-window reflection.
    for (const name of ['current.json', 'scorecard.json', 'progress.md']) {
      expect(manifest.ledgerSlices.find((slice) => slice.path === `ledger/${name}`)).toMatchObject({ rule: 'copied-whole' })
    }
    expect(fileEntry(manifest, 'ledger/handoff-2026-01-02-latest.md')).toBeDefined()
    expect(fileEntry(manifest, 'ledger/handoff-2026-01-01-first.md')).toBeUndefined()
    expect(fileEntry(manifest, 'ledger/reflections/2026-01-01.md')).toBeDefined()
    expect(fileEntry(manifest, 'ledger/reflections/2026-03-05.md')).toBeUndefined()
    expect(fileEntry(manifest, 'ledger/reflections/notes.md')).toBeUndefined()

    // No git repo at the context root → git log is a recorded absence, not an error.
    expect(manifest.absent.some((entry) => entry.path === 'repo/git-log.txt')).toBe(true)

    // Every file on disk (manifest.json aside) is hashed in the manifest, and the hashes are real.
    const manifestNames = new Set(manifest.files.map((file) => file.path))
    const walk = async (sub: string): Promise<string[]> => {
      const entries = await readdir(join(outDir, sub), { withFileTypes: true })
      const out: string[] = []
      for (const entry of entries) {
        const rel = sub ? `${sub}/${entry.name}` : entry.name
        if (entry.isDirectory()) out.push(...(await walk(rel)))
        else out.push(rel)
      }
      return out
    }
    for (const rel of await walk('')) {
      if (rel === 'manifest.json') continue
      expect(manifestNames.has(rel)).toBe(true)
    }
    const experimentsEntry = fileEntry(manifest, 'ledger/experiments.jsonl')!
    const experimentsBytes = await readFile(join(outDir, 'ledger', 'experiments.jsonl'))
    expect(experimentsEntry.sha256).toBe(sha256Hex(experimentsBytes))
    expect(experimentsEntry.bytes).toBe(experimentsBytes.length)

    expect(manifest.knownLimits.length).toBeGreaterThan(0)
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).kind).toBe('traces.session_bundle')
  })

  it('records an absent subagents directory instead of failing', async () => {
    const transcript = join(dir, 'no-subagents.jsonl')
    writeTranscript(transcript)

    const { manifest } = await assembleSessionBundle({
      adapter: new ClaudeAdapter(),
      ref: refFor(transcript),
      outDir: newOutDir(),
    })

    const absence = manifest.absent.find((entry) => entry.path === 'session/subagents')
    expect(absence).toBeDefined()
    expect(absence!.reason).toContain('no subagents directory')
    // No context root reachable from a null cwd → the whole ledger is one recorded absence.
    expect(manifest.absent.some((entry) => entry.path === 'ledger')).toBe(true)
    expect(fileEntry(manifest, 'session/transcript.jsonl')).toBeDefined()
  })

  it('fails loud when the transcript is missing', async () => {
    await expect(assembleSessionBundle({
      adapter: new ClaudeAdapter(),
      ref: refFor(join(dir, 'does-not-exist.jsonl')),
      outDir: newOutDir(),
    })).rejects.toThrow(/session transcript not found/)
  })

  it('refuses a non-empty output directory', async () => {
    const transcript = join(dir, 'occupied-out.jsonl')
    writeTranscript(transcript)
    const outDir = newOutDir()
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, 'already-here.txt'), 'x', 'utf8')

    await expect(assembleSessionBundle({
      adapter: new ClaudeAdapter(),
      ref: refFor(transcript),
      outDir,
    })).rejects.toThrow(/is not empty/)
  })
})
