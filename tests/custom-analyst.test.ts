import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('custom analyst example', () => {
  it('reads the trace store and cites the repeated failure', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'examples/custom-analyst.ts',
      '--fixture',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      timeout: 30_000,
    })
    const findings = JSON.parse(stdout) as Array<Record<string, unknown>>

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      analyst_id: 'failed-tool-clusters',
      area: 'tool-use',
      severity: 'high',
      confidence: 1,
      metadata: {
        deterministic: true,
        trace_count: 1,
        span_count: 3,
      },
    })
    expect(findings[0]?.claim).toContain('3 failed span(s)')
    const evidence = findings[0]?.evidence_refs as Array<Record<string, unknown>>
    expect(evidence[0]).toMatchObject({
      kind: 'span',
      uri: 'trace://fixture-three-failures/span/failed-1',
      excerpt: 'Command failed with exit code 127 on attempt 1',
    })
  })

  it('returns no findings for the matched successful fixture', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'examples/custom-analyst.ts',
      '--good-fixture',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      timeout: 30_000,
    })

    expect(JSON.parse(stdout)).toEqual([])
  })
})
