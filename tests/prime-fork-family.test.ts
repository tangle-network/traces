import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionInput, toOtlpSpans } from '@tangle-network/harness-sessions'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { isInheritedSpan, isRecordedToolCall } from '../src/adapters/provenance.js'
import { behaviorFromSpans } from '../src/behavior.js'
import { readOtlpInput } from '../src/otlp-input.js'
import { type OtlpSpan, writeOtlpFile } from '../src/otlp.js'
import { resolveAdapter } from '../src/registry.js'
import { buildSpanRunTree } from '../src/run-span-tree.js'
import { buildSessionFactsReport, computeSessionFacts, readSessionIndex } from '../src/session-facts.js'
import { parseSession } from '../src/session-source.js'
import { collectSessionWorkflow } from '../src/session-workflow.js'

const parentId = '019b76da-a800-7000-8000-000000000001'
const forkId = '019b76da-bf70-7000-8000-000000000002'
const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString()
const header = (id: string, time: number) => ({ type: 'session', version: 3, rlmDepth: 0, id, timestamp: at(time), cwd: '/workspace' })
const nativeMessage = (id: string, parentId: string | null, time: number, message: Record<string, unknown>) =>
  ({ type: 'message', id, parentId, timestamp: at(time), message: { ...message, timestamp: Date.parse(at(time)) } })
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const answer = (text: string, input: number) => ({
  role: 'assistant', model: 'local', stopReason: 'stop', content: [{ type: 'text', text }],
  usage: { input, output: 2, cacheRead: 0, cacheWrite: 0 },
})

const parentMessages = [
  { type: 'model_change', id: '0000a000', parentId: null, timestamp: at(0), modelId: 'local', provider: 'local' },
  nativeMessage('0000a001', '0000a000', 1, user('Measure the original sample.')),
  nativeMessage('0000a002', '0000a001', 2, {
    ...answer('', 5), stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'call-read-original', name: 'read', arguments: { path: 'sample.txt' } }],
  }),
  nativeMessage('0000a003', '0000a002', 3, { role: 'toolResult', toolName: 'read', toolCallId: 'call-read-original', isError: false, content: [{ type: 'text', text: '4' }] }),
  nativeMessage('0000a004', '0000a003', 4, answer('The original sample contains four items.', 7)),
]
const forkHeader = { ...header(forkId, 6), parentSession: '/previous/device/sessions/' + parentId + '.jsonl' }
const ownPrompt = nativeMessage('0000b001', '0000a004', 6, user('Describe a different sample.'))
const ownReply = nativeMessage('0000b002', '0000b001', 7, answer('The second sample is empty.', 11))
let folder: string
let parent: OtlpSpan[]
let fork: OtlpSpan[]

async function readRecording(name: string, rows: readonly unknown[]): Promise<OtlpSpan[]> {
  const path = join(folder, name + '.jsonl')
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  return parseSession(resolveAdapter('prime')!, { harness: 'prime', sessionId: name, path, cwd: null, mtimeMs: 0 })
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'traces-prime-family-'))
  // The child has moved to a separate machine, without the file named by its header.
  fork = await readRecording('continued', [forkHeader, ...parentMessages, ownPrompt, ownReply])
  parent = await readRecording('original', [header(parentId, 0), ...parentMessages])
})
afterAll(async () => { await rm(folder, { recursive: true, force: true }) })

