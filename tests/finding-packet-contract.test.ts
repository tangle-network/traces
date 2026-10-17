/**
 * The finding packet ADC's Intelligence API builds (spec §7.3): it imports
 * `buildTraceFindingPacket` from the SDK, calls it with `{findings, source,
 * title}`, and reads `packet.findings` and `packet.source`. The export, its
 * options and its output shape are a stable contract through 1.x.
 */
import { makeFinding } from '@tangle-network/agent-eval/analyst'
import { describe, expect, it } from 'vitest'
import { buildTraceFindingPacket } from '../src/index.js'

describe('buildTraceFindingPacket', () => {
  it('passes findings through untouched, names the source, and renders a report', () => {
    const findings = [
      makeFinding({ analyst_id: 'deep-trace', area: 'tool-use', claim: 'a loop', severity: 'high', evidence_refs: [], confidence: 0.9 }),
      makeFinding({ analyst_id: 'deep-trace', area: 'verification', claim: 'no check', severity: 'low', evidence_refs: [], confidence: 0.5 }),
    ]
    const packet = buildTraceFindingPacket({ findings, source: 'intelligence-api', title: 'Deep trace analysis', generatedAt: '2026-10-16T00:00:00.000Z' })
    expect(Object.keys(packet).sort()).toEqual(['findings', 'generatedAt', 'kind', 'report', 'schemaVersion', 'source'])
    expect(packet).toMatchObject({ schemaVersion: 1, kind: 'traces.finding_packet', generatedAt: '2026-10-16T00:00:00.000Z', source: 'intelligence-api' })
    expect(packet.findings).toBe(findings)
    expect(packet.report).toContain('# Deep trace analysis')
    expect(packet.report.indexOf('HIGH — a loop')).toBeLessThan(packet.report.indexOf('LOW — no check'))
  })

  it('defaults the source to traces and the time to now', () => {
    const packet = buildTraceFindingPacket({ findings: [] })
    expect(packet.source).toBe('traces')
    expect(Number.isFinite(Date.parse(packet.generatedAt))).toBe(true)
    expect(packet.findings).toEqual([])
  })
})
