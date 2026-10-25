/**
 * Preloaded with `NODE_OPTIONS=--import <this file>` around a spawned CLI: the probe-start witness and
 * Runtime price-entry URL the CLI resolves are appended to the file `TRACES_IMPORT_LOG` names.
 * A test reads it to learn which packages a command loaded; the CLI is unchanged.
 */
import { register } from 'node:module'
import { appendFileSync } from 'node:fs'

if (process.env.TRACES_IMPORT_LOG) appendFileSync(process.env.TRACES_IMPORT_LOG, 'trace-price-import-probe-ready\n')

register(`data:text/javascript,${encodeURIComponent(`
import { appendFileSync } from 'node:fs'
export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context)
  if (process.env.TRACES_IMPORT_LOG && resolved.url.endsWith('/agent-runtime/dist/index.js')) appendFileSync(process.env.TRACES_IMPORT_LOG, resolved.url + '\\n')
  return resolved
}
`)}`)
