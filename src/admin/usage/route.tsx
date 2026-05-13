/** @jsxImportSource hono/jsx */
import consola from "consola"
import { Hono } from "hono"

import type { EventRow } from "~/services/events"

import { listKeys } from "~/services/keys"

import type { SessionVar } from "../session-middleware"
import type { UsageFilterValues, UsageStats } from "./page"
import type { TimeRange, UsageFilter } from "./queries"

import { ADMIN_SECURITY_HEADERS, Layout } from "../layout"
import { UsagePage } from "./page"
import {
  distinctModels,
  errorRateByKey,
  p95LatencyPerHour,
  requestsPerMinute,
  streamEventsForCsv,
  tokensPerHour,
  topKeysByTokens,
  topModelsByRequests,
} from "./queries"

// ---------------------------------------------------------------------------
// Param parsing
// ---------------------------------------------------------------------------

const ALLOWED_RANGES: ReadonlyArray<TimeRange> = [
  "1h",
  "24h",
  "7d",
  "30d",
  "custom",
]
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

function rangeSpanMs(range: TimeRange): number {
  switch (range) {
    case "1h": {
      return HOUR_MS
    }
    case "24h": {
      return 24 * HOUR_MS
    }
    case "7d": {
      return 7 * DAY_MS
    }
    case "30d": {
      return 30 * DAY_MS
    }
    default: {
      // "custom" — exhaustive over TimeRange; the caller chooses since/until.
      return 24 * HOUR_MS
    }
  }
}

function parseRange(raw: string | undefined): TimeRange {
  if (raw && (ALLOWED_RANGES as ReadonlyArray<string>).includes(raw)) {
    return raw as TimeRange
  }
  return "24h"
}

function parseDateTime(raw: string | undefined): number | null {
  if (!raw) return null
  // `datetime-local` values arrive as "YYYY-MM-DDTHH:mm" (no Z).  Treat them
  // as UTC by appending Z; otherwise the host TZ would skew bucket alignment.
  const candidate = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) ? `${raw}Z` : raw
  const t = Date.parse(candidate)
  return Number.isFinite(t) ? t : null
}

function queryAll(
  c: { req: { queries: (k: string) => Array<string> | undefined } },
  key: string,
): Array<string> {
  // Hono returns undefined when the key is missing; coerce to [] and filter.
  return (c.req.queries(key) ?? []).filter((v) => v.length > 0)
}

function parseFilter(c: {
  req: {
    query: (k: string) => string | undefined
    queries: (k: string) => Array<string> | undefined
  }
}): UsageFilterValues {
  const range = parseRange(c.req.query("range"))
  const now = Date.now()

  // Cap on the absolute query window for custom ranges.  Events are already
  // retention-bounded to features.retention.events_days (90 default), but
  // an arbitrarily wide WHERE-clause scan still pins a read transaction and
  // can starve WAL checkpoints.  Cap at 90 days as a defence-in-depth bound.
  const MAX_WINDOW_MS = 90 * DAY_MS

  let since: number
  let until: number
  if (range === "custom") {
    const sinceRaw = parseDateTime(c.req.query("since"))
    const untilRaw = parseDateTime(c.req.query("until"))
    until = untilRaw ?? now
    since = sinceRaw ?? until - DAY_MS
    if (since >= until) since = until - HOUR_MS
    // Clamp custom range to MAX_WINDOW_MS — preserves `until` so the request
    // still answers the operator's "look at the most recent N" intent.
    if (until - since > MAX_WINDOW_MS) since = until - MAX_WINDOW_MS
  } else {
    until = now
    since = until - rangeSpanMs(range)
  }

  return {
    range,
    since,
    until,
    keyIds: queryAll(c, "key_id"),
    models: queryAll(c, "model"),
  }
}

function toQueryString(filter: UsageFilterValues): string {
  const params = new URLSearchParams()
  params.set("range", filter.range)
  if (filter.range === "custom") {
    params.set("since", new Date(filter.since).toISOString())
    params.set("until", new Date(filter.until).toISOString())
  }
  for (const k of filter.keyIds) params.append("key_id", k)
  for (const m of filter.models) params.append("model", m)
  return params.toString()
}

// ---------------------------------------------------------------------------
// Stats aggregation
//
// Computes total requests, total tokens, and error rate from already-fetched
// arrays.  Re-using the page queries avoids a round-trip and keeps the read
// snapshot consistent.
// ---------------------------------------------------------------------------

function computeStats(
  errorRates: Array<{ total: number; errors: number }>,
  tokens: Array<{ prompt_tokens: number; completion_tokens: number }>,
): UsageStats {
  let totalRequests = 0
  let totalErrors = 0
  for (const r of errorRates) {
    totalRequests += r.total
    totalErrors += r.errors
  }
  let totalTokens = 0
  for (const t of tokens) {
    totalTokens += t.prompt_tokens + t.completion_tokens
  }
  const errorRate = totalRequests === 0 ? 0 : totalErrors / totalRequests
  return { totalRequests, totalTokens, errorRate }
}

