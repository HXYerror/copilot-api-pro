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
// requestsPerMinute — bucketed by minute, grouped by model
// ---------------------------------------------------------------------------

export function requestsPerMinute(filter: UsageFilter): Array<RpmPoint> {
  const where = buildWhere(filter)
  const sql = `SELECT (ts / ${MINUTE_MS}) * ${MINUTE_MS} AS bucket,
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

// ---------------------------------------------------------------------------
// tokensPerHour — hour buckets, summed prompt/completion
// ---------------------------------------------------------------------------

export function tokensPerHour(filter: UsageFilter): Array<TokensPoint> {
  const where = buildWhere(filter)
  const sql = `SELECT (ts / ${HOUR_MS}) * ${HOUR_MS} AS bucket,
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
