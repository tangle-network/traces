/**
 * `EXPORT_RULE` is a guarantee, and this is what makes it one.
 *
 * The table in `src/otlp.ts` names, per substituted field, what the export
 * writes: the producer's value (`faithful`), the producer's word or this
 * package's (`declared-or-analysed`), or this package's regardless (`analysed`).
 * It read as a contract while `status.code` was declared `faithful` and nothing
 * implemented it — a row with no readable status code came back out of a
 * re-export carrying `STATUS_CODE_UNSET`, and the `invalid-status` the source
 * earned was gone from the copy. The fixtures in `otlp-round-trip.test.ts` did
 * not catch it because the one status fixture used the one status shape that
 * happened to work.
 *
 * So the checks here are DERIVED from the table rather than written beside it.
 * Every field in `EXPORT_RULE` must have a probe, every probe must exercise both
 * producer states, and the assertion for each is chosen by the declared word:
 *
 *   1. VALUE — what the export actually writes, in both states.
 *   2. NO ERASURE — a `faithful` field loses no finding its source earned. This
 *      is the property the word promises, and it holds over the whole pipeline
 *      rather than over one function, so declaring a rule the READER never
 *      records fails here even when the exporter would have honoured it.
 *   3. STILL READABLE — every exported line survives `projectOtlpFlatLine`, the
 *      consumer whose hard requirement is the entire reason `analysed` exists.
 *      This is what stops `trace_id` being flipped to `faithful` on the grounds
 *      that faithful is always safer: it is not, and the table says why.
 *
 * Adding a sixth substituted field, or changing a field's word, cannot pass
 * without the probe and the behaviour agreeing.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATTR, deriveHexId, type TraceValidation } from '@tangle-network/agent-trace-contract'
import { projectOtlpFlatLine } from '@tangle-network/agent-eval/traces'
import { readOtlpInput, SUBSTITUTED_FIELDS_ATTR, type SubstitutedField } from '../src/otlp-input.js'
import { EXPORT_RULE, type ExportRule, type OtlpSpan, writeOtlpFile } from '../src/otlp.js'

type Row = Record<string, unknown>

const TRACE = deriveHexId('export-rule-trace', 16)
const id = (name: string) => deriveHexId(name, 8)
const ROOT = id('root')
const PROBE = id('probe')
const START = '2026-01-01T00:00:00.000Z'
const END = '2026-01-01T00:00:10.000Z'

/** A fully conforming span: every probe below breaks exactly one field of it. */
function span(over: Row = {}): Row {
  return {
    trace_id: TRACE,
    span_id: PROBE,
    parent_span_id: ROOT,
    name: 'coder turn',
    kind: 'LLM',
    start_time: START,
    end_time: END,
    status: { code: 'STATUS_CODE_OK', message: '' },
    attributes: {
      'openinference.span.kind': 'LLM',
      'gen_ai.request.model': 'glm-5.2',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 340,
    },
    ...over,
  }
}

/** The conforming container the probe hangs under, so no probe is a lone root. */
function root(): Row {
  return {
    trace_id: TRACE,
    span_id: ROOT,
    parent_span_id: '',
    name: 'round 1',
    kind: 'CHAIN',
    start_time: START,
    end_time: END,
    status: { code: 'STATUS_CODE_OK', message: '' },
    attributes: { 'openinference.span.kind': 'CHAIN' },
  }
}

function without(row: Row, field: string): Row {
  const copy = { ...row }
  delete copy[field]
  return copy
}

/** Where the field lands on an exported OpenInference span. */
const EXPORT_PATH: Readonly<Record<SubstitutedField, readonly string[]>> = Object.freeze({
  trace_id: ['trace_id'],
  end_time: ['end_time'],
  'status.code': ['status', 'code'],
  kind: ['kind'],
  links: ['links'],
})

/**
 * The ANALYSED value of the field, read off the in-memory span the reader
 * produced — which IS this package's analysis, so nothing here restates the
 * exporter's arithmetic back to it.
 */
const ANALYSED: Readonly<Record<SubstitutedField, (span: OtlpSpan) => unknown>> = Object.freeze({
  trace_id: (span) => span.trace_id,
  end_time: (span) => span.end_time,
  'status.code': (span) => `STATUS_CODE_${span.status.code}`,
  kind: (span) => span.attributes[ATTR.spanKind],
  links: (span) => (span.links && span.links.length > 0 ? span.links.map((link) => ({ ...link })) : undefined),
})

