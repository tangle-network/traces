/**
 * Live observer → alert. Tails active sessions across all harnesses and fires
 * when an agent gets stuck in a loop. Read-only; Ctrl-C to stop.
 *
 *   tsx examples/observe-and-alert.ts
 */
import { watchSessions } from '@tangle-network/traces'

const controller = new AbortController()
process.on('SIGINT', () => controller.abort())

await watchSessions({
  all: true,
  signal: controller.signal,
  onLoop: (loop) => {
    // Swap console.log for Slack / PagerDuty / your alerter.
    console.log(`[${loop.harness}] ${loop.sessionId.slice(0, 8)} stuck: ${loop.toolName} ×${loop.occurrences}`)
  },
})
