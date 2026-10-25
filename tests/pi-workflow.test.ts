import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parsePiWorkflowRun } from '../src/adapters/pi-workflow.js'
import { exportTraceEvidenceFile } from '../src/file-export.js'
import { metadataOnly } from '../src/metadata-only.js'
import { buildSpanRunTree } from '../src/run-span-tree.js'
import { serializeSpans } from '../src/otlp.js'
import { readOtlpInput } from '../src/otlp-input.js'
import { computeSessionFacts } from '../src/session-facts.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = fileURLToPath(new URL('./fixtures/pi-workflow/run.json', import.meta.url))

describe('Pi workflow persisted-run ingestion', () => {
  it('round-trips through the shared span reader and facts without inventing phase clocks, calls or usage', async () => {
    const result = await parsePiWorkflowRun(fixture)
    const dir = await mkdtemp(join(tmpdir(), 'traces-pi-workflow-'))
    try {
      const path = join(dir, 'workflow.otlp.jsonl')
      await writeFile(path, serializeSpans(result.spans))
      const reread = await readOtlpInput(path)
      expect(reread.spans).toHaveLength(5)
      expect(new Set(reread.spans.map((span) => span.trace_id)).size).toBe(1)
      const tree = buildSpanRunTree(reread.spans, path)
      expect(tree.nodes).toHaveLength(3)
      expect(tree.orphanSpans).toBe(0)
      expect(tree.nodes.reduce((sum, node) => sum + node.toolCalls, 0)).toBe(2)
      expect(computeSessionFacts(reread.spans)[0]?.toolCalls.value).toBe(0)
      const root = reread.spans.find((span) => span.name === 'pi.workflow')!
      const agents = reread.spans.filter((span) => span.name === 'pi.workflow.agent')
      expect(agents.every((span) => span.parent_span_id === root.span_id)).toBe(true)
      expect(reread.spans.some((span) => span.attributes['openinference.span.kind'] === 'LLM')).toBe(false)
      expect(reread.spans.some((span) => span.attributes['openinference.span.kind'] === 'CHAIN')).toBe(false)
      const measured = agents.find((span) => span.attributes['traces.pi.workflow.call_id'] === 'workflow-fixture-1:0')!
      const facts = computeSessionFacts(reread.spans, { includeSubagents: true })
      expect(facts).toHaveLength(3)
      const own = facts.find((fact) => fact.rootSpanId.value === measured.span_id)!
      expect(own.traceId).toBe(root.trace_id)
      expect(own.tokens).toMatchObject({ input: 135, output: 20, cacheRead: 30, cacheWrite: 5, modelCalls: 0 })
      expect(facts.find((fact) => fact.rootSpanId.value === root.span_id)?.tokens.input).toBeNull()
      expect(facts.reduce((sum, fact) => sum + (fact.tokens.input ?? 0), 0)).toBe(135)
      expect(facts.reduce((sum, fact) => sum + (fact.toolCalls.value ?? 0), 0)).toBe(2)
      expect((await exportTraceEvidenceFile(fixture)).format).toBe('pi-workflow')
      const estimated = agents.find((span) => span.attributes['traces.pi.workflow.call_id'] === 'workflow-fixture-1:1')!
      expect(facts.find((fact) => fact.rootSpanId.value === estimated.span_id)?.tokens.input).toBeNull()
      expect(estimated.end_time).toBe(estimated.start_time)
      expect(result.unknowns.join(' ')).toMatch(/phase start\/end timestamps/)
      expect(result.unknowns.join(' ')).toMatch(/1 agent records lack a valid identity or start\/end interval/)
      expect(result.unknowns.join(' ')).toMatch(/scalar token estimates were not counted/)
      const exported = JSON.stringify(metadataOnly(result.spans).spans)
      expect(exported).not.toContain('PRIVATE_')
      expect(exported).not.toContain('gen_ai.request.model')
      expect(root.attributes['traces.source.unknowns']).toBe(JSON.stringify(result.unknowns))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses an unplaceable run and duplicate call identities instead of emitting false execution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-pi-workflow-invalid-'))
    try {
      const value = JSON.parse(await readFile(fixture, 'utf8')) as Record<string, unknown>
      const path = join(dir, 'run.json')
      await writeFile(path, JSON.stringify({ ...value, startedAt: undefined }))
      await expect(parsePiWorkflowRun(path)).rejects.toThrow('recorded valid start timestamp')
      const agent = (value.agents as unknown[])[0]
      await writeFile(path, JSON.stringify({ ...value, agents: [agent, agent] }))
      await expect(parsePiWorkflowRun(path)).rejects.toThrow('duplicate agent call identity')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
