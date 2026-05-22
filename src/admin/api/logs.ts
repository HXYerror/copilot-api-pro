/**
 * /admin/api/logs — historical event browsing for the Logs (Traces) page.
 *
 * Endpoints
 *   GET /admin/api/logs               list events with filters (paginated)
 *   GET /admin/api/logs/traces        list captured trace files (NDJSON files
 *                                     written to disk for debug-enabled keys)
 *   GET /admin/api/logs/:id/trace     attempt to look up the full trace
 *                                     (request/response bodies) for an event
 *                                     by scanning today's trace file. Returns
 *                                     404 if the event's key didn't have debug
 *                                     capture enabled at the time.
 *
 * Live tail still uses the existing SSE endpoint at /admin/traces/stream,
 * which is React-friendly via EventSource and lives outside the /api tree.
 *
 * Trace file download stays at /admin/traces/:date.jsonl (path traversal
 * guarded, symlink-resolved).
 */

import { Hono } from "hono"
import fs from "node:fs"
import path from "node:path"

import { getConfig } from "~/lib/config-store"
import { getDb } from "~/lib/db"
import { tracesDir } from "~/lib/paths"

import type { SessionVar } from "../session-middleware"

interface LogRow {
  id: number
  ts: number
  key_id: string
  model: string
  upstream_model: string
  prompt_tokens: number | null
  completion_tokens: number | null
  status: number
  latency_ms: number
  error: string | null
  usage_unknown: number
}

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

