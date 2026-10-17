/**
 * Each command's page embeds its `--help` verbatim, and the README embeds the
 * global help, so a reader of the docs sees exactly what the CLI prints. A
 * changed flag or help line fails here until its page changes with it.
 *
 * An embedded help is a fenced `text` block that opens with the CLI's own
 * first line: `Usage: traces <command>` for a command, the banner for `traces --help`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI, runCli } from './run-cli.js'

const ROOT = join(dirname(CLI), '..')
const DOCS = join(ROOT, 'docs')
const COMMANDS = ['list', 'facts', 'analyze', 'ask', 'check', 'diff', 'watch', 'convert', 'bundle', 'upload', 'skills', 'mcp'] as const
/** The 16 pages of docs/ (spec v2 section 3.3); release notes sit beside them. */
const PAGES = [
  'analyze.md', 'ask.md', 'bundle.md', 'check.md', 'convert.md', 'develop.md', 'diff.md', 'facts.md',
  'mcp.md', 'migrate-1.0.md', 'parsers.md', 'sdk.md', 'select.md', 'skills.md', 'upload.md', 'watch.md',
]

/** Every fenced `text` block of a markdown file. */
function textBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```text\n([\s\S]*?)^```$/gmu)].map((match) => match[1]!.replace(/\n$/u, ''))
}

const pages = PAGES.map((page) => ({ page, blocks: textBlocks(readFileSync(join(DOCS, page), 'utf8')) }))

describe('the help the docs embed', () => {
  it.each(COMMANDS)('traces %s --help is embedded once, verbatim', async (command) => {
    const run = await runCli([command, '--help'])
    expect(run.code).toBe(0)
    const embedded = pages.flatMap(({ page, blocks }) => blocks.filter((block) => block.startsWith(`Usage: traces ${command} `)).map((block) => ({ page, block })))
    expect(embedded.map(({ page }) => page)).toHaveLength(1)
    expect(embedded[0]!.block).toBe(run.stdout.replace(/\n$/u, ''))
  })

  it('traces --help is embedded in the README, verbatim', async () => {
    const run = await runCli(['--help'])
    const first = run.stdout.split('\n')[0]!
    const embedded = textBlocks(readFileSync(join(ROOT, 'README.md'), 'utf8')).filter((block) => block.startsWith(first))
    expect(embedded).toEqual([run.stdout.replace(/\n$/u, '')])
  })

  it('docs/ is the 16 pages, at most 950 lines', () => {
    const markdown = readdirSync(DOCS).filter((name) => name.endsWith('.md') && !name.startsWith('release-'))
    expect(markdown.sort()).toEqual([...PAGES].sort())
    const lines = PAGES.reduce((total, page) => total + readFileSync(join(DOCS, page), 'utf8').trimEnd().split('\n').length, 0)
    expect(lines).toBeLessThanOrEqual(950)
  })
})
