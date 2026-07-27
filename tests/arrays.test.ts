import { describe, expect, it } from 'vitest'
import { appendAll } from '../src/arrays.js'

describe('appendAll', () => {
  it('appends collections larger than the JavaScript argument limit', () => {
    const source = Array.from({ length: 300_000 }, (_, index) => index)
    const target = [-1]

    appendAll(target, source)

    expect(target).toHaveLength(300_001)
    expect(target[0]).toBe(-1)
    expect(target.at(-1)).toBe(299_999)
  })
})
