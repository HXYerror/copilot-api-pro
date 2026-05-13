/**
 * Hourly retention sweeper for the telemetry `events` table (issue #34).
 *
 * Anchors the interval to the wall-clock hour boundary so multiple processes
 * (or restarts) converge on the same execution cadence rather than drifting.
 * Detects suspend-resume by comparing the delta between ticks to the
 * expected hour: if more than 2× expected elapses we log it and run an
 * immediate sweep instead of waiting for the next boundary.
 */

import consola from "consola"

import { getConfig } from "~/lib/config-store"

import { purgeEventsOlderThan } from "./events"

const ONE_HOUR_MS = 60 * 60 * 1000
const SUSPEND_DETECTION_FACTOR = 2

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Compute ms from `now` until the next wall-clock hour boundary. */
export function msUntilNextHour(now: number = Date.now()): number {
  const next = Math.ceil((now + 1) / ONE_HOUR_MS) * ONE_HOUR_MS
  return next - now
}

// ---------------------------------------------------------------------------
// Sweep tick
// ---------------------------------------------------------------------------

/**
 * Single sweep iteration: reads retention from the config (live, so the value
 * can hot-reload without restarting the sweeper) and asks the data layer to
 * purge anything older than the cutoff.
 *
 * `events_days = 0` is the documented "keep forever" sentinel — skipped.
 */
export async function sweepEventsOnce(): Promise<number> {
  const retentionDays = getConfig().retention.events_days
  if (retentionDays === 0) return 0
  const cutoff = Date.now() - retentionDays * 24 * ONE_HOUR_MS
  try {
    const n = await purgeEventsOlderThan(cutoff)
    if (n > 0) {
      consola.info(`[events-retention] purged ${n} row(s) older than cutoff`)
    }
    return n
  } catch (err) {
    consola.error(`[events-retention] sweep failed: ${String(err)}`)
    return 0
  }
}

// ---------------------------------------------------------------------------
// startEventRetention — returns a cancel handle
// ---------------------------------------------------------------------------

/**
 * Start the hourly retention sweeper.  Returns a cancel function the caller
 * (typically test setup, or a shutdown handler) can use to stop the timer.
 *
 * Behaviour:
 * - The first tick fires at the next wall-clock hour boundary, then hourly
 *   thereafter.
 * - Each tick records `lastTickAt`; if the next tick fires more than
 *   `SUSPEND_DETECTION_FACTOR × ONE_HOUR_MS` after the previous one, we treat
 *   it as a likely suspend-resume and run a catch-up sweep immediately.
 * - `setImmediate`-yields inside `purgeEventsOlderThan` keep the event loop
 *   responsive while the DELETE runs.
 */
export function startEventRetention(): () => void {
  let lastTickAt = Date.now()
  let intervalHandle: ReturnType<typeof setInterval> | null = null
  let firstTimeoutHandle: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const tick = (): void => {
    if (stopped) return
    const now = Date.now()
    const delta = now - lastTickAt
    lastTickAt = now
    if (delta > SUSPEND_DETECTION_FACTOR * ONE_HOUR_MS) {
      consola.warn(
        `[events-retention] tick delta ${delta}ms exceeds 2× expected — system likely resumed from suspend; running immediate sweep`,
      )
    }
    void sweepEventsOnce()
  }

  // First tick: align to next wall-clock hour
  const firstDelay = msUntilNextHour()
  firstTimeoutHandle = setTimeout(() => {
    firstTimeoutHandle = null
    tick()
    if (!stopped) {
      intervalHandle = setInterval(tick, ONE_HOUR_MS)
    }
  }, firstDelay)

  return () => {
    stopped = true
    if (firstTimeoutHandle) {
      clearTimeout(firstTimeoutHandle)
      firstTimeoutHandle = null
    }
    if (intervalHandle) {
      clearInterval(intervalHandle)
      intervalHandle = null
    }
  }
}
