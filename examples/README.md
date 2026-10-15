# Examples

[traces](../README.md#docs) › Examples

Runnable examples for the SDK and config files. Run one with `pnpm tsx examples/<file>`.

| File | Shows |
|---|---|
| [`observe-and-alert.ts`](./observe-and-alert.ts) | tail live sessions and alert on stuck loops |
| [`custom-analyst.ts`](./custom-analyst.ts) | register and run your own analyst |
| [`improvement-config.mjs`](./improvement-config.mjs) | plug in BYO analysts for `traces stream` / `traces improve` |
| [`custom-backend.ts`](./custom-backend.ts) | redact + dedup + upload to your own sink |
| [`register-harness.ts`](./register-harness.ts) | add a new harness by implementing `HarnessTraceAdapter` |
| [`external-engines.ts`](./external-engines.ts) | drive HALO, Hodoscope, and an external PII scrubber |
