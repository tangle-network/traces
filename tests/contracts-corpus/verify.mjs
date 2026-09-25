#!/usr/bin/env node
/**
 * Data corpus, not a unit test suite: real Claude Code session transcripts,
 * real contracts, and the verdicts they must produce. Run over agent-eval's
 * contract engine through this repo's own `ClaudeAdapter` (the same class
 * `traces check`/`traces convert` use), so a change in either package that
 * flips one of these verdicts is caught here instead of discovered later
 * when `traces check` silently passes or fails a real trace. Every case
 * below was a real bug at some point:
 *
 *  - refund-desk / paths (row 6): the same-output/wrong-tool-path pair a
 *    contract must separate. Both are saved session transcripts, which carry
 *    no `run.status` (see docs/trace-contracts.md) — the pair has no `run`
 *    key for exactly that reason. agent-eval#829 briefly broke this pair by
 *    making every `run` rule fail closed on an undeclared status, including
 *    on session transcripts that were never supposed to declare one.
 *  - tools-strict (rows 1, 8, 13): a trace WITH real TOOL/LLM evidence must
 *    still evaluate `run`/`tools.enforced`/`llm.maxTotalTokens` normally, not
 *    error — the capture-evidence fix (agent-eval#846) must not become a
 *    false positive on a trace that has real evidence.
 *  - sub (row 7): a subagent's own tool call, scoped under its `Agent` call,
 *    must be visible — the in-stream `parent_tool_use_id` fix.
 *  - payments (row 14): a retried write with no idempotency key must fail,
 *    and with one, must pass.
 *
 * Run: node tests/contracts-corpus/verify.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { checkTraceContracts, compileTraceContractSpec } from '@tangle-network/agent-eval'
import { ClaudeAdapter } from '../../src/adapters/claude.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SESSIONS = join(HERE, 'sessions')
const adapter = new ClaudeAdapter()

async function spansForSession(fileName) {
  const otlpSpans = await adapter.parse({
    harness: 'claude-code',
    sessionId: fileName.replace(/\.jsonl$/, ''),
    path: join(SESSIONS, fileName),
    cwd: null,
    mtimeMs: 0,
  })
  return otlpSpans.map((s) => ({
    spanId: s.span_id,
    parentSpanId: s.parent_span_id ?? undefined,
    name: s.name,
    kind: s.kind,
    startedAt: s.start_time ? Date.parse(s.start_time) : undefined,
    endedAt: s.end_time ? Date.parse(s.end_time) : undefined,
    status: s.status?.code,
    attributes: s.attributes ?? {},
  }))
}

function contract(fileName) {
  return compileTraceContractSpec(JSON.parse(readFileSync(join(HERE, fileName), 'utf8')))
}

let failures = 0
async function expect(label, session, contractFile, wantStatus) {
  const spans = await spansForSession(session)
  const result = checkTraceContracts(spans, [contract(contractFile)])
  const v = result.verdicts[0]
  const ok = v.status === wantStatus
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: got ${v.status} (want ${wantStatus}) — ${v.notes}`)
  if (!ok) {
    failures += 1
    for (const violation of v.violations) console.log(`       ${violation.detail}`)
    for (const error of v.errors) console.log(`       error: ${error}`)
  }
}

async function main() {
  // Row 6: same output, wrong tool path.
  await expect(
    'refund-desk / Read path (correct)',
    'be7a34a2-129b-4f06-ba07-85c69b6ba709.jsonl',
    'refund-desk.contract.json',
    'pass',
  )
  await expect(
    'refund-desk / Bash path (wrong)',
    '0c04a660-cf17-40a1-abfe-672f882f766e.jsonl',
    'refund-desk.contract.json',
    'fail',
  )
  await expect(
    'paths (alternatives.anyOf) / Read path (correct)',
    'be7a34a2-129b-4f06-ba07-85c69b6ba709.jsonl',
    'paths.contract.json',
    'pass',
  )
  await expect(
    'paths (alternatives.anyOf) / Bash path (wrong)',
    '0c04a660-cf17-40a1-abfe-672f882f766e.jsonl',
    'paths.contract.json',
    'fail',
  )

  // Rows 1, 8, 13: real evidence must evaluate normally, not error.
  await expect(
    'tools-strict: run + tools.enforced + token ceiling',
    'tools-strict.jsonl',
    'tools-strict.contract.json',
    'pass',
  )

  // Row 7: in-stream subagent parenting.
  await expect('subagent: Read visible scoped under its Agent call', 'subagent.jsonl', 'sub.contract.json', 'pass')

  // Row 14: retry safety.
  await expect('retry-keys0: charge repeated with no idempotency key', 'retry-keys0.jsonl', 'payments.contract.json', 'fail')
  await expect('retry-keys1: charge repeated WITH an idempotency key', 'retry-keys1.jsonl', 'payments.contract.json', 'pass')

  console.log(failures === 0 ? '\nall contracts-corpus cases hold' : `\n${failures} case(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
