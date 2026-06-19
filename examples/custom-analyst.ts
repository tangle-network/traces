/**
 * Run your OWN analyst over a session instead of the built-in suite. Register
 * any detector/agent on agent-eval's AnalystRegistry and pass it to analyzeSpans.
 *
 *   tsx examples/custom-analyst.ts
 */
import { AnalystRegistry, analyzeSpans, collectSessions, makeFinding } from '@tangle-network/traces'

const registry = new AnalystRegistry()
registry.register({
  id: 'example-detector',
  description: 'a custom third-party analyst',
  inputKind: 'trace-store',
  cost: { kind: 'deterministic' },
  version: '1.0.0',
  async analyze(/* store: agent-eval TraceAnalysisStore — query it here */) {
    return [
      makeFinding({
        analyst_id: 'example-detector',
        area: 'custom',
        claim: 'custom analyst ran over the trace store',
        severity: 'info',
        evidence_refs: [],
        confidence: 0.9,
      }),
    ]
  },
})

const [session] = await collectSessions({ all: true, last: 1, redact: false })
if (!session) throw new Error('no recent sessions found')
const { result } = await analyzeSpans(session.spans, { registry })
console.log(result.findings)
