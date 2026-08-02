/**
 * WHICH BUILD of the contract this repo's verdicts come from.
 *
 * Every conformance finding, capability and "this trace cannot answer X" in this
 * package is produced by `@tangle-network/agent-trace-contract`, so a claim
 * about a trace is only as good as the build that made it. Two builds declare
 * version `1.0.2` and behave differently — one bounds how many entries
 * `validateTraceSpans` reads and reports the clipping as `truncated-input`, the
 * other reads whatever the input's `length` claims — so a version comparison
 * passes on both and establishes nothing.
 *
 * These cases pin the build three ways: the symbol `MAX_SPANS_READ` and the
 * bound it names, the finding an oversized export must raise, and byte-for-byte
 * identity with the one build the repo's own pnpm-lock.yaml pins — an allowlist
 * derived from the lockfile, so ANY other tree fails, not just one remembered
 * bad one.
 */

import { describe, expect, it } from 'vitest'
import * as traceContract from '@tangle-network/agent-trace-contract'
import { validateTraceSpans, type ContractSpan } from '@tangle-network/agent-trace-contract'
import {
  EXPECTED_MAX_SPANS_READ,
  traceContractBuildId,
  verifyInstalledTraceContract,
} from '../src/contract-build.js'

describe('the installed contract build is the one with the bounded read', () => {
  // Read off the namespace, not as a named import: a named import of a symbol a
  // build lacks fails at link time and takes the whole FILE down before any
  // assertion runs, which reports as "cannot load" instead of "wrong build".
  const declaredBound: unknown = traceContract.MAX_SPANS_READ

  it('exports MAX_SPANS_READ, and it is the expected bound', () => {
    expect(
      typeof declaredBound,
      'the installed build does not export MAX_SPANS_READ, so it reads an export in full however large its length claims to be',
    ).toBe('number')
    expect(declaredBound).toBe(EXPECTED_MAX_SPANS_READ)
  })

  it('reports truncated-input when an export declares more entries than are read', () => {
    // Falls back to the pinned bound rather than deriving the probe size from
    // the module under test: a build with no bound would otherwise choose the
    // probe that lets it pass.
    const probeLength =
      (typeof declaredBound === 'number' && Number.isSafeInteger(declaredBound)
        ? declaredBound
        : EXPECTED_MAX_SPANS_READ) + 1
    // Sparse on purpose — `length` is a number a producer wrote, and the bound
    // exists so that number cannot decide how long this call runs.
    const oversized = new Array(probeLength)
    oversized[0] = { span_id: 'a'.repeat(16), name: 'probe' }
    const codes = validateTraceSpans(oversized as unknown as ContractSpan[]).findings.map(
      (entry) => entry.code,
    )
    expect(
      codes,
      `an export declaring ${probeLength} entries produced no truncated-input finding, so this build reads the whole declared length`,
    ).toContain('truncated-input')
  })

  it('is byte-identical to the build the lockfile pins', { timeout: 30_000 }, async () => {
    const provenance = await verifyInstalledTraceContract()
    expect(provenance.integrity).toMatch(/^sha512-/)
    expect(
      { missing: provenance.missing, extra: provenance.extra, mismatched: provenance.mismatched },
      `the installed tree at ${provenance.packageDir} is not the ${provenance.version} build pinned by pnpm-lock.yaml (${provenance.integrity})`,
    ).toEqual({ missing: [], extra: [], mismatched: [] })
    // The tree digest is what producers stamp; it must exist for the locked build.
    expect(traceContractBuildId()).toMatch(/^[0-9a-f]{64}$/)
  })
})
