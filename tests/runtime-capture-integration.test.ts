/** Runtime durable capture APIs → existing native fold → user-facing facts, without raw fixture copies. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileResultBlobStore, FileSpawnJournal, contentAddress, persistHarnessTranscript, type HarnessTranscriptBinding, type ProfileMaterializationReceipt } from '@tangle-network/agent-runtime/kernel'
import { expect, it } from 'vitest'
import { readRefSpans } from '../src/refs.js'
import { buildSessionFactsReport, computeSessionFacts } from '../src/session-facts.js'
import { SESSION_TOTAL_INPUT_ATTR } from '../src/attributes.js'
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
    model: { status: 'unknown', reason: 'fixture-unreported' }, resources: { status: 'unknown', reason: 'fixture-unreported' },
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
      await journal.appendEvent(root, { kind: 'settled', id, status: 'done', harnessTranscript: receipt, spent: { tokens: { input: 999, output: 999 }, usd: 0, ms: 0, iterations: 0 }, seq: index * 4 + 4, at })
      if (index === 0) {
        const one = await runCli(['facts', dir, '--format', 'json', '--no-content'])
        expect(one.code, one.stderr).toBe(0)
        expect(JSON.parse(one.stdout)).toMatchObject({
          sessions: [expect.objectContaining({ sessionId: nativeSessionId })],
          selection: { unreadSessions: [expect.objectContaining({ reason: expect.stringContaining('no record could be read') })] },
        })
      }
    }
    await writeFile(join(dir, 'bridge.otlp.jsonl'), serializeSpans([span({
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'bridge.request', kind: 'LLM', startTime: at, inputTokens: 999, outputTokens: 999,
    })]))
    const spans = await readRefSpans(dir)
    const facts = computeSessionFacts(spans)
    const native = facts.find((fact) => fact.sessionId === nativeSessionId)
    expect(native?.recordSpans).toBeGreaterThan(0)
    expect(native?.toolCalls.value).toBe(1)
    expect(native?.tokens.input).toBeNull() // Neither request usage nor journal spend fills an unmeasured native channel.
    const shared = spans.filter((item) => item.name === 'runtime.agent')
    expect(shared.map((item) => item.attributes['traces.runtime.node_id']).sort()).toEqual([root, ...bindings.map((binding) => binding.node!.nodeId)].sort())
    expect(shared.every((item) => item.attributes[SESSION_TOTAL_INPUT_ATTR] === undefined)).toBe(true)
    expect(new Set(spans.map((item) => `${item.trace_id}:${item.span_id}`)).size).toBe(spans.length)
    expect(JSON.parse(String(spans[0]?.attributes['traces.runtime.capture_bindings']))).toEqual(bindings.map(({ node, ...binding }) => ({ ...binding, node: { rootId: node!.rootId, parentId: node!.parentId, nodeId: node!.nodeId, attemptId: node!.attemptId } })))
    expect(JSON.parse(String(spans[0]?.attributes['traces.runtime.capture_refs']))).toHaveLength(2)
    const result = await runCli(['facts', dir, '--format', 'json', '--no-content'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).not.toMatch(/PRIVATE_|pnpm test|rollout.jsonl/)
    expect(JSON.parse(result.stdout)).toMatchObject({ contentIncluded: false, sessions: expect.arrayContaining([
      expect.objectContaining({ sessionId: nativeSessionId, toolCalls: expect.objectContaining({ value: 1 }) }),
    ]) })
    // An uncaptured sibling's rooted OTLP subtree and a journal-only sibling survive alongside the bound session.
    const spend = (input: number) => ({ tokens: { input, output: 1 }, usd: 0, ms: 1, iterations: 0 })
    let seq = 9
    for (const [id, input] of [['retained-sibling', 444], ['journal-sibling', 5]] as const) {
      await journal.appendEvent(root, { kind: 'spawned', id, parent: root, label: id, runtime: 'cli', budget: {}, at, seq: seq++ })
      await journal.appendEvent(root, { kind: 'metered', id, spend: spend(input), at, seq: seq++ })
    }
    const traceId = '1'.repeat(32)
    const retained = span({ traceId, spanId: '1'.repeat(16), name: 'sibling', kind: 'AGENT', startTime: at,
      extra: { 'tangle.run.id': root, 'tangle.node.id': 'retained-sibling', 'session.id': 'retained-session' } })
    await writeFile(join(dir, 'team.otlp.jsonl'), serializeSpans([
      retained,
      span({ traceId, spanId: '2'.repeat(16), parentSpanId: retained.span_id, name: 'provider.call', kind: 'LLM', startTime: at, inputTokens: 7, outputTokens: 3 }),
      span({ traceId, spanId: '3'.repeat(16), name: 'covered-request', kind: 'LLM', startTime: at, inputTokens: 888, extra: { 'cli_bridge.run.id': 'request-0' } }),
    ]))
    const combined = await readRefSpans(dir)
    expect(combined.some((item) => item.name === 'covered-request' || item.name === 'bridge.request')).toBe(false)
    const journalOnly = combined.filter((item) => item.name === 'runtime.agent')
    expect(journalOnly.map((item) => item.attributes['traces.runtime.node_id']).sort()).toEqual(['journal-sibling', root, ...bindings.map((binding) => binding.node!.nodeId)].sort())
    expect(journalOnly.find((item) => item.attributes['traces.runtime.node_id'] === 'journal-sibling')?.attributes[SESSION_TOTAL_INPUT_ATTR]).toBe(5)
    const combinedFacts = await runCli(['facts', dir, '--format', 'json', '--no-content'])
    expect(combinedFacts.code, combinedFacts.stderr).toBe(0)
    expect(JSON.parse(combinedFacts.stdout).sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: nativeSessionId, toolCalls: expect.objectContaining({ value: 1 }) }),
      expect.objectContaining({ sessionId: 'retained-session', tokens: expect.objectContaining({ input: 7, output: 3 }) }),
      expect.objectContaining({ tokens: expect.objectContaining({ input: 5, output: 1 }) }),
    ]))
    const sdkFacts = buildSessionFactsReport(combined)
    const file = join(dir, 'compare.otlp.jsonl')
    const converted = await runCli(['convert', dir, '--no-content', '--out', file])
    expect(converted.code, converted.stderr).toBe(0)
    const reopened = await runCli(['facts', file, '--format', 'json'])
    expect(reopened.code, reopened.stderr).toBe(0)
    await rm(file)
    for (const report of [JSON.parse(combinedFacts.stdout), JSON.parse(reopened.stdout)]) {
      expect(report.sessions.map((sheet: { tokens: object }) => sheet.tokens)).toEqual(sdkFacts.sessions.map(sheet => sheet.tokens))
      expect(report.selection?.unreadSessions).toEqual(sdkFacts.selection?.unreadSessions)
    }
    const unknowns = JSON.parse(String(combined[0]!.attributes['traces.source.unknowns'])) as string[]
    expect(unknowns).toEqual(expect.arrayContaining([
      expect.stringContaining('Bound native captures supersede 1 of 4 retained OTLP spans'),
      expect.stringContaining('Ownership is ambiguous for 1 of 4 retained OTLP spans'),
    ]))
    const separate = span({ traceId: '3'.repeat(32), spanId: '4'.repeat(16), name: 'independent-session', kind: 'LLM', startTime: at,
      inputTokens: 9, extra: { 'cli_bridge.backend.session_id': 'another-native-session' } })
    const separateFile = join(dir, 'independent.otlp.jsonl')
    await writeFile(separateFile, serializeSpans([separate]))
    const unplaced = await readRefSpans(dir)
    expect(unplaced.some((item) => item.span_id === separate.span_id)).toBe(true)
    const unmatchedMeter = unplaced.find((item) => item.attributes['traces.runtime.node_id'] === 'journal-sibling')
    expect(unmatchedMeter).toBeDefined()
    expect(unmatchedMeter!.attributes[SESSION_TOTAL_INPUT_ATTR]).toBeUndefined()
    await journal.appendEvent(root, { kind: 'spawned', id: 'bound-meter', parent: root, label: 'worker', runtime: 'cli', budget: {}, at, seq: seq++ })
    await journal.appendEvent(root, { kind: 'materialized', id: 'bound-meter', receipt: materialization({ ...bindings[0]!, sessionId: 'meter-bridge' }), at, seq: seq++ })
    await journal.appendEvent(root, { kind: 'metered', id: 'bound-meter', spend: spend(13), at, seq: seq++ })
    await writeFile(separateFile, serializeSpans([{ ...separate, attributes: { ...separate.attributes, 'cli_bridge.session.id': 'other-bridge' } }]))
    const disjoint = await readRefSpans(dir)
    expect(disjoint.find((item) => item.attributes['traces.runtime.node_id'] === 'bound-meter')?.attributes[SESSION_TOTAL_INPUT_ATTR]).toBe(13)
    expect(disjoint.find((item) => item.attributes['traces.runtime.node_id'] === 'journal-sibling')?.attributes[SESSION_TOTAL_INPUT_ATTR]).toBeUndefined()
    await rm(separateFile)
    await rm(join(dir, 'team.otlp.jsonl'))
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
      await negativeJournal.appendEvent(root, { kind: 'settled', id: valid.node!.nodeId, status: 'done', harnessTranscript: receipt, spent: { tokens: { input: 0, output: 0 }, usd: 0, ms: 0, iterations: 0 }, seq: 4, at })
      await expect(readRefSpans(dir)).rejects.toThrow(negative.reason)
    }
    // With no capture at all, the existing zero-record refusal remains in force.
    await rm(join(dir, 'spawn-journal.jsonl'))
    await new FileSpawnJournal(join(dir, 'spawn-journal.jsonl')).beginTree(root, at)
    const noCapture = await runCli(['facts', dir, '--format', 'json', '--no-content'])
    expect(noCapture.code).toBe(2)
    expect(noCapture.stderr).toContain('no records could be read')
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 60_000)

it('reports a single journal child’s exclusive meter when retained OTLP covers its parent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'traces-orphan-meter-'))
  const root = 'retained-root', child = 'journal-child', at = '2026-10-17T10:00:00.000Z'
  try {
    const journal = new FileSpawnJournal(join(dir, 'spawn-journal.jsonl'))
    await journal.beginTree(root, at)
    await journal.appendEvent(root, { kind: 'spawned', id: root, label: root, runtime: 'cli', budget: {}, at, seq: 0 })
    await journal.appendEvent(root, { kind: 'spawned', id: child, parent: root, label: child, runtime: 'cli', budget: {}, at, seq: 1 })
    await journal.appendEvent(root, { kind: 'metered', id: child, spend: { tokens: { input: 5, output: 1 }, usd: 0, ms: 1, iterations: 0 }, at, seq: 2 })
    const otlp = span({ traceId: '8'.repeat(32), spanId: '7'.repeat(16), kind: 'AGENT', name: root, startTime: at,
      extra: { 'tangle.run.id': root, 'tangle.node.id': root } })
    await writeFile(join(dir, 'retained.otlp.jsonl'), serializeSpans([
      otlp,
      span({ traceId: otlp.trace_id, spanId: '6'.repeat(16), parentSpanId: otlp.span_id, kind: 'LLM', name: 'call', startTime: at, inputTokens: 7, outputTokens: 3 }),
    ]))
    const result = await runCli(['facts', dir, '--format', 'json', '--no-content'])
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).sessions.map((sheet: { tokens: { input: number; output: number } }) =>
      [sheet.tokens.input, sheet.tokens.output])).toEqual([[7, 3], [5, 1]])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
