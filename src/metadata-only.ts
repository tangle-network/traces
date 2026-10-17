/**
 * The one metadata-only rule: what `--no-content` keeps of a span on every
 * command (convert, upload; facts withholds the same text from its sheet),
 * what `analyze` builds its built-in analyst's store from, and what the
 * diagnosis kit's customer runs before a trace leaves their machine.
 *
 * Kept: span names, ids, times, status codes, tool names, models, token
 * counts, costs and the trace's shape, which is everything a loop, waste or
 * usage measure reads. Dropped:
 *   - content: prompts, replies, tool input and output, commands, and every
 *     spelling agent-eval's diagnosis rule knows (`gen_ai.input.messages`,
 *     `gen_ai.tool.call.arguments`, `llm.input_messages`, `*.content`, …);
 *   - error prose: status messages, exception and log text;
 *   - values derived from a payload (its size, digest or MIME type, which can
 *     reveal a short input), and whether arguments were captured;
 *   - what the person wrote outside the conversation: source-record
 *     locations, working directories, the session file name, the repository
 *     and branch names, and the brief a subagent was given;
 *   - every structured value, which no rule can vouch for.
 * A link's attributes follow the same rule.
 */

import { isContentAttribute } from '@tangle-network/agent-eval/diagnosis'
import { SUBAGENT_SPAWN_TASK_ATTR, SUBAGENT_TASK_ATTR } from './adapters/provenance.js'
import { ATTR, SESSION_CWD_ATTR } from './attributes.js'
import type { OtlpSpan } from './otlp.js'
import { SOURCE_ATTRIBUTE_PREFIX } from './source-location.js'

/** Computed from a tool payload: a short input's size or digest can reveal it. */
const PAYLOAD_DERIVED = /^(?:input|output)\.mime_type$|^traces\.(?:input|output)\.(?:bytes|sha256|truncated)$/i

/**
 * Paths, the repository and branch names, and assignment text: not content by
 * name, but written by the person. The subject key is the repository, or the
 * cwd's last segment when there is none.
 */
const WITHHELD = new Set<string>([
  'tool.args_captured',
  'cwd',
  SESSION_CWD_ATTR,
  ATTR.CWD,
  ATTR.ENVIRONMENT_CWD,
  ATTR.SESSION_FILE,
  ATTR.CORRUPTION_SOURCE_PATH,
  ATTR.SUBJECT_KEY,
  ATTR.GIT_REPOSITORY,
  ATTR.GIT_BRANCH,
  ATTR.GIT_BRANCH_NAME,
  SUBAGENT_TASK_ATTR,
  SUBAGENT_SPAWN_TASK_ATTR,
])

/** True when `--no-content` keeps this attribute. */
export function isMetadataAttribute(key: string, value: unknown): boolean {
  return !(
    isContentAttribute(key) ||
    PAYLOAD_DERIVED.test(key) ||
    WITHHELD.has(key) ||
    key.startsWith(SOURCE_ATTRIBUTE_PREFIX) ||
    (value !== null && typeof value === 'object')
  )
}

export interface MetadataOnlySpans {
  readonly spans: OtlpSpan[]
  /** Every attribute key the rule removed, sorted; `status.message` when a status carried one. */
  readonly dropped: string[]
}

/** The spans with their content dropped, and the keys that were. */
export function metadataOnly(spans: readonly OtlpSpan[]): MetadataOnlySpans {
  const dropped = new Set<string>()
  const keep = (attributes: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    const kept: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(attributes)) {
      if (isMetadataAttribute(key, value)) kept[key] = value
      else dropped.add(key)
    }
    return kept
  }
  const out = spans.map((span): OtlpSpan => {
    if (span.status.message) dropped.add('status.message')
    const links = span.links?.map((link) => (link.attributes ? { ...link, attributes: keep(link.attributes) } : link))
    return { ...span, attributes: keep(span.attributes), status: { code: span.status.code }, ...(links ? { links } : {}) }
  })
  return { spans: out, dropped: [...dropped].sort() }
}
