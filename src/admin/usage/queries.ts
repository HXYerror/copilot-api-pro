/**
 * Usage dashboard query layer (issue #35, F3.B).
 *
 * Pure SQL helpers over the `events` table created by migration 005.  All
 * queries are parameterised and rely on the three indices declared in that
 * migration: `idx_events_ts`, `idx_events_key_ts`, `idx_events_model_ts`.
 *
 * Transaction note:
 *  - `bun:sqlite` exposes `db.transaction(fn)` (deferred BEGIN) for grouping
 *    statements that need a consistent snapshot.  For the dashboard's 3-4
 *    sequential reads we want SQLite to acquire a read snapshot up-front so
 *    new writes (telemetry middleware) don't shift bucket counts mid-render.
 *    SQLite's WAL gives a read snapshot at the FIRST read inside a deferred
 *    transaction, which is exactly what we want — `db.transaction` is enough.
 */

import type { EventRow } from "~/services/events"

import { getDb } from "~/lib/db"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimeRange = "1h" | "24h" | "7d" | "30d" | "custom"

export interface UsageFilter {
  since: number
  until: number
  keyIds?: Array<string>
  models?: Array<string>
}

export interface RpmPoint {
  ts: number
  model: string
  count: number
}

export interface TokensPoint {
  ts: number
  prompt_tokens: number
  completion_tokens: number
}

export interface LatencyPoint {
  ts: number
  p95: number
}

export interface TopKey {
  key_id: string
  tokens: number
}

export interface TopModel {
  model: string
  count: number
}