function parseTs(raw: string | undefined): number | null {
  if (!raw) return null
  const t = Date.parse(raw)
  if (Number.isFinite(t)) return t
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

function statusClause(
  status: string | undefined,
): { sql: string; param?: number } | null {
  if (status === "ok") return { sql: "status < 400" }
  if (status === "error") return { sql: "status >= 400" }
  if (status && /^\d+$/.test(status)) {
    return { sql: "status = ?", param: Number.parseInt(status, 10) }
  }
  return null
}

function kindClause(kind: string | undefined): string | null {
  if (kind === "messages") return "model NOT LIKE '%/%'"
  if (kind === "other") return "model LIKE '%/%'"
  return null
}

function buildWhere(
  c: {
    req: {
      query: (k: string) => string | undefined
      queries: (k: string) => Array<string> | undefined
    }
  },
  options: { excludeKind?: boolean } = {},
): { sql: string; params: Array<unknown> } {
  const parts: Array<string> = []
  const params: Array<unknown> = []

  const since = parseTs(c.req.query("since"))
  const until = parseTs(c.req.query("until"))
  if (since !== null) {
    parts.push("ts >= ?")
    params.push(since)
  }
  if (until !== null) {
    parts.push("ts < ?")
    params.push(until)
  }
  const keyIds = (c.req.queries("key_id") ?? []).filter((v) => v.length > 0)
  const models = (c.req.queries("model") ?? []).filter((v) => v.length > 0)
  if (keyIds.length > 0) {
    parts.push(`key_id IN (${keyIds.map(() => "?").join(",")})`)
    params.push(...keyIds)
  }
  if (models.length > 0) {
    parts.push(`model IN (${models.map(() => "?").join(",")})`)
    params.push(...models)
  }

  const status = statusClause(c.req.query("status"))
  if (status) {
    parts.push(status.sql)
    if (status.param !== undefined) params.push(status.param)
  }

  // Kind filter: real message requests vs non-message endpoints (model
  // listings, etc). Telemetry middleware writes `model = "<METHOD> <path>"`
  // for non-POST routes — those always contain a "/", whereas real model
  // names never do, so the "/" heuristic is reliable. Skipped when caller
  // wants per-kind counts under the same other-filters set.
  if (!options.excludeKind) {
    const kindSql = kindClause(c.req.query("kind"))
    if (kindSql) parts.push(kindSql)
  }

  const q = c.req.query("q")
  if (q && q.length > 0) {
    // Search by key_id substring (UUID), key label (resolved via subquery
    // against the keys table — events only stores the id), model substring,
    // or error substring. The label lookup is what lets operators type a
    // human name like "lin_review" instead of a UUID.
    parts.push(
      `(key_id LIKE ? OR model LIKE ? OR error LIKE ?
         OR key_id IN (SELECT id FROM keys WHERE label LIKE ?))`,
    )
    const like = `%${q}%`
    params.push(like, like, like, like)
  }

  return {
    sql: parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`,
    params,
  }
}

export const logsRoute = new Hono<{ Variables: SessionVar }>()

// ---------------------------------------------------------------------------
// GET /admin/api/logs — paginated event list with filters
// ---------------------------------------------------------------------------
logsRoute.get("/", (c) => {
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(
      1,
      Number.parseInt(c.req.query("limit") ?? `${DEFAULT_LIMIT}`, 10)
        || DEFAULT_LIMIT,
    ),
  )
  const offset = Math.max(
    0,
    Number.parseInt(c.req.query("offset") ?? "0", 10) || 0,
  )
  const where = buildWhere(c)
  const db = getDb()

  const countSql = `SELECT COUNT(*) AS n FROM events ${where.sql}`
  const total =
    db.query<{ n: number }, Array<unknown>>(countSql).get(...where.params)?.n
    ?? 0

  const rowsSql = `SELECT * FROM events ${where.sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`
  const rows = db
    .query<LogRow, Array<unknown>>(rowsSql)
    .all(...where.params, limit, offset)

  // Add key labels in a single IN-query.
  const keyIds = [...new Set(rows.map((r) => r.key_id))]
  const labelById = new Map<string, string | null>()
  if (keyIds.length > 0) {
    const placeholders = keyIds.map(() => "?").join(",")
    const labelRows = db
      .query<
        { id: string; label: string | null },
        Array<string>
      >(`SELECT id, label FROM keys WHERE id IN (${placeholders})`)
      .all(...keyIds)
    for (const r of labelRows) labelById.set(r.id, r.label)
  }

  // Distinct models for the filter dropdown. Strip the synthetic
  // "<METHOD> <path>" entries that telemetry writes for non-POST routes —
  // those aren't real models and shouldn't appear in the model picker.
  const allModels = db
    .query<{ model: string }, []>(
      "SELECT DISTINCT model FROM events WHERE model NOT LIKE '%/%' ORDER BY model",
    )
    .all()
    .map((r) => r.model)

  // Key dropdown population. UNION of:
  //   1. every key currently in the keys table (active + revoked) — so the
  //      operator can filter by a freshly-created key BEFORE it has served
  //      any requests, and
  //   2. every distinct key_id that has actually served an event but no
  //      longer exists in the keys table (orphan rows from deleted keys
  //      whose historical events are still in the events table).
  // Sorted in JS so the SQL stays portable across SQLite versions.
  const allKeysRaw = db
    .query<{ id: string; label: string | null }, []>(
      `SELECT id, label FROM keys
       UNION
       SELECT DISTINCT e.key_id AS id, NULL AS label
         FROM events e
         WHERE e.key_id NOT IN (SELECT id FROM keys)`,
    )
    .all()
  const allKeys = allKeysRaw.slice().sort((a, b) => {
    // Labelled keys first, then by label, then by id.
    if (a.label !== null && b.label === null) return -1
    if (a.label === null && b.label !== null) return 1
    if (a.label !== null && b.label !== null) {
      return a.label.localeCompare(b.label)
    }
    return a.id.localeCompare(b.id)
  })

  // Per-kind totals, computed ignoring the current `kind` filter so the tab
  // badges always reflect the full counts under the *other* active filters
  // (search, status, model, key).
  const whereNoKind = buildWhere(c, { excludeKind: true })
  const kindCountsRow = db
    .query<{ messages: number; other: number }, Array<unknown>>(
      `SELECT
         SUM(CASE WHEN model NOT LIKE '%/%' THEN 1 ELSE 0 END) AS messages,
         SUM(CASE WHEN model LIKE '%/%' THEN 1 ELSE 0 END) AS other
       FROM events ${whereNoKind.sql}`,
    )
    .get(...whereNoKind.params)
  const kindCounts = {
    messages: kindCountsRow?.messages ?? 0,
    other: kindCountsRow?.other ?? 0,
  }

  return c.json({
    items: rows.map((r) => ({
      ...r,
      key_label: labelById.get(r.key_id) ?? null,
    })),
    total,
    limit,
    offset,
    all_models: allModels,
    all_keys: allKeys,
    kind_counts: kindCounts,
  })
})

// ---------------------------------------------------------------------------
// GET /admin/api/logs/traces — list captured trace files
// ---------------------------------------------------------------------------
logsRoute.get("/traces", (c) => {
  const dir = tracesDir()
  type Entry = { name: string; size: number; mtime: number }
  let entries: Array<Entry>
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("traces-") && f.endsWith(".jsonl"))
      .map((f) => {
        const stat = fs.statSync(path.join(dir, f))
        return { name: f, size: stat.size, mtime: stat.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    entries = []
  }
  return c.json({ items: entries, dir })
})

// ---------------------------------------------------------------------------
// GET /admin/api/logs/:id/trace — look up the captured trace for an event.
//
// Strategy
//   1. Read the event row (we need its ts + key_id so we can match against
//      the JSONL file, and its date so we open the right file).
//   2. Determine the date of the event in local time → `traces-YYYY-MM-DD.jsonl`.
//   3. Stream-read the file line by line, JSON.parse each, and find the
//      first record whose `key_id` matches AND whose `ts` is within ±2000 ms
//      of the event ts. The two writers (telemetry + trace) fire from the
//      same middleware chain so they're always within a frame of each other.
//   4. Return the full TraceEvent shape (req / upstream_req / upstream_res /
//      res with redacted headers + bodies, just as it was persisted).
//
// Failure modes
//   - Event id not found → 404.
//   - Trace file missing or no matching line → 404 with reason
//     "no_capture" (the key wasn't debug-enabled at the time, or retention
//     swept it).
// ---------------------------------------------------------------------------

interface TraceLineLeg {
  method?: string
  url?: string
  status?: number
  headers?: Record<string, string>
  body?: unknown
}
interface TraceLine {
  trace_id?: string
  ts?: number
  key_id?: string
  route?: string
  req?: TraceLineLeg
  upstream_req?: TraceLineLeg
  upstream_res?: TraceLineLeg
  res?: TraceLineLeg
  latency_ms?: number
}

function dateStrForTs(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function describeKeyDebugState(
  row:
    | {
        label: string | null
        debug_enabled: number
        debug_expires_at: number | null
        revoked_at: number | null
      }
    | undefined
    | null,
  eventTs: number,
): string {
  if (!row) {
    return (
      `The event's key no longer exists in this database — it may have`
      + ` been deleted, or the event was recorded by a different server`
      + ` instance writing to a different data directory.`
    )
  }
  const labelDisplay = row.label ?? "(no label)"
  if (row.revoked_at !== null) {
    return `Key ${labelDisplay} is currently revoked.`
  }
  if (row.debug_enabled !== 1) {
    return (
      `Key ${labelDisplay} currently has debug OFF — enable it on the`
      + ` Keys page, then re-run the request to capture future calls.`
    )
  }
  if (row.debug_expires_at !== null && row.debug_expires_at <= eventTs) {
    return (
      `Key ${labelDisplay} had debug enabled but the 24h TTL had`
      + ` already expired by the time of this request.`
    )
  }
  return `Key ${labelDisplay} currently has debug ON.`
}

interface TraceLookupDiagnostics {
  traces_dir: string
  traces_days: number
  date_str: string
  file_path: string
  file_exists: boolean
  file_size_bytes: number | null
  file_line_count: number | null
  lines_with_event_key: number
  closest_delta_ms: number | null
  closest_line_ts: number | null
  best_match_within_2s: boolean
}

function scanTraceFile(
  filePath: string,
  eventKeyId: string,
  eventTs: number,
): {
  best: TraceLine | null
  diag: Pick<
    TraceLookupDiagnostics,
    | "file_size_bytes"
    | "file_line_count"
    | "lines_with_event_key"
    | "closest_delta_ms"
    | "closest_line_ts"
    | "best_match_within_2s"
  >
} {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf8")
  } catch {
    return {
      best: null,
      diag: {
        file_size_bytes: null,
        file_line_count: null,
        lines_with_event_key: 0,
        closest_delta_ms: null,
        closest_line_ts: null,
        best_match_within_2s: false,
      },
    }
  }

  let lineCount = 0
  let linesWithKey = 0
  let best: TraceLine | null = null
  let bestDelta = Infinity
  let closestTs: number | null = null
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue
    lineCount++
    let parsed: TraceLine
    try {
      parsed = JSON.parse(line) as TraceLine
    } catch {
      continue
    }
    if (parsed.key_id !== eventKeyId) continue
    linesWithKey++
    const delta = Math.abs((parsed.ts ?? 0) - eventTs)
    if (delta < bestDelta) {
      bestDelta = delta
      closestTs = parsed.ts ?? null
    }
    if (delta <= 2000 && (!best || delta < bestDelta)) {
      best = parsed
    }
  }
  return {
    best,
    diag: {
      file_size_bytes: raw.length,
      file_line_count: lineCount,
      lines_with_event_key: linesWithKey,
      closest_delta_ms: bestDelta === Infinity ? null : bestDelta,
      closest_line_ts: closestTs,
      best_match_within_2s: best !== null,
    },
  }
}

