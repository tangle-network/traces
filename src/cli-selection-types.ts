import type { Args } from './commands.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'
import type { ResolvedRef } from './refs.js'

/**
 * What a command's positional refs resolved to. Read once, before the command
 * runs, so every reader below sees the same sessions and files.
 */
export interface RefSelection {
  /** Harness sessions a ref named: an id, a unique prefix or suffix, or a session file. */
  readonly sessions: ReadonlyArray<{ readonly adapter: HarnessTraceAdapter; readonly ref: SessionRef }>
  /** Span sources a ref named: OTLP or trace evidence files and directories, bundles, run directories. */
  readonly spans: ReadonlyArray<Extract<ResolvedRef, { kind: 'spans' | 'run-dir' }>>
  /** A store root: selection runs over it instead of HOME. */
  readonly home?: string
}

/** A parsed command line, with its refs resolved for the commands that read them. */
export type CliArgs = Args & { selection?: RefSelection }

