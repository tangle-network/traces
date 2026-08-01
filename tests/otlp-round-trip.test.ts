/**
 * The round-trip invariant: reading a trace and re-exporting it must not change
 * what a validator says about it.
 *
 * `traces analyze --otlp <source> --otlp-out <artifact>` reads somebody else's
 * OTLP file and writes this package's own. The artifact is re-validated by the
 * next reader, so any defect the source earned and the artifact does not report
 * is a defect nobody will ever see again — the source file is usually gone by
 * then, and the copy carries a clean bill of health it did not earn.
 *
 * Three earlier audits asserted this invariant on the verdict, the exit code and
 * the capability list, and all three passed while findings were being erased,
 * because the FINDING SET is the thing that moves. So this asserts all four, and
 * asserts them as EQUALITY: every deviation is declared on the fixture that
 * deviates, next to the reason it is not laundering, and an undeclared deviation
 * fails. A blanket "some codes may differ" allowance is exactly the shape of
 * invariant that let this class of defect survive three audits.
 *
 * It also asserts CONVERGENCE. A copy of a copy must say what the copy said, or
 * the artifact drifts one finding per hop and a chain of re-exports launders a
 * defect by length.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { traceContractBuildId } from '../src/contract-build.js'
import {
  deriveHexId,
  type FindingCode,
  MAX_SPANS_READ,
  type TraceValidation,
  validateTraceSpans,
} from '@tangle-network/agent-trace-contract'
import { validationExitCode } from '../src/conformance.js'
import { readOtlpInput } from '../src/otlp-input.js'
import { writeOtlpFile } from '../src/otlp.js'

const TRACE = deriveHexId('round-trip-trace', 16)
const OTHER_TRACE = deriveHexId('round-trip-trace-b', 16)
const id = (name: string) => deriveHexId(name, 8)

const START = '2026-01-01T00:00:00.000Z'
const END = '2026-01-01T00:00:10.000Z'

type Row = Record<string, unknown>

function span(over: Row): Row {
  return {
    trace_id: TRACE,
    span_id: id('span'),
    parent_span_id: '',
    name: 'span',
    start_time: START,
    end_time: END,
    status: { code: 'STATUS_CODE_OK', message: '' },
    attributes: {},
    ...over,
  }
}

/** A conforming container: the root every other fixture hangs its spans under. */
function root(over: Row = {}): Row {
  return span({
    span_id: id('root'),
    name: 'round 1',
    kind: 'CHAIN',
    attributes: { 'openinference.span.kind': 'CHAIN', 'agent.loop.id': 'loop-a', 'agent.loop.iteration': 1 },
    ...over,
  })
}

/** A conforming model call: declared LLM, priced, with usage. */
function llm(over: Row = {}): Row {
  return span({
    span_id: id('llm'),
    parent_span_id: id('root'),
    name: 'coder turn',
    kind: 'LLM',
    attributes: {
      'openinference.span.kind': 'LLM',
      'gen_ai.request.model': 'glm-5.2',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 340,
      'gen_ai.usage.cost.total': 0.0042,
    },
    ...over,
  })
}

/** A conforming, named tool call. */
function tool(over: Row = {}): Row {
  return span({
    span_id: id('tool'),
    parent_span_id: id('root'),
    name: 'bash',
    kind: 'TOOL',
    attributes: { 'openinference.span.kind': 'TOOL', 'gen_ai.tool.name': 'Bash' },
    ...over,
  })
}

function without(row: Row, field: string): Row {
  const copy = { ...row }
  delete copy[field]
  return copy
}

interface RoundTripFixture {
  readonly name: string
  readonly rows: () => readonly unknown[]
  /** Finding codes the fixture exists to exercise, as the SOURCE reports them. */
  readonly exercises: readonly FindingCode[]
  /**
   * Codes the source reports that the artifact provably CANNOT, each with the
   * reason. This is the only place erasure is allowed, and every entry is a row
   * that is not a span and therefore cannot be re-emitted as one.
   */
  readonly erased?: Readonly<Partial<Record<FindingCode, string>>>
  /** Codes the artifact reports that the source did not, each with the reason. */
  readonly added?: Readonly<Partial<Record<FindingCode, string>>>
}

