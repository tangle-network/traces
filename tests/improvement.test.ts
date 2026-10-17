/**
 * What `traces analyze` hands a program, through the built CLI: `--format
 * json` (the facts sheet, the finding packet, the measures, conformance and
 * every question the trace cannot answer) and `--out DIR` (exactly
 * `report.md`, with every cannot-answer reason, and `findings.json`, the
 * packet). No span copy is written, and no model is called.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeAnalyzeHome, type AnalyzeHome } from './fixtures/analyze.js'
import { runCli } from './run-cli.js'

interface Analysis {
  schemaVersion: number
  kind: string
  facts: { kind: string; sessions: Array<{ cost: { usd: number | null; unavailable: string | null } }> }
  packet: { kind: string; schemaVersion: number; source: string; findings: Array<{ finding_id: string; severity: string }> }
  measures: { stuckLoops: unknown; failureClusters: unknown; toolUse: unknown[]; failureFollowUps: unknown; toolErrors: unknown[]; unverifiedClaims: unknown[] }
  conformance: { capabilities: unknown[] }
  cannotAnswer: Array<{ analysis: string; reason: string }>
}

const RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

let fx: AnalyzeHome
beforeAll(async () => {
  fx = await makeAnalyzeHome()
})

async function json(path: string): Promise<Analysis> {
  const run = await runCli(['analyze', path, '--format', 'json'], { env: fx.env })
  expect(run.code, run.stderr).toBe(0)
  return JSON.parse(run.stdout) as Analysis
}

describe('analyze --format json', () => {
  it('carries the facts, the packet, the measures, conformance and every cannot-answer reason, and nothing else', async () => {
    const result = await json(fx.worker)
    expect(Object.keys(result)).toEqual(['schemaVersion', 'kind', 'generatedAt', 'harness', 'facts', 'packet', 'measures', 'conformance', 'cannotAnswer'])
    expect(result).toMatchObject({ schemaVersion: 1, kind: 'traces.analysis' })
    expect(result.facts.kind).toBe('traces.session_facts_report')
    expect(result.packet).toMatchObject({ schemaVersion: 1, kind: 'traces.finding_packet', source: 'traces analyze' })
    expect(Object.keys(result.measures).sort()).toEqual(['failureClusters', 'failureFollowUps', 'stuckLoops', 'toolErrors', 'toolUse', 'unverifiedClaims'])
    expect(result.conformance.capabilities.length).toBeGreaterThan(0)
    expect(result.cannotAnswer.length).toBeGreaterThanOrEqual(1)
    // claude-opus-5-5 is priced: a number, never 0 for unknown.
    expect(result.facts.sessions[0]!.cost.usd).toBeGreaterThan(0)
    const ranks = result.packet.findings.map((finding) => RANK[finding.severity]!)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })

  it('on a trace with no tool arguments, names the argument comparisons it cannot make, and prints no failing command', async () => {
    const converted = join(fx.dir, 'worker.otlp.jsonl')
    expect((await runCli(['convert', fx.worker, '--out', converted], { env: fx.env })).code).toBe(0)
    const stripped = join(fx.dir, 'metadata-only.otlp.jsonl')
    const rows = (await readFile(converted, 'utf8')).trim().split('\n').map((line) => {
      const row = JSON.parse(line) as { attributes: Record<string, unknown> }
      for (const key of ['input.value', 'output.value', 'content']) delete row.attributes[key]
      return JSON.stringify(row)
    })
    await writeFile(stripped, `${rows.join('\n')}\n`)

    const result = await json(stripped)
    const asked = result.cannotAnswer.map((entry) => entry.analysis)
    expect(asked.some((entry) => entry.startsWith('argument comparisons'))).toBe(true)
    expect(asked).toContain('facts.measurements.waste')
    const text = (await runCli(['analyze', stripped], { env: fx.env })).stdout
    expect(text).not.toContain('failing commands')
    expect(text).toContain(`cannot answer ${result.cannotAnswer.length} questions`)
  })
})

describe('analyze --out DIR', () => {
  it('writes exactly report.md and findings.json, prints one line, and report.md holds every cannot-answer reason', async () => {
    const out = join(fx.dir, 'analysis')
    const run = await runCli(['analyze', fx.worker, '--out', out], { env: fx.env })
    expect(run.code, run.stderr).toBe(0)
    expect(run.stdout.trimEnd().split('\n')).toHaveLength(1)
    expect(run.stdout).toContain(`analysis → ${out}  (report.md, findings.json: `)
    expect((await readdir(out)).sort()).toEqual(['findings.json', 'report.md'])

    const result = await json(fx.worker)
    const packet = JSON.parse(await readFile(join(out, 'findings.json'), 'utf8')) as Analysis['packet']
    expect(packet).toMatchObject({ schemaVersion: 1, kind: 'traces.finding_packet' })
    expect(packet.findings.map((finding) => finding.finding_id)).toEqual(result.packet.findings.map((finding) => finding.finding_id))

    const report = await readFile(join(out, 'report.md'), 'utf8')
    expect(report).toContain('# traces analyze')
    expect(report).toContain('## Findings')
    expect(report).toContain(`## What these traces cannot answer (${result.cannotAnswer.length})`)
    for (const entry of result.cannotAnswer) expect(report).toContain(entry.reason)
  })
})
