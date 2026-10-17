/**
 * A faked clock for a spawned CLI, loaded before it with
 * `NODE_OPTIONS=--import=<this file's URL>`: the clock is a process boundary.
 *
 * The clock reads `FAKE_CLOCK_NOW` (an ISO time) and stands still, so every
 * timestamp the CLI prints is the same on every run. With
 * `FAKE_CLOCK_STEP_MS`, a timer of `FAKE_CLOCK_SLEEP_MS` (default 5 s, the
 * session poll interval) fires at once and moves the clock that far forward,
 * so a poll loop's next pass runs immediately, that much later. No other
 * timer is touched.
 */
const RealDate = Date
let now = RealDate.parse(process.env.FAKE_CLOCK_NOW ?? '')
if (!Number.isFinite(now)) throw new Error('FAKE_CLOCK_NOW must be an ISO time')

class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(now)
    else super(...args)
  }

  static now() {
    return now
  }
}
globalThis.Date = FakeDate

const step = Number(process.env.FAKE_CLOCK_STEP_MS ?? 0)
const sleep = Number(process.env.FAKE_CLOCK_SLEEP_MS ?? 5000)
if (step > 0) {
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms !== sleep) return realSetTimeout(callback, ms, ...args)
    now += step
    return realSetTimeout(callback, 0, ...args)
  }
}
