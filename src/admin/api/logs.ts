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
    // Search by key_id substring or model substring or error substring
    parts.push("(key_id LIKE ? OR model LIKE ? OR error LIKE ?)")
    const like = `%${q}%`
    params.push(like, like, like)
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

  const dateStr = dateStrForTs(event.ts)
  const filePath = path.join(tracesDir(), `traces-${dateStr}.jsonl`)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf8")
  } catch {
    return c.json(
      {
        error: "no_capture",
        reason:
          `No trace file for ${dateStr} — the key's debug mode was`
          + ` likely off when this request was served, or retention swept`
          + ` the file. Enable debug on the key (Keys → detail) to capture`
          + ` future calls.`,
        event,
      },
      404,
    )
  }

  // Find the closest matching line. Same key + ts within ±2s.
  let best: TraceLine | null = null
  let bestDelta = Infinity
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue
    let parsed: TraceLine
    try {
      parsed = JSON.parse(line) as TraceLine
    } catch {
      continue
    }
    if (parsed.key_id !== event.key_id) continue
    const delta = Math.abs((parsed.ts ?? 0) - event.ts)
    if (delta > 2000) continue
    if (delta < bestDelta) {
      bestDelta = delta
      best = parsed
    }
  }

  if (!best) {
    return c.json(
      {
        error: "no_capture",
        reason:
          `No matching trace line for event #${id} on ${dateStr}.`
          + ` Either the key's debug mode was off when the request fired,`
          + ` or the trace was filtered (e.g. wrong route).`,
        event,
      },
      404,
    )
  }

  return c.json({ event, trace: best, file: `traces-${dateStr}.jsonl` })
})
