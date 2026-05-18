/**
 * GET /admin/api/overview — single bundled payload for the SPA dashboard.
 *
 * Composes existing query helpers (admin/usage/queries.ts) over a fixed 24h
 * window. Returns:
 *   - kpis: aggregate totals (requests, tokens, error rate, p95, key counts)
 *   - series_requests_24h: per-minute request points per model (top 6 enforced
 *     by the UI, but we return everything so the SPA can render a "others"
 *     bucket too)
 *   - top_models_24h / top_keys_24h: leaderboards for the donut + bar list
 *   - recent_calls: 10 newest events across all keys, used by the activity feed
 *   - system: auth mode label + bind + config version + VS Code versions, so
 *     the SPA's status banner doesn't need its own endpoint
 *
 * Everything below 24h re-runs at the SQLite layer for simplicity. The
 * window is small (events table indexed on `ts`) and the SPA re-fetches at
 * 15s — well under the cost budget.
 */

import { Hono } from "hono"

import { getConfig } from "~/lib/config-store"
import { getDb } from "~/lib/db"
import { state } from "~/lib/state"
import { countActiveDebugKeys } from "~/services/keys"

import {
  p95LatencyPerHour,
  requestsPerMinute,
  topKeysByTokens,
  topModelsByRequests,
  type UsageFilter,
} from "../usage/queries"

import type { SessionVar } from "../session-middleware"

const DAY_MS = 24 * 60 * 60 * 1000

interface AggregateRow {
  total_requests: number
  total_prompt: number | null
  total_completion: number | null
  errors: number
}

interface KeyMetaRow {
  id: string
  label: string | null
}

interface RecentRow {
  id: number
  ts: number
  key_id: string
  model: string
  status: number
  latency_ms: number
  prompt_tokens: number | null
  completion_tokens: number | null
}

interface KeyCountRow {
  active_keys: number
  total_keys: number
}

export const overviewRoute = new Hono<{ Variables: SessionVar }>()

