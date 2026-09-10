/**
 * Answer schemas for `traces ask`.
 *
 * A question may fix the shape of its answer with a JSON Schema, so a scorer
 * can compare fields exactly instead of reading prose. This package carries no
 * JSON Schema library, so it checks a small subset and REJECTS any schema that
 * uses a keyword outside it: a schema whose constraint is silently ignored
 * would let a wrong answer pass as checked.
 *
 * Supported keywords: `type`, `properties`, `required`, `additionalProperties`
 * (boolean), `items` (one schema), `enum`, `const`, and the annotations
 * `title` and `description`. The four keywords that constrain one JSON type
 * must declare that type: `required` without `"type": "object"`, or `items`
 * without `"type": "array"`, checks nothing against an answer of another shape.
 */

export type AnswerSchema = Readonly<Record<string, unknown>>

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'title',
  'description',
])

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])

const MAX_SCHEMA_DEPTH = 32

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Throw a TypeError naming the first unsupported or malformed part of `schema`. */
export function assertAnswerSchema(schema: unknown, path = 'answerSchema', depth = 0): asserts schema is AnswerSchema {
  if (depth > MAX_SCHEMA_DEPTH) throw new TypeError(`${path}: schema nesting exceeds ${MAX_SCHEMA_DEPTH} levels`)
  if (!isRecord(schema)) throw new TypeError(`${path} must be a JSON Schema object`)
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new TypeError(
        `${path}: unsupported JSON Schema keyword "${key}"; supported: ${[...SUPPORTED_KEYWORDS].join(', ')}`,
      )
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (types.length === 0 || !types.every((type) => typeof type === 'string' && JSON_TYPES.has(type))) {
      throw new TypeError(`${path}.type must be one of ${[...JSON_TYPES].join(', ')}, or an array of them`)
    }
  }
  // `properties`, `required`, `additionalProperties` and `items` constrain one
  // JSON type each and are skipped for every other type. A schema that carries
  // one without declaring that type checks nothing at all against an answer of
  // the wrong shape — `{ required: ['a'] }` would accept the answer `5` — so it
  // is rejected here rather than passing a wrong answer as checked.
  const declared = schema.type === undefined
    ? undefined
    : (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[]
  for (const keyword of ['properties', 'required', 'additionalProperties'] as const) {
    if (schema[keyword] !== undefined && !declared?.includes('object')) {
      throw new TypeError(`${path}: "${keyword}" is checked only for an object; declare "type": "object" alongside it`)
    }
  }
  if (schema.items !== undefined && !declared?.includes('array')) {
    throw new TypeError(`${path}: "items" is checked only for an array; declare "type": "array" alongside it`)
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new TypeError(`${path}.properties must be an object`)
    for (const [name, child] of Object.entries(schema.properties)) {
      assertAnswerSchema(child, `${path}.properties.${name}`, depth + 1)
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((name) => typeof name === 'string')) {
      throw new TypeError(`${path}.required must be an array of property names`)
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    throw new TypeError(`${path}.additionalProperties must be a boolean`)
  }
  if (schema.items !== undefined) assertAnswerSchema(schema.items, `${path}.items`, depth + 1)
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new TypeError(`${path}.enum must be a non-empty array`)
  }
  for (const key of ['title', 'description'] as const) {
    if (schema[key] !== undefined && typeof schema[key] !== 'string') {
      throw new TypeError(`${path}.${key} must be a string`)
    }
  }
}

function jsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function typeMatches(value: unknown, type: string): boolean {
  const actual = jsonType(value)
  return actual === type || (type === 'number' && actual === 'integer')
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Every way `value` breaks `schema`, as `$.path: problem` strings. Empty means
 * the value conforms. The schema must already have passed `assertAnswerSchema`.
 */
export function answerSchemaErrors(value: unknown, schema: AnswerSchema, path = '$'): string[] {
  const errors: string[] = []
  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[]
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${path}: expected ${types.join(' or ')}, got ${jsonType(value)}`)
      return errors
    }
  }
  if (schema.const !== undefined && !sameJson(value, schema.const)) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(value, option))) {
    errors.push(`${path}: expected one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`)
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const name of (schema.required as string[] | undefined) ?? []) {
      if (!(name in value)) errors.push(`${path}.${name}: required property is missing`)
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = properties[name]
      if (childSchema !== undefined) {
        errors.push(...answerSchemaErrors(child, childSchema as AnswerSchema, `${path}.${name}`))
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${name}: property is not allowed`)
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((entry, index) => {
      errors.push(...answerSchemaErrors(entry, schema.items as AnswerSchema, `${path}[${index}]`))
    })
  }
  return errors
}

/**
 * Read one JSON value from a model's answer text. The whole text is tried
 * first; a single fenced block is accepted because models wrap JSON in one
 * even when told not to. Anything else is a parse failure, not a guess.
 */
export function parseJsonAnswer(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim()
  const candidates = [trimmed]
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)
  if (fenced) candidates.push(fenced[1]!.trim())
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown }
    } catch {
      // Try the next candidate.
    }
  }
  return { ok: false, error: 'answer is not one JSON value' }
}
