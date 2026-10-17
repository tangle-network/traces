/**
 * The spans with their content dropped: no conversation text, no tool input or
 * output, no source-record location. Tool names, token counts, models, timing
 * and status codes stay, which is everything a loop, waste or usage measure
 * reads. `upload --no-content` sends these spans, and `analyze` builds the
 * built-in analyst's store from them.
 */

import { normalizeToolIoAttributes, TOOL_IO_VALUE_KEYS } from './adapters/tool-io.js'
import type { OtlpSpan } from './otlp.js'
import { stripSourceAttributes } from './source-location.js'

export function metadataOnly(spans: readonly OtlpSpan[]): OtlpSpan[] {
  return spans.map((s) => {
    const attributes = stripSourceAttributes(s.attributes)
    delete attributes.content
    for (const key of TOOL_IO_VALUE_KEYS) delete attributes[key]
    normalizeToolIoAttributes(attributes)
    const status = s.status.message ? { code: s.status.code } : s.status
    return { ...s, attributes, status }
  })
}