/**
 * The two producer states every substituted field has to answer for, because
 * they are what `producerField` distinguishes: a producer who wrote something
 * this package could not use, and a producer who wrote nothing at all. The
 * second is the state that erased three findings across three audits, and the
 * one a probe table is most likely to omit.
 */
interface FieldProbes {
  /** A row where the producer WROTE a value this package substitutes away. */
  readonly wrote: { readonly row: Row; readonly value: unknown }
  /**
   * A row where the producer wrote NO usable value for the field.
   *
   * `unreachable` names the reason no row can reach that state — and the row is
   * still required, because the claim is checked rather than taken: the field
   * must come back NOT substituted, which is the only thing that makes "the
   * producer wrote nothing" impossible for it.
   */
  readonly absent: { readonly row: Row } | { readonly unreachable: string; readonly row: Row }
}

const PROBES: Readonly<Record<SubstitutedField, FieldProbes>> = Object.freeze({
  // An empty string is a written trace id this package cannot group by, so it
  // mints one; omitting the field is the same substitution with nothing kept.
  trace_id: {
    wrote: { row: span({ trace_id: '' }), value: '' },
    absent: { row: without(span(), 'trace_id') },
  },
  end_time: {
    wrote: { row: span({ end_time: 'whenever' }), value: 'whenever' },
    absent: { row: without(span(), 'end_time') },
  },
  'status.code': {
    wrote: { row: span({ status: { code: 'WEIRD', message: 'exit 2' } }), value: 'WEIRD' },
    absent: { row: without(span(), 'status') },
  },
  kind: {
    wrote: {
      row: span({ kind: 'SPAN_KIND_TELEPATHY', attributes: { 'openinference.span.kind': 'SPAN_KIND_TELEPATHY' } }),
      value: 'SPAN_KIND_TELEPATHY',
    },
    absent: { row: without(span({ attributes: {} }), 'kind') },
  },
  links: {
    wrote: {
      row: span({ links: [{ attributes: { 'agent.link.kind': 'steered_by' } }] }),
      value: [{ attributes: { 'agent.link.kind': 'steered_by' } }],
    },
    absent: {
      row: without(span(), 'links'),
      unreachable:
        'a links substitution is recorded only where the producer wrote a `links` value the reader could ' +
        'not copy faithfully, so there is no state in which the field was substituted and the producer ' +
        'wrote nothing. Asserted below as the behaviour that makes it true: a row with no `links` records ' +
        'no links substitution at all',
    },
  },
})

/** `{ present: false }`, or the value found at the path. */
function readPath(value: unknown, path: readonly string[]): { present: false } | { present: true; value: unknown } {
  let current: unknown = value
  for (const [index, key] of path.entries()) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return { present: false }
    if (!(key in (current as Record<string, unknown>))) return { present: false }
    current = (current as Record<string, unknown>)[key]
    if (index === path.length - 1) return { present: true, value: current }
  }
  return { present: false }
}

interface ProbeRun {
  /** The exported OpenInference span for the probe row. */
  readonly exported: Record<string, unknown>
  /** Every exported line, to prove the artifact stays readable as a whole. */
  readonly exportedLines: readonly Record<string, unknown>[]
  /** The in-memory span the reader analysed the probe row into. */
  readonly analysed: OtlpSpan
  readonly source: TraceValidation
  readonly artifact: TraceValidation
}

