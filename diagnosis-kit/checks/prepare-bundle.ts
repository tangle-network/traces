/**
 * Prepare the metadata-only bundle inside one customer engagement, with the
 * public CLI: `traces check --share-safe` reads the received file as bytes,
 * then `traces convert --no-content` writes `bundle/spans.flat.jsonl`. A file
 * the customer did not export metadata-only is refused, and nothing is kept.
 */
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { reason, traces } from './traces.js'

/** The OTLP reader adds this marker to every tool span; it carries no argument. */
const READER_MARKER = 'tool.args_captured'

interface ShareVerdict {
  status: string
  findings: Array<{ severity: string; detector: string; paths: string[] }>
  unreadable: string[]
}

const dir = process.argv[2]
if (!dir || process.argv.length !== 3) {
  console.error('usage: tsx diagnosis-kit/checks/prepare-bundle.ts <engagement-dir>')
  process.exit(2)
}

function main(engagementDir: string): void {
  const engagement = JSON.parse(readFileSync(join(engagementDir, 'engagement.json'), 'utf8'))
  if (engagement.contentIncluded) throw new Error('this preparation command is metadata-only; use an approved content redactor for an opted-in engagement')
  const root = realpathSync(engagementDir)
  const incoming = realpathSync(join(engagementDir, 'incoming'))
  const bundle = realpathSync(join(engagementDir, 'bundle'))
  if (incoming !== join(root, 'incoming') || bundle !== join(root, 'bundle')) throw new Error('engagement inputs and bundle must be local directories, not symlinks')
  const input = join(incoming, 'spans.otlp.jsonl')
  if (lstatSync(input).isSymbolicLink()) throw new Error('incoming trace must be a local file, not a symlink')
  const output = join(bundle, 'spans.flat.jsonl')
  if (existsSync(output)) throw new Error(`${output} already exists; review it before replacing a customer bundle`)

  const gate = traces(['check', input, '--share-safe', '--format', 'json'])
  // stdout carries the verdict whatever the exit code; it is empty only when the check could not run.
  const verdict = gate.stdout.trim() ? (JSON.parse(gate.stdout) as { gates: Array<{ verdict: ShareVerdict }> }).gates[0]?.verdict : undefined
  if (gate.code !== 0) {
    const detail = verdict
      ? verdict.findings.filter((f) => f.severity === 'error').map((f) => `${f.detector} at ${f.paths.join(', ')}`).concat(verdict.unreadable).join('; ')
      : reason(gate)
    throw new Error(`received trace is ${verdict?.status ?? 'unreadable'} (${detail}); remove the incoming file and request a customer-side metadata-only export`)
  }

  const converted = traces(['convert', input, '--no-content', '--out', output, '--format', 'json'])
  if (converted.code !== 0) throw new Error(`traces convert could not read the incoming trace: ${reason(converted)}`)
  const summary = JSON.parse(converted.stdout) as { out: string; spans: number; droppedAttributes: string[] }
  const unexpected = summary.droppedAttributes.filter((key) => key !== READER_MARKER)
  if (unexpected.length > 0 || summary.spans === 0) {
    rmSync(output, { force: true })
    throw new Error(
      summary.spans === 0
        ? 'incoming/ contains no readable spans; nothing was written'
        : `received trace contains content-bearing attributes (${unexpected.join(', ')}); nothing was written. ` +
          'Remove the incoming file and request a customer-side metadata-only export',
    )
  }
  chmodSync(output, 0o600)
  console.log(JSON.stringify({ output, spans: summary.spans, droppedAttributes: summary.droppedAttributes, verdict: verdict?.status }))
}

try {
  main(dir)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
