import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readOtlpInput, redactSpans, runPipelines } from '../../src/index.js'
import { stripContent } from './metadata-only.js'

describe('diagnosis kit metadata boundary', () => {
  it('withholds distinct tool inputs without inventing a repeated-call loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diagnosis-kit-boundary-'))
    try {
      const file = join(dir, 'spans.jsonl')
      const canary = 'CUSTOMER_PROSE_CANARY_20260923'
      const root = {
        trace_id: 'case-1', span_id: 'root', parent_span_id: null, name: 'session',
        start_time: '2026-09-23T12:00:00Z',
        end_time: '2026-09-23T12:00:05Z',
        status: { code: 'ERROR', message: `${canary}: failed session` }, attributes: { 'openinference.span.kind': 'AGENT' },
      }
      const tools = Array.from({ length: 4 }, (_, i) => ({
        trace_id: 'case-1', span_id: `read-${i}`, parent_span_id: 'root', name: 'read',
        start_time: new Date(Date.parse(root.start_time) + i * 700).toISOString(),
        end_time: new Date(Date.parse(root.start_time) + i * 700 + 300).toISOString(),
        status: { code: 'ERROR', message: `${canary}: failed read` },
        attributes: {
          'openinference.span.kind': 'TOOL',
          'tool.name': 'read',
          'input.value': `${canary}:file-${i}.md`,
          ...(i === 0 ? { input: canary, 'output.value': canary, result: canary, text: canary, thinking: canary, prompt: canary, request: canary, response: canary, command: canary, args: canary, tool_arguments: canary, full_command: canary, 'chat.content': canary, 'error.message': canary, error_message: canary, ERROR_MESSAGE: canary, 'error.inner.message': canary, events: [{ message: canary }], 'exception.message': canary, 'traces.source_record.input.value': canary } : {}),
        },
      }))
      writeFileSync(file, `${[root, ...tools].map(row => JSON.stringify(row)).join('\n')}\n`)

      const ingested = await readOtlpInput(file)
      expect(ingested.spans[1]?.attributes['tool.args_captured']).toBe(true)
      expect(ingested.spans[1]?.attributes['traces.input.sha256']).toBeDefined()
      const { spans: metadataOnly, dropped } = stripContent(ingested.spans)
      const { spans: scrubbed } = redactSpans(metadataOnly)
      expect(JSON.stringify(scrubbed)).not.toContain(canary)
      expect(dropped).toEqual(expect.arrayContaining(['input.value', 'output.value', 'input', 'result', 'text', 'thinking', 'prompt', 'request', 'response', 'command', 'args', 'tool_arguments', 'full_command', 'chat.content', 'error.message', 'error_message', 'ERROR_MESSAGE', 'error.inner.message', 'events', 'exception.message', 'status.message', 'tool.args_captured', 'traces.input.sha256', 'traces.output.sha256', 'traces.source_record.input.value']))
      expect(scrubbed[1]?.attributes['tool.args_captured']).toBeUndefined()
      expect(scrubbed[1]?.attributes['traces.input.sha256']).toBeUndefined()

      const metadataChecks = await runPipelines(scrubbed)
      const contentChecks = await runPipelines(ingested.spans)
      expect(contentChecks.stuckLoops.findings).toEqual([])
      expect(metadataChecks.stuckLoops.findings).toEqual([])
      expect(contentChecks.failureClusters.clusters[0]?.exampleError).toContain(canary)
      expect(metadataChecks.failureClusters.clusters).toHaveLength(1)
      expect(JSON.stringify(metadataChecks)).not.toContain(canary)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
