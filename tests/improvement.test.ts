import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTOR_ATTR } from '../src/adapters/conversation.js'
import type { ExternalAnalyzer } from '../src/external.js'
import {
  buildTraceFindingPacket,
  loadTracesConfig,
  runTraceImprovementLoop,
  runTraceInvestigation,
  type TraceEvidenceRow,
  type ImprovementProposal,
  type TraceRecommendation,
} from '../src/improvement.js'
import { type OtlpSpan, span } from '../src/otlp.js'
import { makeFinding } from '../src/index.js'

function fixtureSpans(): OtlpSpan[] {
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  const spans: OtlpSpan[] = [
    span({
      traceId: 'trace-improve',
      spanId: 'root',
      name: 'session',
      kind: 'AGENT',
      startTime: new Date(base).toISOString(),
      service: 'synthetic',
    }),
    span({
      traceId: 'trace-improve',
      spanId: 'assistant-1',
      parentSpanId: 'root',
      name: 'llm.turn',
      kind: 'LLM',
      startTime: new Date(base + 1000).toISOString(),
      service: 'synthetic',
      step: 1,
      content: 'I will keep retrying the same command.',
    }),
    span({
      traceId: 'trace-improve',
      spanId: 'human-1',
      parentSpanId: 'root',
      name: 'user.prompt',
      kind: 'CHAIN',
      startTime: new Date(base + 1500).toISOString(),
      service: 'synthetic',
      step: 2,
      content: 'no, that is wrong, stop repeating it',
      extra: { [ACTOR_ATTR]: 'human' },
    }),
  ]
  for (let i = 0; i < 3; i += 1) {
    spans.push(span({
      traceId: 'trace-improve',
      spanId: `tool-${i}`,
      parentSpanId: 'assistant-1',
      name: 'tool.Bash',
      kind: 'TOOL',
      startTime: new Date(base + 2000 + i * 1000).toISOString(),
      service: 'synthetic',
      tool: 'Bash',
      step: 3 + i,
      status: 'ERROR',
      statusMessage: 'exit 1',
      content: JSON.stringify({ cmd: 'npm test' }),
    }))
  }
  return spans
}

function jsonAnalyzer(): ExternalAnalyzer {
  return {
    name: 'json-engine',
    async analyze() {
      return {
        analyzer: 'json-engine',
        ok: true,
        output: JSON.stringify({
          findings: [{
            area: 'verification',
            severity: 'high',
            claim: 'external engine found that verification was skipped',
            action: 'Run a real verification command before reporting completion.',
            evidence_refs: [{ kind: 'artifact', uri: 'json-engine://finding/1', excerpt: 'missing verification' }],
            confidence: 0.8,
          }],
        }),
      }
    },
  }
}

