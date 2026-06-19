/**
 * Add support for a new harness: implement HarnessTraceAdapter (locate + parse),
 * then use it via the `adapters` option — no registry edit, no fork.
 *
 *   tsx examples/register-harness.ts
 */
import { collectSessions, type HarnessTraceAdapter, span } from '@tangle-network/traces'

const myAdapter: HarnessTraceAdapter = {
  harness: 'my-agent',
  async locate() {
    // Discover this harness's session files on disk and return refs.
    return [{ harness: 'my-agent', sessionId: 'demo', path: '/tmp/demo', cwd: null, mtimeMs: Date.now() }]
  },
  async parse(ref) {
    // Project the harness's native log onto normalized OTLP spans.
    const now = new Date().toISOString()
    return [
      span({ traceId: ref.sessionId, spanId: 'root', name: 'session', kind: 'AGENT', startTime: now }),
      span({ traceId: ref.sessionId, spanId: 's1', parentSpanId: 'root', name: 'tool.bash', kind: 'TOOL', startTime: now, tool: 'bash', content: 'ls' }),
    ]
  },
}

const [batch] = await collectSessions({ adapters: [myAdapter] })
console.log(`${batch?.spans.length ?? 0} spans from ${batch?.ref.harness}`)
