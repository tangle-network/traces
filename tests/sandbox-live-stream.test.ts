/**
 * A Sandbox live stream of an OpenCode run (traces#206): every tool call is
 * one TOOL span carrying its input, so facts counts exactly the calls the
 * Sandbox lists in its own `result.toolInvocations`.
 *
 * The stream records each call twice, as the Sandbox's `message.part.updated`
 * (`data.part`) and inside the harness's raw `tool_use` envelope
 * (`data.event.part`), with one part id. The fixture has that real shape;
 * discovery-lab's ablation report reads these counts.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { runCli } from './run-cli.js'

const stream = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sandbox-live-stream', 'opencode-tool-calls.jsonl')

interface Invocation {
  toolName: string
  arguments: Record<string, unknown>
}

let dir: string
let env: Record<string, string>
let invocations: Invocation[]
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'traces-live-stream-'))
  env = { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') }
  // The oracle: the Sandbox's own list of the run's tool calls, read from the raw stream.
  const result = (await readFile(stream, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { type: string; data?: { toolInvocations?: Invocation[] } })
    .find((row) => row.type === 'result')
  invocations = result!.data!.toolInvocations!
})

function countByName(names: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1
  return counts
}

describe('an OpenCode Sandbox live stream', () => {
  it("counts each tool call once, as the Sandbox's toolInvocations list them", async () => {
    const run = await runCli(['facts', stream, '--format', 'json'], { env })
    expect(run.code, run.stderr).toBe(0)
    const session = (JSON.parse(run.stdout) as {
      sessions: Array<{ toolCalls: { value: number }; toolCallsByName: { value: Record<string, number> } }>
    }).sessions[0]!
    expect(session.toolCalls.value).toBe(invocations.length)
    expect(session.toolCallsByName.value).toEqual(countByName(invocations.map((call) => call.toolName)))
  })

  it('writes every tool span with the input the call ran', async () => {
    const out = join(dir, 'spans.otlp.jsonl')
    expect((await runCli(['convert', stream, '--out', out], { env })).code).toBe(0)
    const tools = (await readFile(out, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { attributes: Record<string, unknown> })
      .filter((span) => span.attributes['openinference.span.kind'] === 'TOOL')
    expect(tools.map((span) => span.attributes['tool.name'])).toEqual(invocations.map((call) => call.toolName))
    for (const [index, span] of tools.entries()) {
      expect(span.attributes['tool.args_captured']).toBe(true)
      expect(JSON.parse(span.attributes['input.value'] as string)).toEqual(invocations[index]!.arguments)
    }
  })

  it('reads the commands the bash calls ran', async () => {
    const run = await runCli(['facts', stream, '--match', '^pnpm test', '--format', 'json'], { env })
    expect(run.code, run.stderr).toBe(0)
    const commands = (JSON.parse(run.stdout) as { matches: Array<{ kind: string; text: string }> }).matches
      .filter((match) => match.kind === 'command')
    const expected = invocations.filter((call) => call.arguments.command === 'pnpm test').length
    expect(expected).toBe(2)
    expect(commands.map((match) => match.text)).toEqual(Array(expected).fill('pnpm test'))
  })
})
