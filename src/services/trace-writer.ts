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
  /**
   * Body bytes captured for this leg. `undefined` = leg was captured in
   * headers-only mode (no body was read from the wire). Distinct from
   * `""` which means "captured, and the body was empty".
   */
  body?: string | object | null
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
  /**
   * Capture depth for this trace:
   *   - "headers": legs carry method / url / status / headers only.
   *     `body` on every leg is undefined and is omitted from the JSONL
   *     serialization. Every request is captured at this level so
   *     operators can always inspect routing / rate-limit / auth
   *     signals without turning on debug up-front.
   *   - "full": additionally captures req / res / upstream_req /
   *     upstream_res bodies (subject to size cap + redaction). Gated
   *     on captureLevel — global features.debug, per-key debug, or
   *     admin X-Capi-Debug header.
   * Missing on old records = "full" (backward compat).
   */
  capture_level?: "headers" | "full"
  /**
   * Optional per-request metadata.  Free-form record so future fields don't
   * need a schema bump.  Today we use it to surface the default-model
   * fallback rewrite (client_requested_model / effective_model / rewritten).
   */
  meta?: Record<string, unknown>
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
    // Omit body entirely for headers-only captures. Distinguishes
    // "not captured" from "captured empty" for downstream tooling.
    ...(leg.body !== undefined && { body: redactBody(leg.body) }),
  }
}

function eventToJSON(event: TraceEvent): Record<string, unknown> {
  return {
    trace_id: event.trace_id,
    ts: event.ts,
    key_id: event.key_id,
    route: event.route,
    ...(event.capture_level && { capture_level: event.capture_level }),
    req: legToJSON(event.req),
    ...(event.upstream_req && { upstream_req: legToJSON(event.upstream_req) }),
    ...(event.upstream_res && { upstream_res: legToJSON(event.upstream_res) }),
    res: legToJSON(event.res),
    latency_ms: event.latency_ms,
    ...(event.meta && Object.keys(event.meta).length > 0 ?
      { meta: event.meta }
    : {}),
  }
}

// ---------------------------------------------------------------------------
// writeTrace
// ---------------------------------------------------------------------------

/**
 * Persist and broadcast a single trace event.
 *
 * Always writes to disk when invoked. The trace middleware's `captureLevel`
 * check is the canonical gate — by the time we get here the operator has
 * explicitly opted in (per-key debug, global features.debug, or admin
 * X-Capi-Debug header), and silently dropping their capture because
 * retention.traces_days happens to be 0 was incomprehensibly bad UX
 * (operators stared at "no captured request/response" with no clue why).
 *
 * `retention.traces_days` now controls only RETENTION — the sweeper
 * deletes files older than that many days. 0 still means "keep nothing
 * for long", but newly-captured traces are visible until the next sweep.
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

  try {
    appendToDisk(line)
  } catch (err) {
    consola.error(`[trace-writer] append failed (continuing): ${String(err)}`)
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
