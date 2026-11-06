/** `traces behavior`: what each agent did per window, read a session at a time; exit 2 when no span is a tool call. */
import { behaviorReader, renderBehaviorText } from './behavior.js'
import type { CliArgs } from './cli-selection-types.js'
import { CliError } from './commands.js'
import type { OtlpSpan } from './otlp.js'

export async function cmdBehavior(args: CliArgs, forEachBatch: (onBatch: (spans: readonly OtlpSpan[]) => Promise<void>) => Promise<{ spanCount: number }>): Promise<void> {
  const reader = behaviorReader(args.window === undefined ? {} : { windowMs: args.window })
  if ((await forEachBatch(async (spans) => reader.add(spans))).spanCount === 0) throw new Error('no spans found for the given selection')
  let result: ReturnType<typeof reader.result>
  try {
    result = reader.result()
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'no-outcome') throw error
    throw new CliError(error instanceof Error ? error.message : String(error), 'no-outcome')
  }
  process.stdout.write(args.format === 'json' ? `${JSON.stringify(result)}\n` : `${renderBehaviorText(result)}\n`)
}