async function runProbe(row: Row): Promise<ProbeRun> {
  const dir = await mkdtemp(join(tmpdir(), 'traces-export-rule-'))
  const sourcePath = join(dir, 'source.otlp.jsonl')
  await writeFile(sourcePath, `${[root(), row].map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')

  const source = await readOtlpInput(sourcePath)
  const artifactPath = join(dir, 'artifact.otlp.jsonl')
  await writeOtlpFile(source.spans, artifactPath)
  const artifact = await readOtlpInput(artifactPath)

  const exportedLines = (await readFile(artifactPath, 'utf8'))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const exported = exportedLines.find((line) => line.span_id === PROBE)
  const analysed = source.spans.find((entry) => entry.span_id === PROBE)
  if (exported === undefined || analysed === undefined) {
    throw new Error(`probe span ${PROBE} did not survive the read/export it is meant to exercise`)
  }

  return { exported, exportedLines, analysed, source: source.validation, artifact: artifact.validation }
}

function codesOf(validation: TraceValidation): string[] {
  return [...new Set(validation.findings.map((finding) => finding.code))].sort()
}

const RULES = ['faithful', 'declared-or-analysed', 'analysed'] as const satisfies readonly ExportRule[]

const FIELDS = Object.keys(EXPORT_RULE) as SubstitutedField[]

describe('every field EXPORT_RULE declares behaves the way the declared word says', () => {
  it('the table, the probes and the vocabulary cover exactly the same fields', () => {
    const declared = [...FIELDS].sort()
    expect(Object.keys(PROBES).sort()).toEqual(declared)
    expect(Object.keys(EXPORT_PATH).sort()).toEqual(declared)
    expect(Object.keys(ANALYSED).sort()).toEqual(declared)
    // A rule word this file does not know how to check is a rule nothing checks.
    for (const field of FIELDS) expect(RULES).toContain(EXPORT_RULE[field])
  })

  for (const field of FIELDS) {
    const rule = EXPORT_RULE[field]
    const path = EXPORT_PATH[field]

    it(`${field} (${rule}): the export writes the producer's value when they wrote one`, async () => {
      const probe = PROBES[field].wrote
      const run = await runProbe(probe.row)
      // The probe has to actually reach the substitution, or it checks nothing.
      expect(String(run.analysed.attributes[SUBSTITUTED_FIELDS_ATTR] ?? '').split(',')).toContain(field)

      const found = readPath(run.exported, path)
      const analysed = ANALYSED[field](run.analysed)
      switch (rule) {
        case 'faithful':
        case 'declared-or-analysed':
          expect(found).toEqual({ present: true, value: probe.value })
          break
        case 'analysed':
          expect(found).toEqual({ present: true, value: analysed })
          // …and NOT the producer's, or the rule is `faithful` under another name.
          expect(found).not.toEqual({ present: true, value: probe.value })
          break
      }
    })

    it(`${field} (${rule}): the export ${rule === 'faithful' ? 'omits the field' : 'declares the analysed value'} when the producer wrote nothing`, async () => {
      const probe = PROBES[field].absent
      const run = await runProbe(probe.row)
      if ('unreachable' in probe) {
        // Hold the claim to its behaviour: if the field CAN be substituted with
        // nothing kept, the reason it "cannot happen" is stale.
        expect(String(run.analysed.attributes[SUBSTITUTED_FIELDS_ATTR] ?? '').split(',')).not.toContain(field)
        expect(readPath(run.exported, path).present).toBe(false)
        return
      }

      expect(String(run.analysed.attributes[SUBSTITUTED_FIELDS_ATTR] ?? '').split(',')).toContain(field)

      const found = readPath(run.exported, path)
      const analysed = ANALYSED[field](run.analysed)
      switch (rule) {
        case 'faithful':
          // Omitted, never defaulted: an absent field and a conforming default
          // are different traces to a validator, and only the first is true of
          // the source.
          expect(found).toEqual({ present: false })
          break
        case 'declared-or-analysed':
        case 'analysed':
          expect(found).toEqual({ present: true, value: analysed })
          break
      }
    })
  }

  for (const field of FIELDS.filter((entry) => EXPORT_RULE[entry] === 'faithful')) {
    it(`${field} (faithful): the artifact reports every finding the source earned`, async () => {
      const probes = PROBES[field]
      const rows = [probes.wrote.row, ...('unreachable' in probes.absent ? [] : [probes.absent.row])]
      for (const row of rows) {
        const run = await runProbe(row)
        // `faithful` is a promise about FINDINGS, not about a field: a copy that
        // validates cleaner than its own source is the whole defect, whichever
        // layer let it through.
        expect(codesOf(run.artifact)).toEqual(expect.arrayContaining(codesOf(run.source)))
      }
    })
  }

  it('every rule keeps the artifact readable by the consumer that forces `analysed`', async () => {
    for (const field of FIELDS) {
      const probes = PROBES[field]
      const rows = [probes.wrote.row, ...('unreachable' in probes.absent ? [] : [probes.absent.row])]
      for (const row of rows) {
        const run = await runProbe(row)
        // `analyze --otlp-out` hands this file straight to agent-eval's
        // OtlpFileTraceStore. A line it drops is a row that then throws
        // TraceFileMalformed, so an export rule that omits what that reader
        // hard-requires makes the artifact unreadable by the tool that reads it.
        for (const line of run.exportedLines) {
          expect(projectOtlpFlatLine(line), `${field}: an exported line is unreadable by projectOtlpFlatLine`)
            .not.toBeNull()
        }
      }
    }
  })
})