/**
 * The reason every `added` entry below shares: when a producer declares no kind,
 * this package's classification becomes the ARTIFACT's declaration.
 *
 * The artifact is also the store this package's analysts, agent-eval and HALO
 * read, and a span with no kind there is re-derived differently by each of them
 * — the tool-telemetry demotion that stops a tool call being counted twice is
 * one such re-derivation. So the export declares a kind. A declared kind is held
 * to a higher standard by the validator than an unclassified span, so a copy can
 * report `missing-model` / `missing-tool-name` / `no-usage` the source did not.
 *
 * That direction is the safe one and the test only tolerates it in that
 * direction: the copy is MORE self-critical than the source, never less, and
 * `converges at hop 2` pins it to a single hop rather than a per-hop drift.
 */
const DECLARED_BY_INFERENCE =
  'the producer declared no kind; the artifact declares the one this package inferred, so the validator ' +
  'holds the copy to the standard of a declared span — a finding gained, never one lost'

const FIXTURES: readonly RoundTripFixture[] = [
  {
    name: 'a conforming trace stays conforming',
    rows: () => [root(), llm(), tool()],
    exercises: [],
  },
  {
    name: 'readable, non-hex ids',
    rows: () => [
      root({ span_id: 'round-1', trace_id: 'my-run' }),
      llm({ span_id: 'llm-1', trace_id: 'my-run', parent_span_id: 'round-1' }),
    ],
    exercises: ['non-hex-id'],
  },
  {
    name: 'no trace id at all',
    rows: () => [without(root(), 'trace_id'), without(llm(), 'trace_id')],
    exercises: ['missing-trace-id'],
    erased: {
      'missing-trace-id': 'the ONE field the export cannot be faithful about. `analyze --otlp-out` hands the ' +
        'artifact straight to agent-eval\'s OtlpFileTraceStore, whose projectOtlpFlatLine drops any row with a ' +
        'falsy trace_id and then throws TraceFileMalformed on the drop — so an artifact that omits the id is ' +
        'unreadable by the tool that reads it. The id is minted, the substitution is recorded per span under ' +
        '`traces.substituted_fields`, and `renderConformance` states it above the findings so a reader of the ' +
        'artifact is told rather than left to assume the source carried one',
    },
    added: {
      'non-hex-id': 'a consequence of the minted id above, and true of the copy: `otlp:<file>` is not a W3C ' +
        'trace id, so the artifact genuinely cannot be joined to a traceparent',
    },
  },
  {
    name: 'a parent that is not in the export',
    rows: () => [root(), llm({ parent_span_id: id('nobody') })],
    exercises: ['orphan-parent'],
  },
  {
    name: 'a parent cycle',
    rows: () => [
      span({ span_id: id('a'), parent_span_id: id('b'), name: 'a', kind: 'CHAIN', attributes: { 'openinference.span.kind': 'CHAIN' } }),
      span({ span_id: id('b'), parent_span_id: id('a'), name: 'b', kind: 'CHAIN', attributes: { 'openinference.span.kind': 'CHAIN' } }),
    ],
    exercises: ['cyclic-parent'],
  },
  {
    name: 'a parent in another trace',
    rows: () => [root(), llm({ trace_id: OTHER_TRACE })],
    exercises: ['cross-trace-parent'],
  },
  {
    name: 'every span its own root',
    rows: () => [llm({ span_id: id('l1'), parent_span_id: '' }), llm({ span_id: id('l2'), parent_span_id: '' }), llm({ span_id: id('l3'), parent_span_id: '' })],
    exercises: ['flat-hierarchy'],
  },
  {
    // Analysed as start_time so the span keeps its identity — and writing THAT
    // clamp into the export erased the finding AND flipped `latency-analysis` to
    // available on a copy of a trace that never supported it.
    name: 'an end time nothing can parse',
    rows: () => [root(), llm({ end_time: 'whenever' })],
    exercises: ['invalid-timestamp'],
  },
  {
    name: 'no end time at all',
    rows: () => [root(), without(llm(), 'end_time')],
    exercises: ['invalid-timestamp'],
  },
  {
    name: 'an end before its start',
    rows: () => [root(), llm({ start_time: END, end_time: START })],
    exercises: ['negative-duration'],
  },
  {
    name: 'a status code outside the vocabulary',
    rows: () => [root(), llm({ status: { code: 'WEIRD', message: 'exit 2' } })],
    exercises: ['invalid-status'],
  },
  // The three shapes below are the same finding as the one above and were NOT
  // the same code path: a producer who wrote a word this package could not use
  // left a raw value to re-emit, and a producer who wrote no readable code at
  // all left none — so the substitution went unrecorded and the export declared
  // the conforming `STATUS_CODE_UNSET` this package had inferred. One status
  // fixture, on the one shape that happened to work, is how a `faithful` rule
  // stayed unimplemented through three audits.
  {
    name: 'no status at all',
    rows: () => [root(), without(llm(), 'status')],
    exercises: ['invalid-status'],
  },
  {
    name: 'a status with no code in it',
    rows: () => [root(), llm({ status: { message: 'exit 2' } })],
    exercises: ['invalid-status'],
  },
  {
    name: 'a status that is not an object',
    rows: () => [root(), llm({ status: 'OK' })],
    exercises: ['invalid-status'],
  },
  {
    // The producer's own word is what earns the finding, so the export carries
    // that word — not the kind this package analysed the span as.
    name: 'a span kind the producer coined',
    rows: () => [
      root(),
      llm({
        kind: 'SPAN_KIND_TELEPATHY',
        attributes: {
          'openinference.span.kind': 'SPAN_KIND_TELEPATHY',
          'gen_ai.request.model': 'glm-5.2',
          'gen_ai.usage.input_tokens': 10,
          'gen_ai.usage.output_tokens': 5,
        },
      }),
    ],
    exercises: ['unknown-span-kind'],
  },
  {
    name: 'a declared model call with no model',
    rows: () => [
      root(),
      llm({ attributes: { 'openinference.span.kind': 'LLM', 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 5 } }),
    ],
    exercises: ['missing-model'],
  },
  {
    name: 'a declared model call with no usage',
    rows: () => [root(), llm({ attributes: { 'openinference.span.kind': 'LLM', 'gen_ai.request.model': 'glm-5.2' } })],
    exercises: ['no-usage'],
  },
  {
    name: 'a declared tool call with no tool name',
    rows: () => [root(), tool({ attributes: { 'openinference.span.kind': 'TOOL' } })],
    exercises: ['missing-tool-name'],
  },
  {
    name: 'a link pointing at a span that is not here',
    rows: () => [root(), llm({ links: [{ trace_id: TRACE, span_id: id('ghost'), attributes: { 'agent.link.kind': 'steered_by' } }] })],
    exercises: ['dangling-link'],
  },
  {
    // The reader drops a link naming no target, because it cannot be followed.
    // Dropping it from the EXPORT is what erased the finding, so the producer's
    // own `links` value rides along and is re-emitted verbatim.
    name: 'a link naming no target',
    rows: () => [root(), llm({ links: [{ attributes: { 'agent.link.kind': 'steered_by' } }] })],
    exercises: ['dangling-link'],
  },
  {
    name: 'one span id in two traces',
    rows: () => [root(), llm(), llm({ trace_id: OTHER_TRACE, parent_span_id: '' })],
    exercises: ['duplicate-span-id'],
  },
  {
    name: 'the same span declared twice, identically',
    rows: () => [root(), llm(), llm()],
    exercises: ['redeclared-span'],
    erased: {
      'redeclared-span': 'identical re-declarations are MERGED by the reader — that is what makes a ' +
        'multi-shot export, where every file re-declares the ancestors it hangs from, analysable at all. ' +
        'The artifact holds one span, so it has no re-declaration to report; the merge is counted per file ' +
        'and rendered as `Identical repeats` in the ingest table instead',
    },
  },
  {
    name: 'rows that are not spans',
    rows: () => [root(), llm(), 42, { hello: 'world' }],
    exercises: ['invalid-span'],
    erased: {
      'invalid-span': 'a row that is not a span cannot be re-emitted as one — the artifact is also the ' +
        'store this package\'s analysts read, so a non-span line would be garbage fed to the analysis and a ' +
        'repaired one would be invented work. The loss is declared instead: every span of the artifact ' +
        'carries `traces.source.unreadable_rows`, and validating a re-export says so before any finding',
    },
  },
  {
    name: 'a span this package classifies as a tool and the producer did not',
    rows: () => [root(), span({ span_id: id('t2'), parent_span_id: id('root'), name: 'run tool step' })],
    exercises: [],
    added: { 'missing-tool-name': DECLARED_BY_INFERENCE },
  },
  {
    name: 'a span this package classifies as a model call and the producer did not',
    rows: () => [root(), span({ span_id: id('l9'), parent_span_id: id('root'), name: 'model llm turn' })],
    exercises: [],
    added: { 'missing-model': DECLARED_BY_INFERENCE, 'no-usage': DECLARED_BY_INFERENCE },
  },
  {
    // The demotion that stops an execution child being counted as a second tool
    // call is an inferred kind too, and it must survive the trip without
    // reporting anything new about the copy.
    name: 'a tool-execution child demoted to a container',
    rows: () => [
      root(),
      tool(),
      span({ span_id: id('t4'), parent_span_id: id('tool'), name: 'exec', attributes: { 'span.type': 'tool.execution', 'tool.name': 'Bash' } }),
    ],
    exercises: [],
  },
  {
    name: 'a file with nothing in it',
    rows: () => [],
    exercises: ['no-spans'],
  },
  {
    // The bound is the contract's, not this reader's: the reader has none, so
    // the artifact carries the same entry count and clips at the same place.
    name: 'more entries than a validator will read',
    rows: () => {
      const rows: Row[] = []
      for (let index = 0; index <= MAX_SPANS_READ; index += 1) {
        rows.push(span({ span_id: index.toString(16).padStart(16, '0'), name: 's', attributes: { 'openinference.span.kind': 'CHAIN' } }))
      }
      return rows
    },
    exercises: ['truncated-input'],
  },
]

