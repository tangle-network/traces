import { describe, expect, it } from 'vitest'
import {
  createFindingRejectionTally,
  findingRejection,
  findingRejectionDetail,
  formatFindingRejections,
} from '../src/finding-rejections.js'

describe('finding rejections', () => {
  it('reads the analyst and the actionable reason from registry and direct log events', () => {
    expect(findingRejection('[failure-mode] finding rejected: unresolved evidence', {
      uri: 'trace://t/span/s',
      reason: 'excerpt is not present in the cited span content',
    })).toEqual({ analystId: 'failure-mode', reason: 'excerpt is not present in the cited span content' })
    expect(findingRejection('finding rejected: insufficient evidence citations', { required: 2, distinct: 1 }))
      .toEqual({ reason: 'insufficient evidence citations' })
    expect(findingRejection('[failure-mode] trace analyst failure-mode completed', {})).toBeUndefined()
  })

  it('formats one stderr detail with the cited URI and citation counts', () => {
    expect(findingRejectionDetail('[q1] finding rejected: unresolved evidence', {
      uri: 'trace://t/span/s',
      reason: 'trace span does not exist',
    })).toBe('trace span does not exist; uri trace://t/span/s')
    expect(findingRejectionDetail('finding rejected: insufficient evidence citations', { required: 2, distinct: 1 }))
      .toBe('insufficient evidence citations; 1 of 2 required distinct citation(s)')
    expect(findingRejectionDetail('[analyst] ok failure-mode', {})).toBeUndefined()
  })

  it('counts per analyst, with a default for unprefixed events', () => {
    const tally = createFindingRejectionTally('q1')
    tally.record('finding rejected: unresolved evidence', { reason: 'trace span does not exist' })
    tally.record('finding rejected: unresolved evidence', { reason: 'trace span does not exist' })
    tally.record('[improvement] finding rejected: schema failure', {})
    tally.record('trace analyst engine started', {})
    expect(tally.counts()).toEqual({
      q1: { 'trace span does not exist': 2 },
      improvement: { 'schema failure': 1 },
    })
    expect(formatFindingRejections(tally.counts().q1)).toBe('2 finding(s) rejected: trace span does not exist ×2')
    expect(formatFindingRejections(undefined)).toBe('')
  })
})
