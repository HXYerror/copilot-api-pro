/**
 * GET /admin/api/usage — bundled usage dashboard payload.
 *
 * Query params (all optional; default 24h window):
 *   range:   "1h" | "24h" | "7d" | "30d" | "custom"
 *   since:   ISO8601 (custom only)
 *   until:   ISO8601 (custom only)
 *   key_id:  repeatable, filters events to listed keys
 *   model:   repeatable, filters events to listed models
 *
 * Response:
 *   {
 *     filter: { range, since, until, key_ids, models },
 *     stats:  { total_requests, total_tokens, error_rate, p95_latency_ms },
 *     activity: {
 *       rpm:        [{ ts, model, count }],          // per-minute by model
 *       tokens:     [{ ts, prompt_tokens, completion_tokens }], // per-hour
 *       latency:    [{ ts, p50, p95, p99 }],         // per-hour percentiles
 *     },
 *     top_models: [{ model, count }],
 *     top_keys:   [{ key_id, label, tokens, requests }],
 *     errors_by_status: [{ status, count, sample_error }],
 *     all_keys:   [{ id, label }],                   // for the filter dropdown
 *     all_models: [string],                           // for the filter dropdown
 *   }
 */

import consola from "consola"
import { Hono } from "hono"

import type { EventRow } from "~/services/events"

import { getDb } from "~/lib/db"
import { listKeys } from "~/services/keys"

import type { SessionVar } from "../session-middleware"

import {
  distinctModels,
  errorBreakdownByStatus,
  errorRateByKey,
  latencyPercentiles,
  requestsPerMinute,
  streamEventsForCsv,
  tokensPerHour,
  topKeysByTokens,
  topModelsByRequests,
  type TimeRange,
  type UsageFilter,
} from "../usage/queries"

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const MAX_WINDOW_MS = 90 * DAY_MS

const ALLOWED_RANGES: ReadonlyArray<TimeRange> = [
  "1h",
  "24h",
  "7d",
  "30d",
  "custom",
]

function parseRange(raw: string | undefined): TimeRange {
  if (raw && (ALLOWED_RANGES as ReadonlyArray<string>).includes(raw)) {
    return raw as TimeRange
  }
  return "24h"
}

function rangeSpanMs(range: TimeRange): number {
  switch (range) {
    case "1h":
      return HOUR_MS
    case "24h":
      return 24 * HOUR_MS
    case "7d":
      return 7 * DAY_MS
    case "30d":
      return 30 * DAY_MS
    default:
      return 24 * HOUR_MS
  }
}

