import { findingRejectionDetail } from './finding-rejections.js'

/** A registry or engine line that reports a failure, not progress. */
const ANALYST_FAILURE = /\[analyst\] (?:FAIL|WARN) |\bmodel call \d+ FAIL\b/u

/**
 * The analysts' log on stderr: what failed, and nothing else. Progress (the
 * registry's `[analyst] ok <id>` and `skip` lines, each analyst's own notes,
 * the engine's `model call N ok`) is not printed: the report carries every
 * analyst's status, and stderr is for what went wrong. The registry's
 * `[analyst] FAIL <id>` line carries its reason only in the structured
 * fields; a message-only sink turns every engine-startup failure into an
 * unactionable one-liner.
 */
export function analystLog(msg: string, fields?: Record<string, unknown>): void {
  // A gate rejection names its cause only in the fields; without them the
  // line says a finding was dropped but not why, which nobody can act on.
  const rejection = findingRejectionDetail(msg, fields)
  if (rejection !== undefined) {
    process.stderr.write(rejection ? `${msg} — ${rejection}\n` : `${msg}\n`)
    return
  }
  if (!ANALYST_FAILURE.test(msg)) return
  const error = typeof fields?.error === 'string' && fields.error ? fields.error : undefined
  const errorClass = typeof fields?.error_class === 'string' && fields.error_class ? `${fields.error_class}: ` : ''
  process.stderr.write(error ? `${msg} — ${errorClass}${error}\n` : `${msg}\n`)
}
