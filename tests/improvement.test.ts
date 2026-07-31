import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTOR_ATTR } from '../src/adapters/conversation.js'
import type { ExternalAnalyzer } from '../src/external.js'
import type { AnalystRunSummary, TraceAnalysisEngine } from '@tangle-network/agent-eval/analyst'
import {
  buildTraceFindingPacket,
  loadTracesConfig,
  runTraceImprovement,
  runTraceInvestigation,
  totalAgenticFailureMessage,
  type TraceEvidenceRow,
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
      extra: { 'input.value': JSON.stringify({ cmd: 'npm test' }) },
    }))
  }
  return spans
}

interface ToolCallFixture {
  id: string
  tool: string
  message?: string
}

function toolRunSpans(
  traceId: string,
  calls: readonly ToolCallFixture[],
  terminalError?: string,
): OtlpSpan[] {
  return [
    span({
      traceId,
      spanId: 'root',
      name: 'session',
      kind: 'AGENT',
      startTime: '2026-01-01T00:00:00.000Z',
      status: terminalError ? 'ERROR' : 'OK',
      statusMessage: terminalError,
      service: 'synthetic',
    }),
    ...calls.map((call, index) =>
      span({
        traceId,
        spanId: call.id,
        parentSpanId: 'root',
        name: `tool.${call.tool}`,
        kind: 'TOOL',
        startTime: `2026-01-01T00:00:0${index + 1}.000Z`,
        status: call.message ? 'ERROR' : 'OK',
        statusMessage: call.message,
        service: 'synthetic',
        tool: call.tool,
        extra: { 'input.value': JSON.stringify({ attempt: index + 1 }) },
      })),
  ]
}

function jsonAnalyzer(): ExternalAnalyzer {
  return {
    name: 'json-engine',
    async analyze() {
      return {
        analyzer: 'json-engine',
        kind: 'findings',
        ok: true,
        output: 'Structured findings emitted.',
        findings: [makeFinding({
          analyst_id: 'external:json-engine',
          area: 'verification',
          severity: 'high',
          claim: 'external engine found that verification was skipped',
          recommended_action: 'Run a real verification command before reporting completion.',
          validation_plan: 'Rerun the task and require a successful verification span.',
          evidence_refs: [{ kind: 'artifact', uri: 'json-engine://finding/1', excerpt: 'missing verification' }],
          confidence: 0.8,
        })],
      }
    },
  }
}

