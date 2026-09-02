import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
const publish = readFileSync('.github/workflows/publish.yml', 'utf8')

describe('release runtime contract', () => {
  it('tests Node 24 and the minimum supported Node 22 version', () => {
    expect(readFileSync('.nvmrc', 'utf8').trim()).toBe('24.18.0')
    expect(ci).toContain('node-version: [24.18.0, 22.13.0]')
  })

  it('publishes through npm trusted publishing without a write token', () => {
    expect(publish).toContain('id-token: write')
    expect(publish).toContain('node-version: 24.18.0')
    expect(publish).toContain('npm publish --access public --ignore-scripts')
    expect(publish).not.toContain('NODE_AUTH_TOKEN')
    expect(publish).not.toContain('registry-url:')
    expect(publish).not.toContain('pnpm publish')
  })
})
