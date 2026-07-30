/** Parse an ISO-8601 timestamp or an epoch-millis string to epoch ms. */
export function parseIsoToEpochMs(ts: string): number {
  if (typeof ts !== 'string' || ts.trim().length === 0) {
    throw new TypeError('timestamp must be a non-empty string')
  }
  const value = ts.trim()
  const n = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(n) || !Number.isFinite(new Date(n).getTime())) {
    throw new TypeError(`invalid timestamp: ${ts}`)
  }
  return n
}

/** Parse a `--since` window: `30m` / `2h` / `7d` (relative to now) or an ISO
 *  date, → epoch ms. Throws on a malformed value (fail-loud, not silent). */
export function parseSince(value: string): number {
  const m = value.match(/^(\d+)\s*([mhd])$/i)
  if (m) {
    const unit = m[2]!.toLowerCase()
    const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
    return Date.now() - Number(m[1]) * ms
  }
  const t = Date.parse(value)
  if (Number.isNaN(t)) throw new Error(`--since: expected 30m / 2h / 7d or an ISO date, got "${value}"`)
  return t
}
