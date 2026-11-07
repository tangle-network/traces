/** Runtime durable capture APIs → existing native fold → user-facing facts, without raw fixture copies. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileResultBlobStore, FileSpawnJournal, contentAddress, persistHarnessTranscript, type HarnessTranscriptBinding, type ProfileMaterializationReceipt } from '@tangle-network/agent-runtime/kernel'
import { expect, it } from 'vitest'
import { readRefSpans } from '../src/refs.js'
import { computeSessionFacts } from '../src/session-facts.js'
import { serializeSpans, span } from '../src/otlp.js'
import { codexRollout } from './fixtures/home.js'
import { runCli } from './run-cli.js'

const digest = (value: unknown): `sha256:${string}` => contentAddress(value) as `sha256:${string}`

it('selects bound native records over Bridge requests, deduplicates reentry, and refuses missing or mismatched evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'traces-runtime-capture-'))
  const root = 'capture-run', nativeSessionId = '0199f00d-cccc-7ccc-8ccc-ccccdec0de99'
  const at = '2026-10-17T10:00:00.000Z'
  const text = codexRollout(nativeSessionId, '/PRIVATE_CWD', 0, 'PRIVATE_PROMPT')
  const blobs = new FileResultBlobStore(join(dir, 'blobs'))
  const journal = new FileSpawnJournal(join(dir, 'spawn-journal.jsonl'))
  const bindings: HarnessTranscriptBinding[] = []
  const identity = { profileDigest: digest({ fixture: 'authored-profile' }), taskDigest: digest({ fixture: 'task' }) }
  const materialization = (binding: HarnessTranscriptBinding): ProfileMaterializationReceipt => ({
    status: 'known', authoredProfileDigest: identity.profileDigest, effectiveProfileDigest: binding.profileDigest as `sha256:${string}`,
    materializationPlanDigest: digest({ fixture: 'plan' }), runtime: 'cli', backend: 'bridge',
    model: { status: 'unknown', reason: 'fixture-unreported' },
    execution: { kind: 'session', id: binding.sessionId }, materializer: 'cli-bridge-agent-profile',
  })
  const appendMetadata = async (store: FileSpawnJournal, binding: HarnessTranscriptBinding, seq: number) => {
    const node = binding.node!, receipt = materialization(binding)
    await store.appendEvent(root, { kind: 'spawned', id: node.nodeId, parent: root, attemptId: node.attemptId, identity, label: 'worker', runtime: 'cli', budget: {}, seq, at })
    await store.appendEvent(root, { kind: 'materialized', id: node.nodeId, receipt, seq: seq + 1, at })
    await store.appendEvent(root, { kind: 'execution-bound', id: node.nodeId, binding: { status: 'known', attemptId: node.attemptId, materializationReceiptDigest: digest(receipt), bindingDigest: digest({ fixture: node.attemptId }), descriptor: { kind: 'bridge-session' } }, seq: seq + 2, at })
  }
  try {
    await journal.beginTree(root, at)
    await journal.appendEvent(root, { kind: 'spawned', id: root, label: 'root', runtime: 'cli', budget: {}, seq: 0, at })
    for (const [index, content] of [text, text + '\n'].entries()) {
      const id = `${root}:s${index}`
      const binding: HarnessTranscriptBinding = {
        kind: 'bridge', sessionId: 'bridge-session', nativeSessionId, profileDigest: `sha256:${'a'.repeat(64)}`,
        runs: [{ runId: `request-${index}`, requestDigest: `sha256:${'b'.repeat(64)}` }],
        node: { rootId: root, parentId: root, nodeId: id, attemptId: `${id}:attempt`, depth: 1, identity },
      }
      bindings.push(binding)
      const receipt = await persistHarnessTranscript({
        status: 'captured', fileCount: 1, totalBytes: Buffer.byteLength(content), skippedCount: 0, coverageComplete: true,
        artifact: { schemaVersion: 1, harness: 'codex', binding, files: [{ path: 'sessions/rollout.jsonl', content, bytes: Buffer.byteLength(content) }], skipped: [] },
      }, blobs)
      await appendMetadata(journal, binding, index * 4 + 1)
      await journal.appendEvent(root, { kind: 'settled', id, status: 'done', harnessTranscript: receipt, spent: { tokens: { input: 999, output: 999 }, usd: 0, ms: 0 }, seq: index * 4 + 4, at })
    }
    // The baseline CLI selects these parentless request summaries and refuses zero record spans.
    await writeFile(join(dir, 'bridge.otlp.jsonl'), serializeSpans([span({
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'bridge.request', kind: 'LLM', startTime: at, inputTokens: 999, outputTokens: 999,
    })]))
    const spans = await readRefSpans(dir)
    const facts = computeSessionFacts(spans)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.recordSpans).toBeGreaterThan(0)
    expect(facts[0]?.toolCalls.value).toBe(1)
    expect(facts[0]?.tokens.input).toBeNull() // Neither request usage nor journal spend fills an unmeasured native channel.
    expect(new Set(spans.map((item) => `${item.trace_id}:${item.span_id}`)).size).toBe(spans.length)
    expect(JSON.parse(String(spans[0]?.attributes['traces.runtime.capture_bindings']))).toEqual(bindings.map(({ node, ...binding }) => ({ ...binding, node: { rootId: node!.rootId, parentId: node!.parentId, nodeId: node!.nodeId, attemptId: node!.attemptId } })))
    expect(JSON.parse(String(spans[0]?.attributes['traces.runtime.capture_refs']))).toHaveLength(2)
    const result = await runCli(['facts', dir, '--format', 'json', '--no-content'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).not.toMatch(/PRIVATE_|pnpm test|rollout.jsonl/)
    expect(JSON.parse(result.stdout)).toMatchObject({ contentIncluded: false, sessions: [{ sessionId: nativeSessionId, toolCalls: { value: 1 } }] })
    // A capture claims bytes, so losing them is an error, never permission to use request-only spans.
    await rm(join(dir, 'blobs'), { recursive: true })
    const missing = await runCli(['facts', dir, '--format', 'json', '--no-content'])
    expect(missing.code).toBe(2)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toContain('transcript artifact')
    const valid = bindings[0]!
    const cases = [
      { binding: { ...valid, node: { ...valid.node!, rootId: 'another-run' } }, coverage: true, reason: 'exact node/session/request binding' },
      { binding: valid, coverage: undefined, reason: 'capture is incomplete' },
      { binding: valid, coverage: false, reason: 'capture is incomplete' },
      { binding: { ...valid, profileDigest: 'invalid' }, coverage: true, reason: 'Native capture binding is incomplete' },
      { binding: { ...valid, runs: [{ runId: 'request', requestDigest: 'invalid' }] }, coverage: true, reason: 'Native capture binding is incomplete' },
      { binding: { ...valid, nativeSessionId: 'another-session' }, coverage: true, reason: 'exact native session' },
      { binding: { ...valid, node: { ...valid.node!, attemptId: 'another:valid:attempt' } }, coverage: true, reason: 'attempt disagrees with journal' },
      { binding: { ...valid, profileDigest: digest({ fixture: 'another-effective-profile' }) }, coverage: true, reason: 'effective profile disagrees with journal' },
      { binding: { ...valid, node: { ...valid.node!, identity: { ...identity, profileDigest: digest({ fixture: 'another-authored-profile' }) } } }, coverage: true, reason: 'authored identity disagrees with journal' },
    ]
    for (const negative of cases) {
      await rm(join(dir, 'spawn-journal.jsonl'))
      const negativeJournal = new FileSpawnJournal(join(dir, 'spawn-journal.jsonl'))
      await negativeJournal.beginTree(root, at)
      await negativeJournal.appendEvent(root, { kind: 'spawned', id: root, label: 'root', runtime: 'cli', budget: {}, seq: 0, at })
      await appendMetadata(negativeJournal, valid, 1)
      const receipt = await persistHarnessTranscript({
        status: 'captured', fileCount: 1, totalBytes: Buffer.byteLength(text), skippedCount: 0, coverageComplete: negative.coverage,
        artifact: { schemaVersion: 1, harness: 'codex', binding: negative.binding, files: [{ path: 'sessions/rollout.jsonl', content: text, bytes: Buffer.byteLength(text) }], skipped: [] },
      }, blobs)
      await negativeJournal.appendEvent(root, { kind: 'settled', id: valid.node!.nodeId, status: 'done', harnessTranscript: receipt, spent: { tokens: { input: 0, output: 0 }, usd: 0, ms: 0 }, seq: 4, at })
      const refused = await runCli(['facts', dir, '--format', 'json', '--no-content'])
      expect(refused.code, refused.stderr).toBe(2)
      expect(refused.stdout).toBe('')
      expect(refused.stderr).toContain(negative.reason)
    }
    // With no capture at all, the existing zero-record refusal remains in force.
    await rm(join(dir, 'spawn-journal.jsonl'))
    await new FileSpawnJournal(join(dir, 'spawn-journal.jsonl')).beginTree(root, at)
    const noCapture = await runCli(['facts', dir, '--format', 'json', '--no-content'])
    expect(noCapture.code).toBe(2)
    expect(noCapture.stderr).toContain('no records could be read')
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 60_000)
