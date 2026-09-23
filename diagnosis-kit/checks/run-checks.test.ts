import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('./run-checks.ts', import.meta.url))

describe('diagnosis kit metadata boundary', () => {
  it('drops transcript prose before deterministic checks read spans', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diagnosis-kit-boundary-'))
    try {
      const file = join(dir, 'spans.jsonl')
      const canary = 'CUSTOMER_PROSE_CANARY_20260923'
      const contentKeys = ['input.value', 'output.value', 'input', 'result', 'text', 'thinking', 'prompt', 'request', 'response', 'command', 'chat.content']
      const attributes = Object.fromEntries(contentKeys.map(key => [key, canary]))
      writeFileSync(file, `${JSON.stringify({
        trace_id: 'case-1',
        span_id: 'tool-1',
        parent_span_id: null,
        name: 'search',
        start_time: '2026-09-23T12:00:00Z',
        end_time: '2026-09-23T12:00:01Z',
        status: { code: 'OK' },
        attributes: { 'openinference.span.kind': 'TOOL', 'tool.name': 'search', ...attributes },
      })}\n`)
      const result = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, file], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report.subject.contentIncluded).toBe(false)
      expect(report.coverage.redaction.droppedAttributes).toEqual(contentKeys.slice().sort())
      expect(result.stdout).not.toContain(canary)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
