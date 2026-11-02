/** `traces behavior`: what each agent did per window, from the selected spans; exit 2 when no span is a tool call. */
import { behaviorFromSpans, renderBehaviorText } from './behavior.js'
import type { CliArgs } from './cli-selection-types.js'
import type { CollectedSpans } from './cli-span-input.js'
import { CliError } from './commands.js'

export async function cmdBehavior(args: CliArgs, readSpans: () => Promise<CollectedSpans>): Promise<void> {
  const { spans } = await readSpans()
  if (spans.length === 0) throw new Error('no spans found for the given selection')
  let result: ReturnType<typeof behaviorFromSpans>
  try {
    result = behaviorFromSpans(spans, args.window === undefined ? {} : { windowMs: args.window })
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'no-outcome') throw error
    throw new CliError(error instanceof Error ? error.message : String(error), 'no-outcome')
  }
  process.stdout.write(args.format === 'json' ? `${JSON.stringify(result)}\n` : `${renderBehaviorText(result)}\n`)
}