// ---------------------------------------------------------------------------
// CSV helpers — RFC 4180 quoting + formula-injection guard
//
// 1. Quote fields containing a comma, double-quote, CR, or LF (RFC 4180);
//    embedded double-quotes are doubled (`"` → `""`).
// 2. **Formula-injection defense.** Excel, Numbers, LibreOffice, and Google
//    Sheets treat a field starting with `=`, `+`, `-`, `@`, `\t`, or `\r`
//    as a formula expression — a malicious model name like
//    `=cmd|'/c calc'!A1` could pop a calculator (or worse) when an operator
//    opens the exported CSV in a spreadsheet. We defang by prefixing such
//    fields with an apostrophe; spreadsheets render the apostrophe as text
//    suppression rather than a literal character. See:
//      https://owasp.org/www-community/attacks/CSV_Injection
// ---------------------------------------------------------------------------

const NEEDS_QUOTING = /[",\r\n]/
const RISKY_LEAD = /^[=+\-@\t\r]/

export function csvField(value: string | number | null): string {
  if (value === null) return ""
  let s = String(value)
  if (RISKY_LEAD.test(s)) s = `'${s}` // formula-injection guard
  if (!NEEDS_QUOTING.test(s)) return s
  return `"${s.replaceAll(`"`, `""`)}"`
}

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

function eventRowToCsv(row: EventRow): string {
  return CSV_HEADERS.map((h) => csvField(row[h])).join(",")
}

// ---------------------------------------------------------------------------
// Empty-state fallback
//
// If a query throws (DB corruption, missing migration in a fresh test) we
// must not crash the page.  Surface an empty state instead and log the
// underlying error for the operator.
// ---------------------------------------------------------------------------

function emptyFilter(filter: UsageFilterValues): UsageFilter {
  return {
    since: filter.since,
    until: filter.until,
    keyIds: filter.keyIds.length > 0 ? filter.keyIds : undefined,
    models: filter.models.length > 0 ? filter.models : undefined,
  }
}

interface DashboardData {
  rpm: ReturnType<typeof requestsPerMinute>
  tokens: ReturnType<typeof tokensPerHour>
  latency: ReturnType<typeof p95LatencyPerHour>
  topKeys: ReturnType<typeof topKeysByTokens>
  topModels: ReturnType<typeof topModelsByRequests>
  errorRates: ReturnType<typeof errorRateByKey>
  allModels: Array<string>
}

function loadDashboard(filter: UsageFilter): DashboardData {
  try {
    return {
      rpm: requestsPerMinute(filter),
      tokens: tokensPerHour(filter),
      latency: p95LatencyPerHour(filter),
      topKeys: topKeysByTokens(filter),
      topModels: topModelsByRequests(filter),
      errorRates: errorRateByKey(filter),
      allModels: distinctModels(),
    }
  } catch (err) {
    consola.error(`[admin/usage] dashboard query failed: ${String(err)}`)
    return {
      rpm: [],
      tokens: [],
      latency: [],
      topKeys: [],
      topModels: [],
      errorRates: [],
      allModels: [],
    }
  }
}

// ---------------------------------------------------------------------------
// Usage app
// ---------------------------------------------------------------------------

const usageApp = new Hono<{ Variables: SessionVar }>()

usageApp.use("*", async (c, next) => {
  await next()
  for (const [k, v] of Object.entries(ADMIN_SECURITY_HEADERS)) {
    c.header(k, v)
  }
})

// ---------------------------------------------------------------------------
// GET /admin/usage
// ---------------------------------------------------------------------------

usageApp.get("/", (c) => {
  const session = c.get("session")
  const filter = parseFilter(c)
  const dbFilter = emptyFilter(filter)
  const data = loadDashboard(dbFilter)
  const stats = computeStats(data.errorRates, data.tokens)
  const allKeys = listKeys(500, 0).rows.filter((k) => k.revoked_at === null)

  return c.html(
    <Layout title="Usage" active="usage" csrfToken={session.csrf_token}>
      <UsagePage
        csrfToken={session.csrf_token}
        filter={filter}
        allKeys={allKeys}
        allModels={data.allModels}
        stats={stats}
        rpm={data.rpm}
        tokens={data.tokens}
        latency={data.latency}
        topKeys={data.topKeys}
        topModels={data.topModels}
        errorRates={data.errorRates}
        exportQuery={toQueryString(filter)}
      />
    </Layout>,
  )
})

// ---------------------------------------------------------------------------
// GET /admin/usage/export.csv — streamed CSV download
//
// Pull-based ReadableStream so the runtime applies backpressure when the
// client is slow / paused — we don't materialise the entire CSV inside the
// stream's internal queue.  `cancel()` finalises bun:sqlite's iterator via
// its optional `.return()` method, releasing the read transaction so WAL
// checkpointing isn't blocked when a client aborts mid-download.
// ---------------------------------------------------------------------------

usageApp.get("/export.csv", (c) => {
  const filter = parseFilter(c)
  const dbFilter = emptyFilter(filter)
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
        consola.error(`[admin/usage] CSV export pull failed: ${String(err)}`)
        controller.error(err)
        // Best-effort iterator cleanup so the read txn doesn't linger.
        iter.return?.()
      }
    },
    cancel(reason) {
      consola.debug(
        `[admin/usage] CSV export cancelled: ${String(reason ?? "client_disconnect")}`,
      )
      // Finalise the bun:sqlite iterator so the read transaction is closed
      // and the prepared statement is reset.
      iter.return?.()
    },
  })

  return c.body(stream, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="usage-${tsTag}.csv"`,
    "Cache-Control": "no-store",
  })
})

export { usageApp }