/**
 * Codes no fixture can exercise, because the reader cannot produce the input
 * that raises them. Stated, not omitted: a code missing from the coverage
 * assertion with no entry here is an unasserted corner of the invariant.
 */
const UNREACHABLE_CODES: Readonly<Partial<Record<FindingCode, string>>> = {
  'invalid-input': 'raised only when the validated value is not an array of entries at all. `readOtlpInput` ' +
    'parses JSONL into an array and validates THAT, so no file can reach it — asserted directly below',
}

/**
 * Every code the contract's validator can emit, pinned here so the coverage
 * assertion is over the whole vocabulary rather than over the codes this file
 * happens to think of. `satisfies` fails the typecheck if the contract renames
 * or removes one.
 */
const ALL_FINDING_CODES = [
  'invalid-input',
  'no-spans',
  'invalid-span',
  'truncated-input',
  'duplicate-span-id',
  'redeclared-span',
  'non-hex-id',
  'missing-trace-id',
  'orphan-parent',
  'cyclic-parent',
  'cross-trace-parent',
  'flat-hierarchy',
  'invalid-timestamp',
  'negative-duration',
  'invalid-status',
  'unknown-span-kind',
  'missing-model',
  'no-usage',
  'missing-tool-name',
  'dangling-link',
] as const satisfies readonly FindingCode[]

