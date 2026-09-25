/** Run on the customer's machine before a metadata-only trace transfer. */
import { writeFileSync } from 'node:fs'
import { assessSpans, readOtlpInput, redactSpans, serializeSpans, shareAllowed } from '../../src/index.js'
import { stripContent } from './metadata-only.js'

const [input, output, ...extra] = process.argv.slice(2)
if (!input || !output || extra.length) {
  console.error('usage: tsx diagnosis-kit/checks/scrub-export.ts <raw-otlp-jsonl> <metadata-only-jsonl>')
  process.exit(2)
}

async function main() {
  const ingested = await readOtlpInput(input)
  if (ingested.spans.length === 0) throw new Error('input contains no readable spans')
  const { spans: metadataOnly, dropped } = stripContent(ingested.spans)
  const { spans, report } = redactSpans(metadataOnly)
  const verdict = assessSpans(spans)
  if (!shareAllowed(verdict)) {
    throw new Error(`redacted spans are ${verdict.status} (${verdict.findings.map((f) => `${f.detector} at ${f.paths.join(', ')}`).concat(verdict.unreadable).join('; ')}); nothing was written`)
  }
  writeFileSync(output, serializeSpans(spans), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ output, spans: spans.length, droppedAttributes: dropped, redactionCount: report.redactionCount, byDetector: report.byDetector, verdict: verdict.status }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
