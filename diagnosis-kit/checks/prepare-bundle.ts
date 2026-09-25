/** Prepare the metadata-only bundle inside one customer engagement. */
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assessSpans, readOtlpInput, redactSpans, serializeSpans, shareAllowed } from '../../src/index.js'
import { stripContent } from './metadata-only.js'

const dir = process.argv[2]
if (!dir || process.argv.length !== 3) {
  console.error('usage: tsx diagnosis-kit/checks/prepare-bundle.ts <engagement-dir>')
  process.exit(2)
}

async function main() {
  const engagement = JSON.parse(readFileSync(join(dir, 'engagement.json'), 'utf8'))
  if (engagement.contentIncluded) throw new Error('this preparation command is metadata-only; use an approved content redactor for an opted-in engagement')
  const root = realpathSync(dir)
  const incoming = realpathSync(join(dir, 'incoming'))
  const bundle = realpathSync(join(dir, 'bundle'))
  if (incoming !== join(root, 'incoming') || bundle !== join(root, 'bundle')) throw new Error('engagement inputs and bundle must be local directories, not symlinks')
  const input = join(incoming, 'spans.otlp.jsonl')
  if (lstatSync(input).isSymbolicLink()) throw new Error('incoming trace must be a local file, not a symlink')
  const output = join(bundle, 'spans.flat.jsonl')
  if (existsSync(output)) throw new Error(`${output} already exists; review it before replacing a customer bundle`)
  const ingested = await readOtlpInput(input)
  if (ingested.spans.length === 0) throw new Error('incoming/ contains no readable spans')
  const { spans: metadataOnly, dropped } = stripContent(ingested.spans)
  const { spans, report } = redactSpans(metadataOnly)
  // The OTLP reader synthesizes this marker while normalizing tool spans.
  // It contains no tool argument and is removed before writing the bundle.
  const unexpected = dropped.filter((key) => key !== 'tool.args_captured')
  if (unexpected.length || report.redactionCount) {
    throw new Error('received trace contains content-bearing attributes or structured secrets; remove the incoming file and request a customer-side metadata-only export')
  }
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
