/**
 * Trace JSONL writer (issue #36, F4.A).
 *
 * Pipeline for every captured event:
 *   1. Build the redacted JSONL text (redactHeaders + redactBody +
 *      JSON.stringify + trailing newline).
 *   2. Run assertRedacted against the OUTPUT as a defence-in-depth sanity
 *      check; if it throws, we drop the trace entirely.
 *   3. If retention.traces_days > 0, append the line to today's JSONL file
 *      with mode 0o600 using the same O_APPEND atomic-write pattern as
 *      services/audit.ts.
 *   4. Always push the (already-redacted, already-asserted) line to the
 *      broadcaster so the SSE live tail works even when on-disk
 *      persistence is disabled.
 *
 * The disk-write step is intentionally synchronous: a partial write would
 * leave a malformed JSONL line, and the alternative (queue + async) makes
 * crash recovery dramatically harder for what is at best a few KB per
 * request.
 */

import consola from "consola"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { getConfig } from "~/lib/config-store"
import { tracesDir } from "~/lib/paths"

import { broadcastTrace } from "./trace-broadcaster"
import { assertRedacted, redactBody, redactHeaders } from "./trace-redact"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceLeg {
  method?: string
  url?: string
  status?: number
  headers: Record<string, string> | Headers
  body: string | object | null | undefined
}

export interface TraceEvent {
  trace_id: string
  ts: number // unix ms
  key_id: string // or "__noauth__"
  route: string // c.req.path
  req: TraceLeg
  upstream_req?: TraceLeg
  upstream_res?: TraceLeg
  res: TraceLeg
  latency_ms: number
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Returns the trace JSONL file path for a given date string (YYYY-MM-DD). */
export function traceFilePath(dateStr: string): string {
  return path.join(tracesDir(), `traces-${dateStr}.jsonl`)
}

/** Returns today's date string in YYYY-MM-DD format (local time). */
export function todayDateStr(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

// ---------------------------------------------------------------------------
// Internal: serialise a leg
// ---------------------------------------------------------------------------

function legToJSON(leg: TraceLeg): Record<string, unknown> {
  return {
    ...(leg.method !== undefined && { method: leg.method }),
    ...(leg.url !== undefined && { url: leg.url }),
    ...(leg.status !== undefined && { status: leg.status }),
    headers: redactHeaders(leg.headers),
    body: redactBody(leg.body),
  }
}

function eventToJSON(event: TraceEvent): Record<string, unknown> {
  return {
    trace_id: event.trace_id,
    ts: event.ts,
    key_id: event.key_id,
    route: event.route,
    req: legToJSON(event.req),
    ...(event.upstream_req && { upstream_req: legToJSON(event.upstream_req) }),
    ...(event.upstream_res && { upstream_res: legToJSON(event.upstream_res) }),
    res: legToJSON(event.res),
    latency_ms: event.latency_ms,
  }
}

// ---------------------------------------------------------------------------
// writeTrace
// ---------------------------------------------------------------------------

/**
 * Persist (when retention is enabled) and broadcast a single trace event.
 *
 * Best-effort: a failing disk write must never crash the proxied request.
 * A failing assertRedacted aborts BOTH the disk write and the broadcast —
 * we'd rather lose visibility than persist a known-bad line.
 */
export function writeTrace(event: TraceEvent): void {
  let line: string
  try {
    line = JSON.stringify(eventToJSON(event)) + os.EOL
  } catch (err) {
    consola.error(`[trace-writer] serialise failed: ${String(err)}`)
    return
  }

  try {
    assertRedacted(line)
  } catch (err) {
    consola.error(
      `[trace-writer] redaction sanity check failed, dropping trace: ${String(err)}`,
    )
    return
  }

  const cfg = getConfig()
  if (cfg.retention.traces_days > 0) {
    try {
      appendToDisk(line)
    } catch (err) {
      consola.error(`[trace-writer] append failed (continuing): ${String(err)}`)
    }
  }

  try {
    broadcastTrace(line)
  } catch (err) {
    consola.error(
      `[trace-writer] broadcast failed (continuing): ${String(err)}`,
    )
  }
}

function appendToDisk(line: string): void {
  const dir = tracesDir()
  // Lazy 0o700 mkdir — same pattern as audit.ts (parent APP_DIR is already
  // 0o700; we duplicate the mode here so a fresh checkout still gets the
  // restrictive perms).
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  const filePath = traceFilePath(todayDateStr())
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
    0o600,
  )
  try {
    fs.writeSync(fd, line)
  } finally {
    fs.closeSync(fd)
  }
}