function diagnosticsToReason(
  d: TraceLookupDiagnostics,
  keyDiag: string,
): string {
  const parts: Array<string> = [keyDiag]
  parts.push(`retention.traces_days = ${d.traces_days}.`)
  if (d.traces_days <= 0) {
    parts.push(
      `Trace disk-write is DISABLED — Settings → Advanced → set traces_days > 0 to start persisting captures.`,
    )
  }
  if (!d.file_exists) {
    parts.push(`No trace file at ${d.file_path} for ${d.date_str}.`)
    return parts.join(" ")
  }
  parts.push(
    `File exists (${d.file_size_bytes} bytes, ${d.file_line_count} lines).`,
    `${d.lines_with_event_key} line(s) match this key.`,
  )
  if (d.closest_delta_ms !== null) {
    parts.push(
      `Closest line for this key is ${d.closest_delta_ms} ms away from the event ts`
        + ` (line ts ${d.closest_line_ts === null ? "?" : new Date(d.closest_line_ts).toISOString()}).`,
    )
  }
  if (d.lines_with_event_key === 0) {
    parts.push(
      `→ Trace middleware almost certainly didn't fire for this request.`
        + ` Most likely: debug wasn't *effective* at request time, OR the route`
        + ` bypassed the trace middleware.`,
    )
  } else if (!d.best_match_within_2s) {
    parts.push(
      `→ Trace lines for this key exist but none within ±2s of the event.`
        + ` This is usually a clock-skew issue between the telemetry insert`
        + ` and the trace writer.`,
    )
  }
  return parts.join(" ")
}

