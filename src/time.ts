/** Parse an ISO-8601 timestamp or an epoch-millis string to epoch ms.
 *  Returns 0 for empty/unparseable input (callers treat 0 as "unknown"). */
export function parseIsoToEpochMs(ts: string): number {
  if (!ts) return 0
  if (/^\d+$/.test(ts)) return Number(ts)
  const n = Date.parse(ts)
  return Number.isNaN(n) ? 0 : n
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
