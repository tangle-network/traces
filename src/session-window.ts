import type { SessionFactsWindow } from './session-facts.js'

/** Epoch bounds of a window; `null` when the window is absent or open on both sides. */
export interface WindowBounds {
  readonly since: string | null
  readonly until: string | null
  readonly sinceMs: number
  readonly untilMs: number
}

export function windowBounds(window: SessionFactsWindow | undefined): WindowBounds | null {
  if (!window || (window.since === undefined && window.until === undefined)) return null
  const bound = (value: string | undefined, name: string, open: number): number => {
    if (value === undefined) return open
    const ms = Date.parse(value)
    if (!Number.isFinite(ms)) throw new RangeError(`window ${name} is not a readable time: ${value}`)
    return ms
  }
  const sinceMs = bound(window.since, 'since', Number.NEGATIVE_INFINITY)
  const untilMs = bound(window.until, 'until', Number.POSITIVE_INFINITY)
  if (!(sinceMs < untilMs)) throw new RangeError(`window since (${window.since}) must be before until (${window.until})`)
  return {
    since: window.since === undefined ? null : new Date(sinceMs).toISOString(),
    until: window.until === undefined ? null : new Date(untilMs).toISOString(),
    sinceMs,
    untilMs,
  }
}

export function insideWindow(bounds: WindowBounds | null, time: string): boolean {
  if (bounds === null) return true
  const ms = Date.parse(time)
  return Number.isFinite(ms) && ms >= bounds.sinceMs && ms < bounds.untilMs
}