it('retains copied context but charges a marked Prime fork only for its own work, through native and exported inputs', async () => {
  const family = [...parent, ...fork]
  const archive = join(folder, 'archive.otlp.jsonl')
  await writeOtlpFile(family, archive)
  const saved = await readOtlpInput(archive)
  for (const spans of [family, saved.spans]) {
    const facts = computeSessionFacts(spans)
    expect(facts).toHaveLength(2)
    const original = facts.find(row => row.sessionId === parentId)!
    const continued = facts.find(row => row.sessionId === forkId)!
    expect([original.toolCalls.value, continued.toolCalls.value]).toEqual([1, 0])
    expect([original.tokens.input, continued.tokens.input]).toEqual([12, 11])
    expect([original.tokens.modelCalls, continued.tokens.modelCalls]).toEqual([2, 1])
    expect(continued.firstRecordAt.value).toEqual(at(6))
    expect(continued.humanTurns.value?.map(turn => turn.text)).toEqual(['Describe a different sample.'])
    expect(continued.finalMessages.value?.map(reply => reply.text)).toEqual(['The second sample is empty.'])
    expect(continued.measurements.relationship).toMatchObject({ role: 'operator', parentSessionId: parentId, spawnedChildSessionIds: [] })
    expect(original.subagents.value).toEqual([])
    expect(continued.subagents.value).toEqual([])
    const snapshot = behaviorFromSpans(spans)
    expect(snapshot.coverage?.tool_calls).toBe(1)
    expect(snapshot.nodes.find(node => node.id === parentId)).toMatchObject({ parent: null, tool_calls: 1, llm_turns: 2 })
    expect(snapshot.nodes.find(node => node.id === forkId)).toMatchObject({ parent: parentId, tool_calls: 0, llm_turns: 1 })
    expect(snapshot.mail.edges).toEqual([])
    expect(buildSpanRunTree(spans, 'prime-fork').nodes.map(node => node.driver.records).sort()).toEqual([1, 2])
    expect(spans.filter(isRecordedToolCall).map(s => s.attributes['gen_ai.tool.call.id'])).toEqual(['call-read-original'])
    expect(spans.filter(s => isInheritedSpan(s.attributes) && s.attributes['gen_ai.tool.call.id'] === 'call-read-original')).toHaveLength(1)
    expect(spans.some(s => isInheritedSpan(s.attributes) && s.name === 'user.prompt' && s.attributes.content === 'Measure the original sample.')).toBe(true)
  }
  const refs = ['original', 'continued'].map(name => ({
    harness: 'prime', sessionId: name, path: join(folder, name + '.jsonl'), cwd: null, mtimeMs: 0,
  }))
  const workflow = await collectSessionWorkflow(resolveAdapter('prime')!, refs, { home: folder, parents: false })
  expect(workflow.issues).toEqual([])
  const earlier = buildSessionFactsReport(family, { window: { since: at(1), until: at(5) } })
  expect(earlier.sessions.map(row => row.sessionId)).toEqual([parentId])
  expect(readSessionIndex(fork).firstAt).toBe(at(6))
  expect(readSessionIndex(fork).firstPrompt).toBe('Describe a different sample.')
  expect(await readFile(archive, 'utf8')).not.toContain('/previous/device')
})

it('does not present a copied reply as the fork’s own answer before it has replied', async () => {
  const awaiting = await readRecording('awaiting', [forkHeader, ...parentMessages, ownPrompt])
  const [facts] = computeSessionFacts(awaiting)
  expect(facts!.humanTurns.value?.map(turn => turn.text)).toEqual(['Describe a different sample.'])
  expect(facts!.finalMessages.value).toEqual([])
  expect(facts!.toolCalls.value).toBe(0)
  expect(() => behaviorFromSpans(awaiting)).toThrow(/no tool spans/)
})

it('keeps a new tool and its original ID when its clock moves backward after the fork starts', async () => {
  const laterTool = nativeMessage('0000b003', '0000b002', 2, {
    ...answer('', 13), stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'call-read-second', name: 'read', arguments: { path: 'second.txt' } }],
  })
  const latest = await readRecording('continued-with-tool', [forkHeader, ...parentMessages, ownPrompt, ownReply, laterTool])
  expect(latest.filter(isRecordedToolCall).map(span => span.attributes['gen_ai.tool.call.id'])).toEqual(['call-read-second'])
  expect(buildSpanRunTree(latest, 'detached').nodes.map(node => node.driver.records)).toEqual([2])
  const detached = behaviorFromSpans(latest)
  expect(detached.nodes).toHaveLength(1)
  expect(detached.nodes[0]).toMatchObject({ id: forkId, parent: parentId, tool_calls: 1 })
  expect(detached.coverage?.unknowns).toContain(`parent ${parentId} of session ${forkId} is outside the selection`)
})

it('counts the same work in a contract export written by harness-sessions itself', async () => {
  const recordings = [[header(parentId, 0), ...parentMessages], [forkHeader, ...parentMessages, ownPrompt, ownReply]]
  const archive = join(folder, 'writer.otlp.jsonl')
  const exported = recordings.flatMap(records => toOtlpSpans(readSessionInput('prime', { records })))
  await writeFile(archive, exported.map(span => JSON.stringify(span)).join('\n'))
  const { spans } = await readOtlpInput(archive)
  const next = computeSessionFacts(spans).find(row => row.sessionId === forkId)!
  expect(next.toolCalls.value).toBe(0)
  expect(next.tokens.input).toBe(11)
  expect(next.parentSessionId).toBe(parentId)
  expect(next.measurements.relationship.role).toBe('operator')
  expect(behaviorFromSpans(spans).nodes.find(node => node.id === forkId)).toMatchObject({ parent: parentId, llm_turns: 1 })
})
