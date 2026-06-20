/**
 * Run trace analyzers and PII scrubbers that traces does NOT bundle — you install
 * the tool, traces drives it. Same pattern for any future engine/model.
 *
 *   pnpm tsx examples/external-engines.ts
 */
import {
  applyRedactor,
  collectSessions,
  commandRedactor,
  haloAnalyzer,
  writeOtlpFile,
} from '@tangle-network/traces'

const [batch] = await collectSessions({ harnesses: ['claude-code'], last: 1 })
if (!batch) {
  console.log('no claude-code sessions found')
  process.exit(0)
}

// 1) External ANALYZER — emit the OTLP artifact, then run HALO over it as a peer
//    to the built-in analysts. (Install HALO: github.com/context-labs/halo)
const otlp = await writeOtlpFile(batch.spans, '/tmp/session.otlp.jsonl')
const halo = haloAnalyzer({ defaultPrompt: 'diagnose stuck loops and wasted tokens' })
const analysis = await halo.analyze(otlp)
console.log(analysis.ok ? analysis.output : `halo unavailable: ${analysis.error}`)

// 2) External REDACTOR — scrub prose with your own PII model before upload. The
//    command reads a JSON array of strings on stdin and writes the scrubbed array
//    on stdout (a 3-line wrapper adapts openai/privacy-filter's `opf`).
const redactor = commandRedactor({ command: 'my-pii-scrubber' })
const { spans, changed } = await applyRedactor(batch.spans, redactor)
console.log(`scrubbed ${changed} content field(s) across ${spans.length} spans`)