describe('runTraceInvestigation', () => {
  it('preserves evidence, actions, and validation on one typed finding', async () => {
    const result = await runTraceInvestigation({
      spans: fixtureSpans(),
      harness: 'synthetic',
      externalAnalyzers: [jsonAnalyzer()],
      generatedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(result.kind).toBe('traces.investigation')
    expect(result.findings.some((finding) => finding.analyst_id === 'traces-deterministic')).toBe(true)
    expect(result.findings.some((finding) => finding.analyst_id === 'external:json-engine')).toBe(true)
    expect(result.findings.some((finding) =>
      finding.area === 'instrumentation' &&
      finding.recommended_action?.includes('complete canonical tool arguments'))).toBe(true)
    expect(result.findings.every((finding) => finding.finding_id && Array.isArray(finding.evidence_refs))).toBe(true)
    const loopFinding = result.findings.find((finding) => finding.claim.includes('repeated tool-call loop'))
    expect(loopFinding?.evidence_refs).toContainEqual(
      expect.objectContaining({ kind: 'metric', uri: 'pipelines.stuck_loop_count' }),
    )
    expect(result.findings.some((finding) => finding.area === 'reliability')).toBe(false)
    expect(result.findings.some((finding) => finding.claim === 'No skill usage was observed in the selected sessions')).toBe(false)
    expect(result.findings.some((finding) => finding.recommended_action)).toBe(true)
    expect(result.findings.some((finding) => finding.validation_plan?.match(/Rerun|rerun|Run/))).toBe(true)
    expect(result.report).toContain('**Check:**')
    expect(result.report).toContain('external engine found')
    expect(result.report).toContain('Stuck loops')
  })

  it('reports varied non-terminal tool errors once with exact source spans', async () => {
    const errorSpans = [
      { id: 'failed-install', tool: 'exec', message: 'package install exited 1' },
      { id: 'failed-read', tool: 'read', message: 'file disappeared before read' },
      { id: 'failed-fetch', tool: 'fetch', message: 'upstream returned 503' },
    ]
    const spans = toolRunSpans('recovered-errors', errorSpans)

    const first = await runTraceInvestigation({
      spans,
      harness: 'synthetic',
      generatedAt: '2026-01-01T00:00:05.000Z',
    })
    const second = await runTraceInvestigation({
      spans,
      harness: 'synthetic',
      generatedAt: '2026-01-02T00:00:05.000Z',
    })
    const findings = first.findings.filter(
      (finding) => finding.subject === 'non-terminal-tool-errors',
    )

    expect(first.pipelines.failureClusters.totalFailures).toBe(0)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      area: 'tool-use',
      severity: 'high',
      claim: '3/3 tool call(s) ended in errors across 1 run(s) without a terminal failure',
      metadata: {
        errorCount: 3,
        totalCalls: 3,
        affectedRuns: 1,
        citedErrorSpans: 3,
        omittedErrorSpans: 0,
      },
    })
    expect(findings[0]!.evidence_refs).toEqual(errorSpans.map((item) => ({
      kind: 'span',
      uri: `trace://recovered-errors/span/${item.id}`,
      excerpt: `${item.tool}: ${item.message}`,
    })))
    expect(second.findings.find(
      (finding) => finding.subject === 'non-terminal-tool-errors',
    )?.finding_id).toBe(findings[0]!.finding_id)
  })

  it('does not emit a tool-error finding for clean tool calls', async () => {
    const result = await runTraceInvestigation({
      spans: toolRunSpans('clean-tools', [{ id: 'successful-tool', tool: 'exec' }]),
      harness: 'synthetic',
      generatedAt: '2026-01-01T00:00:02.000Z',
    })

    expect(result.findings.filter(
      (finding) => finding.subject === 'non-terminal-tool-errors',
    )).toHaveLength(0)
  })

  it('keeps exact terminal error evidence without a separate recovered-error finding', async () => {
    const spans = toolRunSpans(
      'terminal/failure',
      [
        { id: 'failed tool 1', tool: 'exec', message: 'command exited 1' },
        { id: 'failed tool 2', tool: 'read', message: 'input disappeared' },
        { id: 'failed tool 3', tool: 'fetch', message: 'upstream returned 503' },
        { id: 'failed tool 4', tool: 'write', message: 'disk became read-only' },
      ],
      'task failed',
    )
    const result = await runTraceInvestigation({
      spans,
      harness: 'synthetic',
      generatedAt: '2026-01-01T00:00:06.000Z',
    })

    expect(result.pipelines.failureClusters.totalFailures).toBe(1)
    const terminalFindings = result.findings.filter(
      (finding) => finding.claim.includes('run(s) had execution errors'),
    )
    expect(terminalFindings).toHaveLength(1)
    expect(terminalFindings[0]!.evidence_refs.filter(
      (reference) => reference.kind === 'span',
    )).toEqual([
      {
        kind: 'span',
        uri: 'trace://terminal%2Ffailure/span/root',
        excerpt: 'session: task failed',
      },
      {
        kind: 'span',
        uri: 'trace://terminal%2Ffailure/span/failed%20tool%201',
        excerpt: 'exec: command exited 1',
      },
      {
        kind: 'span',
        uri: 'trace://terminal%2Ffailure/span/failed%20tool%202',
        excerpt: 'read: input disappeared',
      },
      {
        kind: 'span',
        uri: 'trace://terminal%2Ffailure/span/failed%20tool%203',
        excerpt: 'fetch: upstream returned 503',
      },
    ])
    expect(terminalFindings[0]).toMatchObject({
      metadata: {
        citedToolErrorSpans: 3,
        omittedToolErrorSpans: 1,
      },
    })
    expect(result.findings.filter(
      (finding) => finding.subject === 'non-terminal-tool-errors',
    )).toHaveLength(0)
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
      generatedAt: '2026-01-01T00:00:02.000Z',
    })

    expect(result.findings.some((finding) => finding.claim.includes('skill usage'))).toBe(false)
    expect(result.report).toContain('Explicit skill invocation rate:** uncaptured/unsupported')
    expect(result.report).toContain('Materialized skill catalogs/instructions:** 1/1')
    expect(result.report).not.toContain('Skill penetration')
  })

  it('forwards cancellation to external analyzers and rejects the investigation', async () => {
    const controller = new AbortController()
    const reason = new Error('stop trace investigation')
    let observedSignal: AbortSignal | undefined
    const analyzer: ExternalAnalyzer = {
      name: 'cancellable',
      async analyze(_path, options) {
        observedSignal = options?.signal
        controller.abort(reason)
        return {
          analyzer: 'cancellable',
          kind: 'report',
          ok: false,
          output: '',
          error: 'cancelled',
        }
      },
    }

    await expect(runTraceInvestigation({
      spans: fixtureSpans(),
      harness: 'synthetic',
      externalAnalyzers: [analyzer],
      signal: controller.signal,
    })).rejects.toBe(reason)
    expect(observedSignal).toBe(controller.signal)
  })

  it('rejects external findings that cite spans outside the supplied traces', async () => {
    const analyzer: ExternalAnalyzer = {
      name: 'invented-evidence',
      async analyze() {
        return {
          analyzer: 'invented-evidence',
          kind: 'findings',
          ok: true,
          output: 'A span was cited.',
          findings: [makeFinding({
            analyst_id: 'external:invented-evidence',
            area: 'verification',
            severity: 'high',
            claim: 'an external analyzer invented span evidence',
            evidence_refs: [{
              kind: 'span',
              uri: 'trace://does-not-exist/span/never',
            }],
            confidence: 0.9,
          })],
        }
      },
    }

    const result = await runTraceInvestigation({
      spans: fixtureSpans(),
      harness: 'synthetic',
      externalAnalyzers: [analyzer],
      generatedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(result.external).toEqual([
      expect.objectContaining({
        analyzer: 'invented-evidence',
        kind: 'report',
        ok: false,
        output: '',
        error: expect.stringContaining(
          "unknown span evidence URI 'trace://does-not-exist/span/never'",
        ),
      }),
    ])
    expect(result.findings.some(
      (finding) => finding.analyst_id === 'external:invented-evidence',
    )).toBe(false)
  })

  it('accepts external findings that cite an exact supplied span', async () => {
    const analyzer: ExternalAnalyzer = {
      name: 'bound-evidence',
      async analyze() {
        return {
          analyzer: 'bound-evidence',
          kind: 'findings',
          ok: true,
          output: 'An existing span was cited.',
          findings: [makeFinding({
            analyst_id: 'external:bound-evidence',
            area: 'verification',
            severity: 'high',
            claim: 'an external analyzer cited exact span evidence',
            evidence_refs: [{
              kind: 'span',
              uri: 'trace://trace-improve/span/tool-0',
            }],
            confidence: 0.9,
          })],
        }
      },
    }

    const result = await runTraceInvestigation({
      spans: fixtureSpans(),
      harness: 'synthetic',
      externalAnalyzers: [analyzer],
      generatedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(result.external).toEqual([
      expect.objectContaining({
        analyzer: 'bound-evidence',
        kind: 'findings',
        ok: true,
      }),
    ])
    expect(result.findings.some(
      (finding) => finding.analyst_id === 'external:bound-evidence',
    )).toBe(true)
  })
})

describe('buildTraceFindingPacket', () => {
  it('keeps the analyst finding as the single action record', () => {
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
    expect(packet.findings).toEqual([finding])
    expect(packet).not.toHaveProperty('recommendations')
    expect(packet).not.toHaveProperty('claims')
    expect(packet.report).toContain('Hosted trace findings')
    expect(packet.report).toContain('Require a test/build command')
  })
})

describe('runTraceImprovement', () => {
  it('writes one evidence-backed result without inventing candidate records', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'traces-improve-default-test-'))
    const result = await runTraceImprovement({
      spans: fixtureSpans(),
      harness: 'synthetic',
      generatedAt: '2026-01-01T00:00:00.000Z',
      outDir,
    })

    expect(result.kind).toBe('traces.improvement')
    expect(result.findings.length).toBeGreaterThan(0)

    const saved = JSON.parse(await readFile(result.artifacts!.result, 'utf8')) as {
      findings: unknown[]
      spanCount: number
    }
    expect(saved.findings).toHaveLength(result.findings.length)
    expect(saved.spanCount).toBe(fixtureSpans().length)
    expect(saved).not.toHaveProperty('proposals')
    expect(saved).not.toHaveProperty('validation')
    expect(result.artifacts!.traces).toBe(result.otlpPath)
    expect(result.artifacts?.directory).toBe(outDir)

    const evidence = (await readFile(result.artifacts!.evidence, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceEvidenceRow)
    expect(evidence.length).toBeGreaterThan(0)
    expect(evidence[0]!.kind).toBe('traces.improvement_evidence')
  })
})