overviewRoute.get("/", (c) => {
  const now = Date.now()
  const since = now - DAY_MS
  const filter: UsageFilter = { since, until: now }

  const db = getDb()

  // KPIs ---------------------------------------------------------------------
  const agg = db
    .query<AggregateRow, [number]>(
      `SELECT
         COUNT(*)                                        AS total_requests,
         SUM(prompt_tokens)                              AS total_prompt,
         SUM(completion_tokens)                          AS total_completion,
         SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END)  AS errors
       FROM events
       WHERE ts >= ?`,
    )
    .get(since)
  const totalReq = agg?.total_requests ?? 0
  const errors = agg?.errors ?? 0

  // p95 24h: re-use the per-hour helper and pick the worst bucket as an
  // approximation. (Computing a global p95 over a day means sorting an entire
  // day's events; the worst-hour proxy is what the operator usually cares
  // about anyway, and it's free since we already need the hour series.)
  const p95Series = p95LatencyPerHour(filter)
  const p95_24h =
    p95Series.length === 0
      ? null
      : Math.max(...p95Series.map((p) => p.p95))

  const keyCount = db
    .query<KeyCountRow, []>(
      `SELECT
         SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active_keys,
         COUNT(*) AS total_keys
       FROM keys`,
    )
    .get() ?? { active_keys: 0, total_keys: 0 }

  const kpis = {
    total_requests_24h: totalReq,
    total_prompt_tokens_24h: agg?.total_prompt ?? 0,
    total_completion_tokens_24h: agg?.total_completion ?? 0,
    errors_24h: errors,
    error_rate_24h: totalReq > 0 ? errors / totalReq : 0,
    p95_latency_ms_24h: p95_24h,
    active_keys: keyCount.active_keys,
    debug_keys: countActiveDebugKeys(),
    total_keys: keyCount.total_keys,
  }

  // Series ------------------------------------------------------------------
  const series_requests_24h = requestsPerMinute(filter)

  // Top models + top keys (with label lookup for keys) ----------------------
  const top_models_24h = topModelsByRequests(filter, 8).map((m) => ({
    model: m.model,
    requests: m.count,
  }))

  const topKeysRaw = topKeysByTokens(filter, 5)
  const labelById = new Map<string, string | null>()
  if (topKeysRaw.length > 0) {
    const placeholders = topKeysRaw.map(() => "?").join(",")
    const rows = db
      .query<KeyMetaRow, Array<string>>(
        `SELECT id, label FROM keys WHERE id IN (${placeholders})`,
      )
      .all(...topKeysRaw.map((r) => r.key_id))
    for (const r of rows) labelById.set(r.id, r.label)
  }

  // We also want request + token split per top key. Single roll-up:
  const topKeyAgg = new Map<
    string,
    { prompt_tokens: number; completion_tokens: number; requests: number }
  >()
  if (topKeysRaw.length > 0) {
    const placeholders = topKeysRaw.map(() => "?").join(",")
    const rows = db
      .query<
        {
          key_id: string
          prompt: number | null
          completion: number | null
          requests: number
        },
        Array<unknown>
      >(
        `SELECT key_id,
                COALESCE(SUM(prompt_tokens), 0)     AS prompt,
                COALESCE(SUM(completion_tokens), 0) AS completion,
                COUNT(*)                            AS requests
           FROM events
          WHERE ts >= ? AND key_id IN (${placeholders})
          GROUP BY key_id`,
      )
      .all(since, ...topKeysRaw.map((r) => r.key_id))
    for (const r of rows) {
      topKeyAgg.set(r.key_id, {
        prompt_tokens: r.prompt ?? 0,
        completion_tokens: r.completion ?? 0,
        requests: r.requests,
      })
    }
  }

  const top_keys_24h = topKeysRaw.map((k) => {
    const a = topKeyAgg.get(k.key_id) ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      requests: 0,
    }
    return {
      key_id: k.key_id,
      label: labelById.get(k.key_id) ?? null,
      prompt_tokens: a.prompt_tokens,
      completion_tokens: a.completion_tokens,
      requests: a.requests,
    }
  })

  // Recent calls — newest 10 across all keys, with key label lookup. -------
  const recentRaw = db
    .query<RecentRow, []>(
      `SELECT id, ts, key_id, model, status, latency_ms,
              prompt_tokens, completion_tokens
         FROM events
         ORDER BY ts DESC
         LIMIT 10`,
    )
    .all()
  const recentKeyIds = [...new Set(recentRaw.map((r) => r.key_id))]
  const recentLabels = new Map<string, string | null>()
  if (recentKeyIds.length > 0) {
    const placeholders = recentKeyIds.map(() => "?").join(",")
    const rows = db
      .query<KeyMetaRow, Array<string>>(
        `SELECT id, label FROM keys WHERE id IN (${placeholders})`,
      )
      .all(...recentKeyIds)
    for (const r of rows) recentLabels.set(r.id, r.label)
  }
  const recent_calls = recentRaw.map((r) => ({
    id: r.id,
    ts: r.ts,
    key_id: r.key_id,
    key_label: recentLabels.get(r.key_id) ?? null,
    model: r.model,
    status: r.status,
    latency_ms: r.latency_ms,
    prompt_tokens: r.prompt_tokens,
    completion_tokens: r.completion_tokens,
  }))

  // System ------------------------------------------------------------------
  const config = getConfig()
  const system = {
    auth_mode_label: state.authModeLabel ?? (config.features.auth ? "on" : "off (loopback)"),
    bind_address: state.bindAddress ?? "unknown",
    config_version: config.version,
    vscode_version: state.vsCodeVersion ?? null,
    copilot_chat_version: state.copilotChatVersion ?? null,
  }

  return c.json({
    kpis,
    series_requests_24h,
    top_models_24h,
    top_keys_24h,
    recent_calls,
    system,
  })
})