describe('runTraceInvestigation', () => {
  it('preserves typed findings and turns deterministic/external signals into recommendations', async () => {
    const result = await runTraceInvestigation({
      spans: fixtureSpans(),
      harness: 'synthetic',
      sessionCount: 1,
      externalAnalyzers: [jsonAnalyzer()],
      generatedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(result.kind).toBe('traces.investigation')
    expect(result.findings.some((finding) => finding.analyst_id === 'traces-deterministic')).toBe(true)
    expect(result.findings.some((finding) => finding.analyst_id === 'external:json-engine')).toBe(true)
    expect(result.findings.every((finding) => finding.finding_id && Array.isArray(finding.evidence_refs))).toBe(true)
    expect(result.findings.some((finding) => finding.claim.includes('repeated tool-call loop'))).toBe(false)
    expect(result.findings.some((finding) => finding.claim === 'No skill usage was observed in the selected sessions')).toBe(false)
    expect(result.recommendations.length).toBeGreaterThan(0)
    expect(result.recommendations[0]!.validationPlan).toMatch(/Rerun|rerun|Run/)
    expect(result.claims.length).toBe(result.findings.length)
    expect(result.report).toContain('## recommendations')
    expect(result.report).toContain('external engine found')
    expect(result.report).toContain('Full-session repeated-call groups (not time-bounded)')
  })

  it('does not recommend skill adoption when Codex has no dedicated Skill event', async () => {
    const spans = [
      span({
        traceId: 'codex-skill-telemetry',
        spanId: 'root',
        name: 'session',
        kind: 'AGENT',
        startTime: '2026-01-01T00:00:00.000Z',
        service: 'codex',
      }),
      span({
        traceId: 'codex-skill-telemetry',
        spanId: 'developer',
        parentSpanId: 'root',
        name: 'message.developer',
        kind: 'CHAIN',
        startTime: '2026-01-01T00:00:01.000Z',
        service: 'codex',
        content: '<skills_instructions>### Available skills</skills_instructions>',
      }),
    ]

    const result = await runTraceInvestigation({
      spans,
      harness: 'codex',
      sessionCount: 1,
      generatedAt: '2026-01-01T00:00:02.000Z',
    })

    expect(result.findings.some((finding) => finding.claim.includes('skill usage'))).toBe(false)
    expect(result.report).toContain('Explicit skill invocation rate:** uncaptured/unsupported')
    expect(result.report).toContain('Materialized skill catalogs/instructions:** 1/1')
    expect(result.report).not.toContain('Skill penetration')
  })
})

describe('buildTraceFindingPacket', () => {
  it('builds recommendations and claims from typed findings without span input', () => {
    const finding = makeFinding({
      analyst_id: 'hosted-postgres-analyst',
      area: 'verification',
      claim: 'agent reported completion before running tests',
      severity: 'high',
      evidence_refs: [{ kind: 'metric', uri: 'postgres.trace_store.finding/1', excerpt: 'test command absent' }],
      recommended_action: 'Require a test/build command before completion on code edits.',
      validation_plan: 'Rerun the hosted analyst and require this finding to disappear.',
      confidence: 0.9,
    })

    const packet = buildTraceFindingPacket({
      findings: [finding],
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'adc-postgres',
      title: 'Hosted trace findings',
    })

    expect(packet.kind).toBe('traces.finding_packet')
    expect(packet.recommendations).toHaveLength(1)
    expect(packet.claims).toHaveLength(1)
    expect(packet.recommendations[0]!.findingIds).toEqual([finding.finding_id])
    expect(packet.report).toContain('Hosted trace findings')
    expect(packet.report).toContain('Require a test/build command')
  })
})

describe('runTraceImprovementLoop', () => {
  it('writes default proposal-only artifacts when no adapter is configured', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'traces-improve-default-test-'))
    const result = await runTraceImprovementLoop({
      spans: fixtureSpans(),
      harness: 'synthetic',
      sessionCount: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      outDir,
    })

    expect(result.kind).toBe('traces.improvement')
    expect(result.recommendations.length).toBeGreaterThan(0)
    expect(result.proposals.length).toBeGreaterThan(0)
    expect(result.proposals[0]!.recommendationIds).toEqual([result.recommendations[0]!.id])
    expect(result.proposals[0]!.description).toContain('proposal-only artifact')
    expect(result.replay.status).toBe('proposal-only')
    expect(result.replay.candidateApplied).toBe(false)

    const proposals = JSON.parse(await readFile(result.artifacts!.proposals, 'utf8')) as ImprovementProposal[]
    const replay = JSON.parse(await readFile(result.artifacts!.replay, 'utf8')) as { proposals: unknown[]; baseline: { spanCount: number } }

    expect(proposals).toHaveLength(result.proposals.length)
    expect(proposals[0]!.evidenceRefs?.length).toBeGreaterThan(0)
    expect(replay.proposals).toHaveLength(result.proposals.length)
    expect(replay.baseline.spanCount).toBe(fixtureSpans().length)
  })

  it('lets a configured adapter replace the default proposal set', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'traces-improve-test-'))
    const result = await runTraceImprovementLoop({
      spans: fixtureSpans(),
      harness: 'synthetic',
      sessionCount: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      outDir,
      adapter: {
        async propose(input) {
          return [{
            id: 'proposal-loop-breaker',
            title: 'Add a retry stop rule',
            description: 'Stop after the same command fails twice with unchanged arguments.',
            recommendationIds: input.recommendations.slice(0, 1).map((rec) => rec.id),
            validationCommand: 'traces improve --last 3',
            evidenceRefs: input.findings[0]?.evidence_refs ?? [],
          }]
        },
      },
    })

    expect(result.kind).toBe('traces.improvement')
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]!.id).toBe('proposal-loop-breaker')
    expect(result.replay.status).toBe('proposal-only')
    expect(result.replay.candidateApplied).toBe(false)
    expect(result.artifacts?.directory).toBe(outDir)

    const recommendations = JSON.parse(await readFile(result.artifacts!.recommendations, 'utf8')) as TraceRecommendation[]
    const proposals = JSON.parse(await readFile(result.artifacts!.proposals, 'utf8')) as ImprovementProposal[]
    const evidence = (await readFile(result.artifacts!.evidence, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceEvidenceRow)
    const replay = JSON.parse(await readFile(result.artifacts!.replay, 'utf8')) as { proposals: unknown[]; baseline: { spanCount: number } }

    expect(recommendations.length).toBeGreaterThan(0)
    expect(evidence.length).toBeGreaterThan(0)
    expect(evidence[0]!.kind).toBe('traces.improvement_evidence')
    expect(replay.baseline.spanCount).toBe(fixtureSpans().length)
    expect(replay.proposals).toHaveLength(1)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]!.id).toBe('proposal-loop-breaker')
  })
})

describe('loadTracesConfig', () => {
  it('loads BYO analyzer config from an ESM config file and ignores a missing default', async () => {
    expect(await loadTracesConfig('/tmp/no-such-traces-config.mjs')).toBeUndefined()

    const dir = await mkdtemp(join(tmpdir(), 'traces-config-test-'))
    const configPath = join(dir, 'traces.config.mjs')
    await writeFile(configPath, `export default { externalAnalyzers: [{ name: 'cfg-engine', async analyze() { return { analyzer: 'cfg-engine', ok: true, output: '' } } }] }\n`, 'utf8')

    const config = await loadTracesConfig(configPath)
    expect(config?.externalAnalyzers).toHaveLength(1)
    expect(config?.externalAnalyzers?.[0]!.name).toBe('cfg-engine')
  })
})