describe('loadTracesConfig', () => {
  it('loads BYO analyzer config from an ESM config file and rejects a missing explicit path', async () => {
    await expect(loadTracesConfig('/tmp/no-such-traces-config.mjs')).rejects.toThrow(/config not found/)
    expect(await loadTracesConfig()).toBeUndefined()

    const dir = await mkdtemp(join(tmpdir(), 'traces-config-test-'))
    const configPath = join(dir, 'traces.config.mjs')
    await writeFile(configPath, `export default { externalAnalyzers: [{ name: 'cfg-engine', async analyze() { return { analyzer: 'cfg-engine', kind: 'report', ok: true, output: '' } } }] }\n`, 'utf8')

    const config = await loadTracesConfig(configPath)
    expect(config?.externalAnalyzers).toHaveLength(1)
    expect(config?.externalAnalyzers?.[0]!.name).toBe('cfg-engine')
  })
})

describe('agentic failure surfacing', () => {
  const BRIDGE_ERROR =
    "DSPy RLM trace analysis exited 1. stderr=DSPY-BRIDGE-FAILURE: ValueError: analyze input must contain exactly ['controlAdapter', 'instructions', 'limits', 'modelProxy', 'operation', 'question', 'toolCallback', 'toolSpecs'] stdout="

  function failingEngine(message: string): TraceAnalysisEngine {
    return {
      id: 'failing-test-engine',
      description: 'Engine whose startup always fails, before any model call.',
      model: 'test-model',
      version: '1.0.0',
      executionConfig: { base_url: 'http://127.0.0.1:1/v1', api_key_provided: true },
      analyze: async () => {
        throw new Error(message)
      },
    }
  }

  function failedSummary(id: string, message: string): AnalystRunSummary {
    return {
      analyst_id: id,
      status: 'failed',
      findings_count: 0,
      latency_ms: 135,
      usage: { calls: 0, tokens: { input: 0, output: 0 }, cost: { kind: 'observed', usd: 0 } },
      error: { class: 'Error', message },
    }
  }

  it('carries each engine failure into agenticPerAnalyst and the report table', async () => {
    const result = await runTraceInvestigation({
      spans: fixtureSpans(),
      harness: 'synthetic',
      engine: failingEngine(BRIDGE_ERROR),
      generatedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(result.agenticPerAnalyst).toBeDefined()
    expect(result.agenticPerAnalyst!.length).toBeGreaterThan(0)
    expect(result.agenticPerAnalyst!.every((summary) => summary.status === 'failed')).toBe(true)
    expect(result.agenticPerAnalyst!.every((summary) => summary.error?.message === BRIDGE_ERROR)).toBe(true)
    expect(result.report).toContain('DSPY-BRIDGE-FAILURE: ValueError: analyze input must contain exactly')
  })

  it('leaves agenticPerAnalyst unset for a deterministic-only run', async () => {
    const result = await runTraceInvestigation({
      spans: fixtureSpans(),
      harness: 'synthetic',
      generatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(result.agenticPerAnalyst).toBeUndefined()
    expect(totalAgenticFailureMessage(result.agenticPerAnalyst)).toBeUndefined()
  })

  it('builds the failure message only when no agentic analyst succeeded', () => {
    expect(totalAgenticFailureMessage(undefined)).toBeUndefined()
    expect(totalAgenticFailureMessage([])).toBeUndefined()
    expect(totalAgenticFailureMessage([
      failedSummary('failure-mode', BRIDGE_ERROR),
      { ...failedSummary('knowledge-gap', BRIDGE_ERROR), status: 'ok', error: undefined },
    ])).toBeUndefined()

    const message = totalAgenticFailureMessage(
      [failedSummary('failure-mode', BRIDGE_ERROR), failedSummary('improvement', `broken pipeline\n${'x'.repeat(600)}`)],
      { requiredBridgeVersion: '0.139.3' },
    )
    expect(message).toContain('none of the 2 agentic analyst(s) succeeded')
    expect(message).toContain('failure-mode: DSPY-BRIDGE-FAILURE: ValueError: analyze input must contain exactly')
    expect(message).toContain('improvement: Error: broken pipeline')
    expect(message).toContain('…')
    expect(message).toContain('agent-eval-rpc[dspy]==0.139.3')
  })

  it('fires when the only non-failed analysts were skipped — a skip must not read as success', () => {
    const message = totalAgenticFailureMessage([
      failedSummary('failure-mode', BRIDGE_ERROR),
      failedSummary('knowledge-poisoning', BRIDGE_ERROR),
      failedSummary('improvement', BRIDGE_ERROR),
      {
        analyst_id: 'knowledge-gap',
        status: 'skipped',
        reason: 'missing input: traceStore',
        findings_count: 0,
        latency_ms: 0,
        usage: { calls: 0, tokens: { input: 0, output: 0 }, cost: { kind: 'observed', usd: 0 } },
      },
    ])
    expect(message).toContain('none of the 4 agentic analyst(s) succeeded')
    expect(message).toContain('knowledge-gap: skipped — missing input: traceStore')
  })

  it('omits the bridge-version hint when a mid-analysis traceback merely names the bridge module', () => {
    // Realistic mid-analysis failure: the traceback traverses the installed
    // agent_eval_rpc module path, but nothing about it is version skew.
    const midAnalysisError =
      'DSPy RLM trace analysis exited 1. stderr=Traceback (most recent call last): ' +
      'File "/venv/lib/python3.12/site-packages/agent_eval_rpc/dspy_rlm_bridge.py", line 254, in _analyze ' +
      'findings = _parse_findings_json(_prediction_string(prediction, "findings_json")) ' +
      'ValueError: DSPy RLM findings_json must be valid JSON stdout='
    const message = totalAgenticFailureMessage(
      [failedSummary('failure-mode', midAnalysisError)],
      { requiredBridgeVersion: '0.139.3' },
    )
    expect(message).toContain('none of the 1 agentic analyst(s) succeeded')
    expect(message).toContain('findings_json must be valid JSON')
    expect(message).not.toContain('agent-eval-rpc[dspy]==')
  })

  it('adds the bridge-version hint for a missing bridge install', () => {
    const message = totalAgenticFailureMessage(
      [failedSummary('failure-mode',
        "DSPy RLM trace analysis exited 1. stderr=ModuleNotFoundError: No module named 'agent_eval_rpc' stdout=")],
      { requiredBridgeVersion: '0.139.3' },
    )
    expect(message).toContain('agent-eval-rpc[dspy]==0.139.3')
  })
})
