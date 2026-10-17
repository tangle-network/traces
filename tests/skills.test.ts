import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const skillNames = ['inspect-agent-traces'] as const

describe.each(skillNames)('%s skill', (name) => {
  const skillSpecifier = `@tangle-network/traces/skills/${name}/SKILL.md`
  const skillUrl = import.meta.resolve(skillSpecifier)
  const skillPath = fileURLToPath(skillUrl)

  it('is a compact public skill with final-only chaining', async () => {
    const content = await readFile(skillPath, 'utf8')
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/)?.[1]

    expect(frontmatter).toBeDefined()
    expect(frontmatter?.match(/^name:\s*(.+)$/m)?.[1]).toBe(name)
    const description = frontmatter?.match(/^description:\s*(.+)$/m)?.[1] ?? ''
    expect(description.length).toBeGreaterThan(0)
    expect(description.length).toBeLessThanOrEqual(96)
    expect(content.trimEnd().split('\n').length).toBeLessThanOrEqual(60)
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(5_000)
    expect(content).not.toContain('TODO')
    expect(content).not.toContain('—')

    const footer = content.lastIndexOf('\n## Then consider\n')
    expect(footer).toBeGreaterThan(0)
    expect(content.slice(footer + 1)).not.toMatch(/\n## /)
  })

  it('has matching agent metadata and valid local references', async () => {
    const content = await readFile(skillPath, 'utf8')
    const metadataUrl = new URL('./agents/openai.yaml', skillUrl)
    const metadata = await readFile(metadataUrl, 'utf8')

    expect(metadata).toContain(`$${name}`)

    const localLinks = [...content.matchAll(/\]\((\.\.\/\.\.\/[^)#]+)(?:#[^)]+)?\)/g)]
    for (const [, target] of localLinks) {
      await expect(readFile(new URL(target!, skillUrl), 'utf8')).resolves.not.toHaveLength(0)
    }
  })
})

it('maps questions to commands and never teaches parsing a store', async () => {
  const skillUrl = new URL('../skills/inspect-agent-traces/SKILL.md', import.meta.url)
  const content = await readFile(skillUrl, 'utf8')

  for (const command of ['list', 'facts', 'analyze', 'diff', 'check', 'watch', 'ask', 'bundle']) {
    expect(content).toContain(`\`traces ${command} `)
  }
  expect(content).toContain('never parse session stores yourself')
  expect(content).not.toMatch(/~\/\.claude\/projects|\.codex\/sessions|\bjq -r '\.message/u)
})