function codesOf(validation: TraceValidation): string[] {
  return [...new Set(validation.findings.map((finding) => finding.code))].sort()
}

function capabilitiesOf(validation: TraceValidation): Record<string, boolean> {
  return Object.fromEntries(validation.capabilities.map((capability) => [capability.name, capability.available]))
}

interface RoundTrip {
  readonly source: TraceValidation
  readonly artifact: TraceValidation
  readonly copyOfCopy: TraceValidation
  /** Every value handed to the validator, to prove `invalid-input` is unreachable. */
  readonly validated: readonly unknown[][]
}

/**
 * Write the fixture, read it, export it, re-validate the export — then do it
 * once more, because a defect that reappears on the second hop is a drift and
 * not a round trip.
 */
async function roundTrip(fixture: RoundTripFixture): Promise<RoundTrip> {
  const dir = await mkdtemp(join(tmpdir(), 'traces-round-trip-'))
  const sourcePath = join(dir, 'source.otlp.jsonl')
  await writeFile(sourcePath, `${fixture.rows().map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

  const source = await readOtlpInput(sourcePath)
  const artifactPath = join(dir, 'artifact.otlp.jsonl')
  await writeOtlpFile(source.spans, artifactPath)

  const artifact = await readOtlpInput(artifactPath)
  const secondPath = join(dir, 'artifact-of-artifact.otlp.jsonl')
  await writeOtlpFile(artifact.spans, secondPath)
  const copyOfCopy = await readOtlpInput(secondPath)

  return {
    source: source.validation,
    artifact: artifact.validation,
    copyOfCopy: copyOfCopy.validation,
    validated: [source.rows as unknown[], artifact.rows as unknown[], copyOfCopy.rows as unknown[]],
  }
}

describe('re-exporting a trace does not change what a validator says about it', () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, async () => {
      const trip = await roundTrip(fixture)

      // The fixture exercises what it claims to, or it is testing nothing.
      expect(codesOf(trip.source)).toEqual(expect.arrayContaining([...fixture.exercises]))

      // Verdict, exit code and capabilities: equal, with no exception mechanism.
      // A caller decides whether to spend a run on these three.
      expect(trip.artifact.ok).toBe(trip.source.ok)
      expect(validationExitCode(trip.artifact)).toBe(validationExitCode(trip.source))
      expect(capabilitiesOf(trip.artifact)).toEqual(capabilitiesOf(trip.source))

      // The finding set: equal, modulo deviations DECLARED on this fixture.
      const expected = [
        ...codesOf(trip.source).filter((code) => !(code in (fixture.erased ?? {}))),
        ...Object.keys(fixture.added ?? {}),
      ].sort()
      expect(codesOf(trip.artifact)).toEqual(expected)

      // Every declared deviation is real: an `erased` code the artifact still
      // reports, or an `added` code the source already had, is a stale excuse.
      for (const code of Object.keys(fixture.erased ?? {})) {
        expect(codesOf(trip.source)).toContain(code)
        expect(codesOf(trip.artifact)).not.toContain(code)
      }
      for (const code of Object.keys(fixture.added ?? {})) {
        expect(codesOf(trip.source)).not.toContain(code)
        expect(codesOf(trip.artifact)).toContain(code)
      }

      // A copy of the copy says what the copy said: the deviation is one hop,
      // not one per hop.
      expect(codesOf(trip.copyOfCopy)).toEqual(codesOf(trip.artifact))
      expect(capabilitiesOf(trip.copyOfCopy)).toEqual(capabilitiesOf(trip.artifact))
      expect(trip.copyOfCopy.ok).toBe(trip.artifact.ok)

      // `invalid-input` is unreachable because of this, on every hop.
      for (const rows of trip.validated) expect(Array.isArray(rows)).toBe(true)
    })
  }

  it('every exported span names the contract build that produced it', async () => {
    // The artifact's verdicts are one build's reading (see src/contract-build.ts),
    // so every line this package writes must say WHICH — the same stamp
    // cli-bridge puts on its request spans and VB puts on its run spans, at the
    // resource level so it survives further round trips. Omit-never-fake: the
    // attribute is the installed tree's digest or absent, never a placeholder —
    // here the tree is readable, so it must be present and must be THE digest.
    const expected = traceContractBuildId()
    expect(expected).toMatch(/^[0-9a-f]{64}$/)

    const dir = await mkdtemp(join(tmpdir(), 'traces-contract-stamp-'))
    const sourcePath = join(dir, 'source.otlp.jsonl')
    await writeFile(sourcePath, `${[root(), llm(), tool()].map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    const source = await readOtlpInput(sourcePath)
    const artifactPath = join(dir, 'artifact.otlp.jsonl')
    await writeOtlpFile(source.spans, artifactPath)

    const lines = (await readFile(artifactPath, 'utf8')).trim().split('\n')
    expect(lines.length).toBe(3)
    for (const line of lines) {
      const exported = JSON.parse(line) as { resource?: { attributes?: Record<string, unknown> } }
      expect(exported.resource?.attributes?.['traces.trace_contract.build']).toBe(expected)
    }

    // The stamp survives a second hop: a re-export signs with ITS build too.
    const artifact = await readOtlpInput(artifactPath)
    const secondPath = join(dir, 'artifact-of-artifact.otlp.jsonl')
    await writeOtlpFile(artifact.spans, secondPath)
    for (const line of (await readFile(secondPath, 'utf8')).trim().split('\n')) {
      const exported = JSON.parse(line) as { resource?: { attributes?: Record<string, unknown> } }
      expect(exported.resource?.attributes?.['traces.trace_contract.build']).toBe(expected)
    }
  })

  it('the fixtures exercise every finding code the reader can emit', async () => {
    const exercised = new Set(FIXTURES.flatMap((fixture) => fixture.exercises))
    for (const fixture of FIXTURES) for (const code of Object.keys(fixture.added ?? {})) exercised.add(code as FindingCode)
    const missing = ALL_FINDING_CODES.filter((code) => !exercised.has(code) && !(code in UNREACHABLE_CODES))
    expect(missing).toEqual([])
    // And the unreachable list is not a place to park a code that IS reachable.
    for (const code of Object.keys(UNREACHABLE_CODES)) expect(exercised.has(code as FindingCode)).toBe(false)
  })

  it('`invalid-input` is a real code, raised by the one input a file cannot be', () => {
    const notAnArray = validateTraceSpans('spans' as unknown as never)
    expect(codesOf(notAnArray)).toContain('invalid-input')
    expect(notAnArray.ok).toBe(false)
  })
})