function parseIsoOrEpoch(raw: string | undefined): number | null {
  if (!raw) return null
  const t = Date.parse(raw)
  if (Number.isFinite(t)) return t
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

interface ParsedFilter {
  range: TimeRange
  since: number
  until: number
  key_ids: Array<string>
  models: Array<string>
}

function parseFilter(c: {
  req: {
    query: (k: string) => string | undefined
    queries: (k: string) => Array<string> | undefined
  }
}): ParsedFilter {
  const range = parseRange(c.req.query("range"))
  const now = Date.now()
  let since: number
  let until: number
  if (range === "custom") {
    const sinceRaw = parseIsoOrEpoch(c.req.query("since"))
    const untilRaw = parseIsoOrEpoch(c.req.query("until"))
    until = untilRaw ?? now
    since = sinceRaw ?? until - DAY_MS
    if (since >= until) since = until - HOUR_MS
    if (until - since > MAX_WINDOW_MS) since = until - MAX_WINDOW_MS
  } else {
    until = now
    since = until - rangeSpanMs(range)
  }
  const key_ids = (c.req.queries("key_id") ?? []).filter((v) => v.length > 0)
  const models = (c.req.queries("model") ?? []).filter((v) => v.length > 0)
  return { range, since, until, key_ids, models }
}

function toDbFilter(f: ParsedFilter): UsageFilter {
  return {
    since: f.since,
    until: f.until,
    keyIds: f.key_ids.length > 0 ? f.key_ids : undefined,
    models: f.models.length > 0 ? f.models : undefined,
  }
}

export const usageRoute = new Hono<{ Variables: SessionVar }>()

usageRoute.get("/", (c) => {
  const filter = parseFilter(c)
  const dbFilter = toDbFilter(filter)

  let rpm: ReturnType<typeof requestsPerMinute> = []
  let tokens: ReturnType<typeof tokensPerHour> = []
  let latency: ReturnType<typeof latencyPercentiles> = []
  let top_models: ReturnType<typeof topModelsByRequests> = []
  let top_keys_raw: ReturnType<typeof topKeysByTokens> = []
  let errors_by_status: ReturnType<typeof errorBreakdownByStatus> = []
  let error_rates: ReturnType<typeof errorRateByKey> = []
  let all_models: Array<string> = []

  try {
    rpm = requestsPerMinute(dbFilter)
    tokens = tokensPerHour(dbFilter)
    latency = latencyPercentiles(dbFilter)
    top_models = topModelsByRequests(dbFilter, 10)
    top_keys_raw = topKeysByTokens(dbFilter, 10)
    errors_by_status = errorBreakdownByStatus(dbFilter)
    error_rates = errorRateByKey(dbFilter)
    all_models = distinctModels()
  } catch (err) {
    consola.error(`[admin/api/usage] dashboard query failed: ${String(err)}`)
  }

  // Compose stats
  let totalRequests = 0
  let totalErrors = 0
  for (const r of error_rates) {
    totalRequests += r.total
    totalErrors += r.errors
  }
  let totalTokens = 0
  for (const t of tokens) {
    totalTokens += t.prompt_tokens + t.completion_tokens
  }
  const stats = {
    total_requests: totalRequests,
    total_tokens: totalTokens,
    error_rate: totalRequests === 0 ? 0 : totalErrors / totalRequests,
    errors: totalErrors,
    // p95 over the window: worst-hour proxy from latency series.
    p95_latency_ms:
      latency.length === 0 ? null : Math.max(...latency.map((p) => p.p95)),
  }

  // Annotate top_keys with labels (single IN query)
  const db = getDb()
  const labelById = new Map<string, string | null>()
  const top_key_ids = top_keys_raw.map((k) => k.key_id)
  if (top_key_ids.length > 0) {
    const placeholders = top_key_ids.map(() => "?").join(",")
    const rows = db
      .query<{ id: string; label: string | null }, Array<string>>(
        `SELECT id, label FROM keys WHERE id IN (${placeholders})`,
      )
      .all(...top_key_ids)
    for (const r of rows) labelById.set(r.id, r.label)
  }
  const top_keys = top_keys_raw.map((k) => ({
    key_id: k.key_id,
    label: labelById.get(k.key_id) ?? null,
    tokens: k.tokens,
    requests: error_rates.find((e) => e.key_id === k.key_id)?.total ?? 0,
  }))

  // Active keys for the filter dropdown (we don't need revoked ones in the
  // UI — the user generally wants to slice on a key that's still in use).
  const all_keys = listKeys(500, 0).rows
    .filter((k) => k.revoked_at === null)
    .map((k) => ({ id: k.id, label: k.label }))

  return c.json({
    filter,
    stats,
    activity: { rpm, tokens, latency },
    top_models,
    top_keys,
    errors_by_status,
    all_keys,
    all_models,
  })
})

// ---------------------------------------------------------------------------
// GET /admin/api/usage/export.csv — streamed CSV download.
// Same filter params as the JSON endpoint. Re-uses streamEventsForCsv to keep
// memory flat for large windows.
// ---------------------------------------------------------------------------

const CSV_HEADERS: ReadonlyArray<keyof EventRow> = [
  "id",
  "ts",
  "key_id",
  "model",
  "upstream_model",
  "prompt_tokens",
  "completion_tokens",
  "status",
  "latency_ms",
  "error",
  "usage_unknown",
]

const NEEDS_QUOTING = /[",\r\n]/
const RISKY_LEAD = /^[=+\-@\t\r]/

function csvField(value: string | number | null): string {
  if (value === null) return ""
  let s = String(value)
  if (RISKY_LEAD.test(s)) s = `'${s}`
  if (!NEEDS_QUOTING.test(s)) return s
  return `"${s.replaceAll(`"`, `""`)}"`
}

function eventRowToCsv(row: EventRow): string {
  return CSV_HEADERS.map((h) => csvField(row[h])).join(",")
}

usageRoute.get("/export.csv", (c) => {
  const filter = parseFilter(c)
  const dbFilter = toDbFilter(filter)
  const tsTag = new Date().toISOString().replaceAll(/[:.]/g, "-")
  const headerLine = CSV_HEADERS.join(",")
  const encoder = new TextEncoder()
  const iter = streamEventsForCsv(dbFilter)
  let wroteHeader = false

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        if (!wroteHeader) {
          controller.enqueue(encoder.encode(`${headerLine}\n`))
          wroteHeader = true
          return
        }
        const result = iter.next()
        if (result.done) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(`${eventRowToCsv(result.value)}\n`))
      } catch (err) {
        consola.error(`[admin/api/usage] CSV export pull failed: ${String(err)}`)
        controller.error(err)
        iter.return?.()
      }
    },
    cancel(reason) {
      consola.debug(
        `[admin/api/usage] CSV export cancelled: ${String(reason ?? "client_disconnect")}`,
      )
      iter.return?.()
    },
  })

  return c.body(stream, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="usage-${tsTag}.csv"`,
    "Cache-Control": "no-store",
  })
})