logsRoute.get("/:id/trace", (c) => {
  const idRaw = c.req.param("id")
  const id = Number.parseInt(idRaw, 10)
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ error: "Bad id" }, 400)
  }

  const db = getDb()
  const event = db
    .query<
      { id: number; ts: number; key_id: string; model: string },
      [number]
    >(`SELECT id, ts, key_id, model FROM events WHERE id = ?`)
    .get(id)
  if (!event) return c.json({ error: "Event not found" }, 404)

  const keyRow = db
    .query<
      {
        label: string | null
        debug_enabled: number
        debug_expires_at: number | null
        revoked_at: number | null
      },
      [string]
    >(
      `SELECT label, debug_enabled, debug_expires_at, revoked_at
         FROM keys WHERE id = ?`,
    )
    .get(event.key_id)
  const keyDiag = describeKeyDebugState(keyRow, event.ts)

  const dateStr = dateStrForTs(event.ts)
  const filePath = path.join(tracesDir(), `traces-${dateStr}.jsonl`)
  const fileExists = fs.existsSync(filePath)
  const { best, diag: scanDiag } =
    fileExists ?
      scanTraceFile(filePath, event.key_id, event.ts)
    : {
        best: null,
        diag: {
          file_size_bytes: null,
          file_line_count: null,
          lines_with_event_key: 0,
          closest_delta_ms: null,
          closest_line_ts: null,
          best_match_within_2s: false,
        },
      }

  const diagnostics: TraceLookupDiagnostics = {
    traces_dir: tracesDir(),
    traces_days: getConfig().retention.traces_days,
    date_str: dateStr,
    file_path: filePath,
    file_exists: fileExists,
    ...scanDiag,
  }

  if (best) {
    return c.json({
      event,
      trace: best,
      file: `traces-${dateStr}.jsonl`,
      diagnostics,
    })
  }

  return c.json(
    {
      error: "no_capture",
      reason: diagnosticsToReason(diagnostics, keyDiag),
      event,
      key_diagnosis: keyDiag,
      diagnostics,
    },
    404,
  )
})
