/**
 * The measurable half of a diagnosis: turn a customer's spans into scored runs
 * and print the numbers that go in the report.
 *
 * Everything here is deterministic and calls no model, so it runs unchanged for a
 * customer who refuses third-party model processing. That refusal costs them the
 * model-written findings, not the measurement.
 *
 * Boundary: content-bearing attributes are dropped before anything else touches the
 * spans. Regex redaction runs after, as a second line rather than the first, because
 * it does not catch names or account numbers written in prose.
 *
 * Usage:
 *   tsx diagnosis-kit/checks/run-checks.ts <spans.otlp.jsonl|dir> [--content]
 */

import { readOtlpInput, redactSpans, runPipelines, TRACES_REDACTION_RULES } from '../../src/index.js'
import { isContentAttribute } from '@tangle-network/agent-eval/diagnosis'
import type { OtlpSpan } from '../../src/otlp.js'

/** Attributes that carry customer prose. Dropped unless content capture was opted into. */
function stripContent(spans: readonly OtlpSpan[]): { spans: OtlpSpan[]; dropped: string[] } {
  const dropped = new Set<string>()
  const out = spans.map((s) => {
    const attributes: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(s.attributes ?? {})) {
      if (isContentAttribute(k)) {
        dropped.add(k)
        continue
      }
      attributes[k] = v
    }
    return { ...s, attributes }
  })
  return { spans: out, dropped: [...dropped].sort() }
}

async function main() {
  const [input, ...flags] = process.argv.slice(2)
  if (!input) {
    console.error('usage: run-checks.ts <spans.otlp.jsonl|dir> [--content]')
    process.exit(2)
  }
  const contentOptIn = flags.includes('--content')

  const ingested = await readOtlpInput(input)
  const { spans: metadataOnly, dropped } = contentOptIn
    ? { spans: [...ingested.spans], dropped: [] as string[] }
    : stripContent(ingested.spans)
  const { spans, report: redaction } = redactSpans(metadataOnly, TRACES_REDACTION_RULES)

  // runPipelines consumes the normalized spans we just scrubbed, so the redaction
  // boundary sits upstream of every detector. It returns stuck loops (same tool, same
  // args, repeated), failure clusters and per-tool usage metrics — all deterministic.
  const pipelines = await runPipelines(spans)

  // The shape below feeds templates/report.md. Keep the field names aligned with
  // templates/findings.schema.json so the renderer never has to guess.
  console.log(
    JSON.stringify(
      {
        subject: { spanCount: spans.length, contentIncluded: contentOptIn },
        coverage: {
          // The trace's own conformance verdict, not our reading of it. This is what
          // populates the "what we could not see" table on page one of the report.
          validation: ingested.validation,
          unreadableRows: ingested.unreadable,
          redaction: {
            redactionCount: redaction.redactionCount,
            byRule: redaction.byRule,
            droppedAttributes: dropped,
          },
        },
        measures: {
          stuckLoops: pipelines.stuckLoops,
          failureClusters: pipelines.failureClusters,
          toolUse: pipelines.toolUse,
          failureFollowUps: pipelines.failureFollowUps,
        },
      },
      null,
      2,
    ),
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
