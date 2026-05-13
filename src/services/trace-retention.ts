/**
 * Trace retention sweeper (issue #36, F4.A).
 *
 * Two policies, run together each tick:
 *
 *  1. **Age**: delete `traces-YYYY-MM-DD.jsonl` files whose date is older
 *     than `retention.traces_days` days. `traces_days = 0` keeps captures
 *     in-memory only (the writer never persisted anything in the first
 *     place); this sweep is still safe to run because it only deletes
 *     files matching the canonical filename pattern.
 *
 *  2. **Size cap**: if the total bytes of the JSONL files exceed
 *     `retention.traces_max_bytes`, delete the OLDEST day repeatedly until
 *     under the cap. If a deleted file is younger than `traces_days` days
 *     this is the "evicting within retention window" alarm condition and
 *     we log at warn level — the operator may need a larger cap or a
 *     smaller retention.
 */

import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import { getConfig } from "~/lib/config-store"
import { tracesDir } from "~/lib/paths"

const ONE_HOUR_MS = 60 * 60 * 1000
const ONE_DAY_MS = 24 * ONE_HOUR_MS

const TRACE_FILE_RE = /^traces-(\d{4}-\d{2}-\d{2})\.jsonl$/

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TraceFile {
  name: string
  fullPath: string
  dateMs: number
  size: number
}

function listTraceFiles(): Array<TraceFile> {
  const dir = tracesDir()
  let entries: Array<string>
  try {
    entries = fs.readdirSync(dir)
  } catch {
    // Directory doesn't exist yet — nothing to sweep
    return []
  }
  const out: Array<TraceFile> = []
  for (const entry of entries) {
    const match = TRACE_FILE_RE.exec(entry)
    if (!match) continue
    const fullPath = path.join(dir, entry)
    let size: number
    try {
      const stat = fs.statSync(fullPath)
      size = stat.size
    } catch {
      continue
    }
    const dateMs = new Date(`${match[1]}T00:00:00`).getTime()
    if (!Number.isFinite(dateMs)) continue
    out.push({ name: entry, fullPath, dateMs, size })
  }
  return out
}

// ---------------------------------------------------------------------------
// Age-based sweep
// ---------------------------------------------------------------------------

/** Delete trace files older than `retention.traces_days` days. */
export function purgeOldTraces(): number {
  const cfg = getConfig()
  const days = cfg.retention.traces_days
  if (days <= 0) {
    // 0 = no on-disk persistence; the writer never created files. Still
    // safe to run — readdir will be empty in steady state.
    return 0
  }
  const cutoffMs = Date.now() - days * ONE_DAY_MS
  let purged = 0
  for (const file of listTraceFiles()) {
    if (file.dateMs < cutoffMs) {
      try {
        fs.unlinkSync(file.fullPath)
        purged++
      } catch {
        // best-effort
      }
    }
  }
  if (purged > 0) {
    consola.info(`[trace-retention] purged ${purged} file(s) past traces_days`)
  }
  return purged
}

// ---------------------------------------------------------------------------
// Size-cap eviction
// ---------------------------------------------------------------------------

/**
 * Enforce the byte cap by deleting the oldest day(s) until under
 * `retention.traces_max_bytes`. Logs a warn-level alarm if the evicted
 * file is still inside the retention window — that's the "we're losing
 * data faster than retention says we should" signal.
 */
export function enforceSizeCap(): number {
  const cfg = getConfig()
  const cap = cfg.retention.traces_max_bytes
  if (cap <= 0) return 0
  const days = cfg.retention.traces_days
  const retentionCutoffMs =
    days > 0 ? Date.now() - days * ONE_DAY_MS : Number.NEGATIVE_INFINITY

  const files = listTraceFiles()
  files.sort((a, b) => a.dateMs - b.dateMs) // oldest first

  let total = files.reduce((acc, f) => acc + f.size, 0)
  let evicted = 0
  while (total > cap && files.length > 0) {
    const oldest = files.shift()
    if (!oldest) break
    try {
      fs.unlinkSync(oldest.fullPath)
    } catch {
      // best-effort
      continue
    }
    total -= oldest.size
    evicted++
    if (oldest.dateMs >= retentionCutoffMs) {
      consola.warn(
        `[trace-retention] size-cap evicted ${oldest.name} (${oldest.size}B) within retention window — increase traces_max_bytes or decrease traces_days`,
      )
    } else {
      consola.info(`[trace-retention] size-cap evicted ${oldest.name}`)
    }
  }
  return evicted
}

// ---------------------------------------------------------------------------
// Combined sweep
// ---------------------------------------------------------------------------

export function sweepTracesOnce(): { purged: number; evicted: number } {
  try {
    const purged = purgeOldTraces()
    const evicted = enforceSizeCap()
    return { purged, evicted }
  } catch (err) {
    consola.error(`[trace-retention] sweep failed: ${String(err)}`)
    return { purged: 0, evicted: 0 }
  }
}

// ---------------------------------------------------------------------------
// startTraceRetention — returns a cancel handle
// ---------------------------------------------------------------------------

/**
 * Run a sweep immediately, then every hour. Returns a cancel function so
 * the SIGINT shutdown hook can stop the timer (same pattern as
 * startEventRetention).
 */
export function startTraceRetention(): () => void {
  sweepTracesOnce()
  const handle = setInterval(() => {
    sweepTracesOnce()
  }, ONE_HOUR_MS)
  return () => {
    clearInterval(handle)
  }
}