export interface ErrorRateRow {
  key_id: string
  total: number
  errors: number
  rate: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * Pick the bucket size for time-series queries, mapping range → granularity
 * exactly as the user wants them displayed on the Usage page:
 *
 *   1h  → per minute   (60 bars)
 *   24h → per hour     (24 bars)
 *   7d  → per day      (7 bars)
 *   30d → per week     (~4 bars)
 *
 * Picked by SPAN, not by the range enum string, so a "custom" range with a
 * comparable span gets the same granularity. The cut-offs sit at the
 * midpoint between two adjacent presets so a span slightly under 24h still
 * falls into "per hour", not "per minute".
 */
export interface BucketChoice {
  bucketMs: number
  /** Short label suitable for axis / title, e.g. "per minute" / "per day". */
  label: string
}

export function chooseBucket(filter: UsageFilter): BucketChoice {
  const span = Math.max(0, filter.until - filter.since)
  // 1h or less → minute buckets
  if (span <= 12 * HOUR_MS) return { bucketMs: MINUTE_MS, label: "per minute" }
  // up to ~3.5 days → hour buckets (covers 24h cleanly)
  if (span <= 3.5 * DAY_MS) return { bucketMs: HOUR_MS, label: "per hour" }
  // up to ~18 days → day buckets (covers 7d cleanly)
  if (span <= 18 * DAY_MS) return { bucketMs: DAY_MS, label: "per day" }
  // anything beyond → week buckets (covers 30d cleanly)
  return { bucketMs: 7 * DAY_MS, label: "per week" }
}

/**
 * Build a `(?,?,...)` placeholder string for a SQL IN clause.  Returns
 * `undefined` when the input list is empty/undefined, so the caller can
 * skip the WHERE-clause fragment entirely (an empty IN-list is a SQL error
 * and would silently filter out every row anyway).
 */
function inPlaceholders(values: Array<string> | undefined): string | undefined {
  if (!values || values.length === 0) return undefined
  return values.map(() => "?").join(",")
}

interface WhereFragment {
  sql: string
  params: Array<unknown>
}

/** Compose the WHERE clause shared by every dashboard query. */
function buildWhere(filter: UsageFilter): WhereFragment {
  const parts: Array<string> = ["ts >= ?", "ts < ?"]
  const params: Array<unknown> = [filter.since, filter.until]

  const keyIn = inPlaceholders(filter.keyIds)
  if (keyIn !== undefined && filter.keyIds) {
    parts.push(`key_id IN (${keyIn})`)
    params.push(...filter.keyIds)
  }
  const modelIn = inPlaceholders(filter.models)
  if (modelIn !== undefined && filter.models) {
    parts.push(`model IN (${modelIn})`)
    params.push(...filter.models)
  }
  return { sql: parts.join(" AND "), params }
}

// ---------------------------------------------------------------------------
// requestsPerBucket — grouped by model and a caller-chosen bucket size.
// Replaces the old hard-coded `requestsPerMinute` so 7d/30d don't render as
// a chart with thousands of minute-wide bars.
// ---------------------------------------------------------------------------

export function requestsPerBucket(
  filter: UsageFilter,
  bucketMs: number,
): Array<RpmPoint> {
  const where = buildWhere(filter)
  const sql = `SELECT (ts / ${bucketMs}) * ${bucketMs} AS bucket,
            model AS model,
            COUNT(*) AS count
       FROM events
      WHERE ${where.sql}
      GROUP BY bucket, model
      ORDER BY bucket ASC, model ASC`
  const rows = getDb()
    .query<{ bucket: number; model: string; count: number }, Array<unknown>>(
      sql,
    )
    .all(...where.params)
  return rows.map((r) => ({ ts: r.bucket, model: r.model, count: r.count }))
}

/**
 * Legacy alias kept for backwards-compat with any external caller that
 * still imports `requestsPerMinute`.  Always returns minute buckets.
 */
export function requestsPerMinute(filter: UsageFilter): Array<RpmPoint> {
  return requestsPerBucket(filter, MINUTE_MS)
}

// ---------------------------------------------------------------------------
// tokensPerBucket — bucketed prompt/completion sums
// ---------------------------------------------------------------------------

export function tokensPerBucket(
  filter: UsageFilter,
  bucketMs: number,
): Array<TokensPoint> {
  const where = buildWhere(filter)
  const sql = `SELECT (ts / ${bucketMs}) * ${bucketMs} AS bucket,
            COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS completion_tokens
       FROM events
      WHERE ${where.sql}
      GROUP BY bucket
      ORDER BY bucket ASC`
  const rows = getDb()
    .query<
      { bucket: number; prompt_tokens: number; completion_tokens: number },
      Array<unknown>
    >(sql)
    .all(...where.params)
  return rows.map((r) => ({
    ts: r.bucket,
    prompt_tokens: r.prompt_tokens,
    completion_tokens: r.completion_tokens,
  }))
}

export function tokensPerHour(filter: UsageFilter): Array<TokensPoint> {
  return tokensPerBucket(filter, HOUR_MS)
}

// ---------------------------------------------------------------------------
// p95LatencyPerHour — approximate p95 via index-based pick
//
// bun:sqlite lacks window-percentile functions, so for each hour bucket we
// run `SELECT latency_ms ORDER BY latency_ms LIMIT 1 OFFSET floor(0.95*N)`.
// The outer query enumerates buckets via GROUP BY; the per-bucket pick uses a
// correlated subquery.  All reads use idx_events_ts.
// ---------------------------------------------------------------------------

export function p95LatencyPerHour(filter: UsageFilter): Array<LatencyPoint> {
  const where = buildWhere(filter)
  // Step 1: bucket counts. Step 2: per-bucket OFFSET pick.
  // Doing two queries avoids a triple-nested correlated subquery that the
  // planner sometimes refuses to use indexes on.
  const buckets = getDb()
    .query<{ bucket: number; count: number }, Array<unknown>>(
      `SELECT (ts / ${HOUR_MS}) * ${HOUR_MS} AS bucket, COUNT(*) AS count
         FROM events
        WHERE ${where.sql}
        GROUP BY bucket
        ORDER BY bucket ASC`,
    )
    .all(...where.params)

  // Per-bucket SQL: replace the outer ts-range predicates with the tighter
  // bucket bounds so the inner SELECT scans only one hour's worth of rows.
  // The remaining filter predicates (key_id IN …, model IN …) — i.e. every
  // WHERE-clause part after the first two — are preserved verbatim.
  //
  // `where.params` always starts with [since, until]; everything after that
  // belongs to the trailing filter fragments and must be re-bound here.
  const tailParams = where.params.slice(2)
  const tailSql = where.sql.split(" AND ").slice(2).join(" AND ")
  const innerWhere =
    tailSql.length > 0 ?
      `ts >= ? AND ts < ? AND ${tailSql}`
    : `ts >= ? AND ts < ?`

  const out: Array<LatencyPoint> = []
  for (const b of buckets) {
    const offset = Math.floor(0.95 * (b.count - 1))
    const bucketEnd = b.bucket + HOUR_MS
    // OFFSET cannot use a bound parameter reliably across SQLite builds, so
    // inline the validated integer.
    const innerSql = `SELECT latency_ms FROM events
        WHERE ${innerWhere}
        ORDER BY latency_ms ASC
        LIMIT 1 OFFSET ${offset}`
    const row = getDb()
      .query<{ latency_ms: number }, Array<unknown>>(innerSql)
      .get(b.bucket, bucketEnd, ...tailParams)
    if (row) out.push({ ts: b.bucket, p95: row.latency_ms })
  }
  return out
}

// ---------------------------------------------------------------------------
// topKeysByTokens — top N keys by total (prompt + completion) tokens
// ---------------------------------------------------------------------------

export function topKeysByTokens(
  filter: UsageFilter,
  limit = 10,
): Array<TopKey> {
  const where = buildWhere(filter)
  const sql = `SELECT key_id,
            COALESCE(SUM(COALESCE(prompt_tokens, 0)
                       + COALESCE(completion_tokens, 0)), 0) AS tokens
       FROM events
      WHERE ${where.sql}
      GROUP BY key_id
      ORDER BY tokens DESC
      LIMIT ?`
  const rows = getDb()
    .query<{ key_id: string; tokens: number }, Array<unknown>>(sql)
    .all(...where.params, limit)
  return rows
}

// ---------------------------------------------------------------------------
// topModelsByRequests — top N models by request count
// ---------------------------------------------------------------------------

export function topModelsByRequests(
  filter: UsageFilter,
  limit = 10,
): Array<TopModel> {
  const where = buildWhere(filter)
  const sql = `SELECT model, COUNT(*) AS count
       FROM events
      WHERE ${where.sql}
      GROUP BY model
      ORDER BY count DESC
      LIMIT ?`
  const rows = getDb()
    .query<{ model: string; count: number }, Array<unknown>>(sql)
    .all(...where.params, limit)
  return rows
}

// ---------------------------------------------------------------------------
// errorRateByKey — per-key totals + non-2xx counts
// ---------------------------------------------------------------------------

export function errorRateByKey(filter: UsageFilter): Array<ErrorRateRow> {
  const where = buildWhere(filter)
  const sql = `SELECT key_id,
            COUNT(*)                                         AS total,
            SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END)   AS errors
       FROM events
      WHERE ${where.sql}
      GROUP BY key_id
      ORDER BY errors DESC, total DESC`
  const rows = getDb()
    .query<{ key_id: string; total: number; errors: number }, Array<unknown>>(
      sql,
    )
    .all(...where.params)
  return rows.map((r) => ({
    key_id: r.key_id,
    total: r.total,
    errors: r.errors,
    rate: r.total === 0 ? 0 : r.errors / r.total,
  }))
}

// ---------------------------------------------------------------------------
// streamEventsForCsv — yields rows incrementally for CSV export
//
// Wraps `query.iterate()` so callers can write rows to a stream without
// pulling the entire result set into memory first.  bun:sqlite's iterator
// yields plain objects matching the SELECT shape.
// ---------------------------------------------------------------------------

export function streamEventsForCsv(
  filter: UsageFilter,
): IterableIterator<EventRow> {
  const where = buildWhere(filter)
  const sql = `SELECT id, ts, key_id, model, upstream_model,
            prompt_tokens, completion_tokens, status, latency_ms,
            error, usage_unknown
       FROM events
      WHERE ${where.sql}
      ORDER BY ts ASC, id ASC`
  return getDb()
    .query<EventRow, Array<unknown>>(sql)
    .iterate(...where.params)
}

// ---------------------------------------------------------------------------
// Distinct-model helper (used by the page filter form)
// ---------------------------------------------------------------------------

export function distinctModels(): Array<string> {
  const rows = getDb()
    .query<
      { model: string },
      []
    >("SELECT DISTINCT model FROM events ORDER BY model")
    .all()
  return rows.map((r) => r.model)
}

// ---------------------------------------------------------------------------
// Per-key usage summary (used by /admin/keys/:id detail page)
//
// Returns the aggregate stats for a single key over a time window. All
// queries use idx_events_key_ts (covering for key_id + ts predicate).
// ---------------------------------------------------------------------------

export interface KeyUsageSummary {
  total_requests: number
  total_prompt_tokens: number
  total_completion_tokens: number
  errors: number
  error_rate: number // 0-1
  p95_latency_ms: number | null // null when no events
  last_used_ts: number | null // null when never used
}

export function usageForKey(keyId: string, windowMs: number): KeyUsageSummary {
  const db = getDb()
  const now = Date.now()
  const since = now - windowMs

  // Single SELECT covers totals + error count
  const agg = db
    .query<
      {
        total_requests: number
        total_prompt: number | null
        total_completion: number | null
        errors: number
        last_ts: number | null
      },
      [string, number]
    >(
      `SELECT
         COUNT(*) AS total_requests,
         SUM(prompt_tokens) AS total_prompt,
         SUM(completion_tokens) AS total_completion,
         SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
         MAX(ts) AS last_ts
       FROM events
       WHERE key_id = ? AND ts >= ?`,
    )
    .get(keyId, since)

  const totalReq = agg?.total_requests ?? 0
  if (totalReq === 0) {
    return {
      total_requests: 0,
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      errors: 0,
      error_rate: 0,
      p95_latency_ms: null,
      last_used_ts: null,
    }
  }

  // p95 via OFFSET (no window functions in bun:sqlite). For one key with one
  // window this is cheap — the key_id + ts index keeps the row set bounded.
  const offset = Math.floor(0.95 * (totalReq - 1))
  const p95Row = db
    .query<{ latency_ms: number }, [string, number]>(
      `SELECT latency_ms FROM events
       WHERE key_id = ? AND ts >= ?
       ORDER BY latency_ms ASC
       LIMIT 1 OFFSET ${offset}`,
    )
    .get(keyId, since)

  const errors = agg?.errors ?? 0
  return {
    total_requests: totalReq,
    total_prompt_tokens: agg?.total_prompt ?? 0,
    total_completion_tokens: agg?.total_completion ?? 0,
    errors,
    error_rate: totalReq > 0 ? errors / totalReq : 0,
    p95_latency_ms: p95Row?.latency_ms ?? null,
    last_used_ts: agg?.last_ts ?? null,
  }
}

// ---------------------------------------------------------------------------
// Per-key recent calls — last N events for this key (for detail page table)
// ---------------------------------------------------------------------------

export interface RecentCallRow {
  id: number
  ts: number
  model: string
  upstream_model: string
  status: number
  latency_ms: number
  prompt_tokens: number | null
  completion_tokens: number | null
  error: string | null
}

export function recentCallsForKey(
  keyId: string,
  limit = 20,
): Array<RecentCallRow> {
  return getDb()
    .query<RecentCallRow, [string, number]>(
      `SELECT id, ts, model, upstream_model, status, latency_ms,
              prompt_tokens, completion_tokens, error
         FROM events
         WHERE key_id = ?
         ORDER BY ts DESC
         LIMIT ?`,
    )
    .all(keyId, limit)
}

// ---------------------------------------------------------------------------
// latencyPercentiles — p50 / p95 / p99 per hour
//
// Uses the same OFFSET trick as p95LatencyPerHour but returns all three
// percentiles in one pass over the per-bucket count list. The inner SELECT
// runs three times per bucket (one per percentile) which is fine for the
// dashboard window: at 24h × 3 buckets/hr × 3 percentiles = 216 lookups,
// each constrained to a 1-hour window by idx_events_ts.
// ---------------------------------------------------------------------------

export interface LatencyPercentilesPoint {
  ts: number
  p50: number
  p95: number
  p99: number
}

export function latencyPercentiles(
  filter: UsageFilter,
  bucketMs: number = HOUR_MS,
): Array<LatencyPercentilesPoint> {
  const where = buildWhere(filter)
  const buckets = getDb()
    .query<{ bucket: number; count: number }, Array<unknown>>(
      `SELECT (ts / ${bucketMs}) * ${bucketMs} AS bucket, COUNT(*) AS count
         FROM events
        WHERE ${where.sql}
        GROUP BY bucket
        ORDER BY bucket ASC`,
    )
    .all(...where.params)

  const tailParams = where.params.slice(2)
  const tailSql = where.sql.split(" AND ").slice(2).join(" AND ")
  const innerWhere =
    tailSql.length > 0 ?
      `ts >= ? AND ts < ? AND ${tailSql}`
    : `ts >= ? AND ts < ?`

  const out: Array<LatencyPercentilesPoint> = []
  for (const b of buckets) {
    if (b.count === 0) continue
    const bucketEnd = b.bucket + bucketMs
    const pick = (frac: number): number => {
      const offset = Math.floor(frac * (b.count - 1))
      const innerSql = `SELECT latency_ms FROM events
            WHERE ${innerWhere}
            ORDER BY latency_ms ASC
            LIMIT 1 OFFSET ${offset}`
      const row = getDb()
        .query<{ latency_ms: number }, Array<unknown>>(innerSql)
        .get(b.bucket, bucketEnd, ...tailParams)
      return row?.latency_ms ?? 0
    }
    out.push({
      ts: b.bucket,
      p50: pick(0.5),
      p95: pick(0.95),
      p99: pick(0.99),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// errorBreakdownByStatus — counts grouped by status code (only error rows)
// ---------------------------------------------------------------------------

export interface ErrorByStatusRow {
  status: number
  count: number
  sample_error: string | null
}

export function errorBreakdownByStatus(
  filter: UsageFilter,
): Array<ErrorByStatusRow> {
  const where = buildWhere(filter)
  const sql = `SELECT status,
              COUNT(*) AS count,
              MAX(error) AS sample_error
         FROM events
        WHERE ${where.sql} AND status >= 400
        GROUP BY status
        ORDER BY count DESC, status ASC`
  return getDb()
    .query<
      { status: number; count: number; sample_error: string | null },
      Array<unknown>
    >(sql)
    .all(...where.params)
}
