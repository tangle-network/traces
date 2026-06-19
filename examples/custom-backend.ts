/**
 * Redact + dedup local sessions, then upload to your OWN sink instead of the
 * Tangle Intelligence Platform. The backend is any object with `ingestTraces`.
 *
 *   tsx examples/custom-backend.ts
 */
import { executeUpload, planUpload } from '@tangle-network/traces'

const plan = await planUpload({ all: true, sinceMs: Date.now() - 24 * 60 * 60 * 1000 })

const result = await executeUpload(plan, {
  backend: {
    async ingestTraces(spans, idempotencyKey) {
      // `spans` is already redacted. POST it anywhere: your DB, a vector store, S3.
      console.log(`send ${spans.length} spans (idempotency-key ${idempotencyKey})`)
      return { accepted: spans.length }
    },
  },
})

console.log(`uploaded ${result.uploadedSessions} sessions, ${result.acceptedSpans} spans`)
