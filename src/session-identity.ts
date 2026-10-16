/**
 * Who acted in a session: the profile, model, harness, skill set and directive
 * variant, read under agent-trace-contract's `ATTR` keys.
 *
 * Three sources, in precedence order, each key taken from the first that has it:
 *
 *   1. `spans`: the root span's `agent.*` attributes, written by any producer on
 *      agent-trace-contract 2.1.0 or later (agent-runtime runs). A supervised run
 *      has one identity per node, so only the root speaks for the session; the
 *      rest stays on the spans.
 *   2. `session-identity`: `<home>/.local/state/session-identity/claude-code/<id>.json`,
 *      written by dotfiles' SessionStart hook for interactive Claude Code. Its
 *      `attributes` already use the `ATTR` keys.
 *   3. `directives-log`: `<home>/.claude/directives-log.jsonl`, which names only
 *      the directive variant, for Claude Code sessions from before the record.
 *
 * An absent key stays absent; nothing is filled with a placeholder.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ATTR } from '@tangle-network/agent-trace-contract'

/** Who acted, as `traces facts` reports it per session. */
export interface AgentIdentityFact {
  readonly profileDigest?: string
  readonly profileName?: string
  readonly model?: string
  readonly harness?: string
  readonly skillsDigest?: string
  readonly directiveVariant?: string
  /** The first source, in precedence order, that supplied any key. */
  readonly source: AgentIdentitySourceName
}

export type AgentIdentitySourceName = 'spans' | 'session-identity' | 'directives-log'

type IdentityField = Exclude<keyof AgentIdentityFact, 'source'>

/** Each identity field and the contract attribute that carries it. */
export const AGENT_IDENTITY_KEYS: ReadonlyArray<readonly [IdentityField, string]> = [
  ['profileDigest', ATTR.profileDigest],
  ['profileName', ATTR.profileName],
  ['model', ATTR.agentModel],
  ['harness', ATTR.harness],
  ['skillsDigest', ATTR.skillsDigest],
  ['directiveVariant', ATTR.directiveVariant],
]

/** One source's identity fields, before precedence is applied. */
export interface AgentIdentitySource {
  readonly source: AgentIdentitySourceName
  readonly fields: Readonly<Partial<Record<IdentityField, string>>>
}

/**
 * The sources outside the spans that may say who acted in one session, in
 * precedence order, or the reason none can. The facts sheet calls it once per
 * session; `traces facts` builds one from the home it reads.
 */
export type AgentIdentityLookup = (session: { readonly sessionId: string; readonly harness: string | null }) =>
  { readonly sources: readonly AgentIdentitySource[]; readonly reason: string }

/** The identity fields an attribute map carries under the contract's keys. */
export function identityFieldsOf(attributes: Readonly<Record<string, unknown>>): AgentIdentitySource['fields'] {
  const fields: Partial<Record<IdentityField, string>> = {}
  for (const [field, key] of AGENT_IDENTITY_KEYS) {
    const value = attributes[key]
    if (typeof value === 'string' && value.length > 0) fields[field] = value
  }
  return fields
}

/** Each key from the first source that has it; null when no source has any. */
export function mergeAgentIdentity(sources: readonly AgentIdentitySource[]): AgentIdentityFact | null {
  const merged: Partial<Record<IdentityField, string>> = {}
  let source: AgentIdentitySourceName | null = null
  for (const entry of sources) {
    for (const [field] of AGENT_IDENTITY_KEYS) {
      const value = entry.fields[field]
      if (value === undefined || merged[field] !== undefined) continue
      merged[field] = value
      source ??= entry.source
    }
  }
  return source === null ? null : { ...merged, source }
}

/** A session id that is one plain path segment, as the hook requires before writing. */
const PLAIN_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u

const RECORD_DIR = join('.local', 'state', 'session-identity', 'claude-code')
const DIRECTIVES_LOG = join('.claude', 'directives-log.jsonl')

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/**
 * The Claude Code identity sources under `home` (HOME, or a store root such as
 * a trace archive's `<host>/home`). The directives log is read once, on the
 * first session that needs it; the first variant logged for a session wins,
 * because the hook pins it for the session's life.
 */
export function sessionIdentityLookup(home: string): AgentIdentityLookup {
  let variants: Map<string, string> | undefined
  const variantOf = (sessionId: string): string | undefined => {
    if (variants === undefined) {
      variants = new Map()
      let text = ''
      try {
        text = readFileSync(join(home, DIRECTIVES_LOG), 'utf8')
      } catch {
        // No log: no session has a logged variant.
      }
      for (const line of text.split('\n')) {
        if (!line.includes('"variant"')) continue
        try {
          const row = JSON.parse(line) as { session?: unknown; variant?: unknown }
          if (typeof row.session === 'string' && typeof row.variant === 'string' && row.variant.length > 0 && !variants.has(row.session)) {
            variants.set(row.session, row.variant)
          }
        } catch {
          // A torn line names nothing.
        }
      }
    }
    return variants.get(sessionId)
  }
  return ({ sessionId, harness }) => {
    if (harness !== 'claude-code') {
      return { sources: [], reason: `no hook records who acted in ${harness ?? 'this harness\'s'} sessions, so only spans could say` }
    }
    const recordPath = join(home, RECORD_DIR, `${sessionId}.json`)
    const sources: AgentIdentitySource[] = []
    if (PLAIN_ID.test(sessionId)) {
      const record = readJson(recordPath)
      const attributes = record !== null && typeof record === 'object'
        ? (record as { attributes?: unknown }).attributes
        : undefined
      if (attributes !== null && typeof attributes === 'object') {
        const fields = identityFieldsOf(attributes as Record<string, unknown>)
        if (Object.keys(fields).length > 0) sources.push({ source: 'session-identity', fields })
      }
    }
    const variant = variantOf(sessionId)
    if (variant !== undefined) sources.push({ source: 'directives-log', fields: { directiveVariant: variant } })
    return {
      sources,
      reason:
        `no session identity record at ${recordPath} and no entry in ${join(home, DIRECTIVES_LOG)}: ` +
        'the session predates the SessionStart hook that writes the record, or the hook is not installed',
    }
  }
}
