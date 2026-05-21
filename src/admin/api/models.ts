/**
 * /admin/api/models — list configured model aliases with 24h usage joined in.
 *
 * Each row reflects an entry from config.models (the alias map) plus the
 * latest aggregate stats from the events table over the past 24 hours.
 * Useful for spotting unused aliases, error-heavy backends, or
 * unexpectedly-detected upstream models.
 *
 * Also exposes the live upstream catalog at /admin/api/models/upstream so the
 * Settings page can render a dropdown of valid upstream model ids (with full
 * capability metadata: token limits, vendor, family, supports.tool_calls, …).
 */

import { Hono } from "hono"

import { getConfig } from "~/lib/config-store"
import { getDb } from "~/lib/db"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

import type { SessionVar } from "../session-middleware"

const DAY_MS = 24 * 60 * 60 * 1000

interface ModelAggRow {
  model: string
  count: number
  errors: number
  last_used: number
}

export const modelsRoute = new Hono<{ Variables: SessionVar }>()

// ---------------------------------------------------------------------------
// GET /admin/api/models/upstream
//
// Defined BEFORE the catch-all `/:alias` so Hono's router doesn't shadow it.
// Returns the live Copilot model catalog (cached at startup by cacheModels())
// verbatim — caller-side renderers walk the structure dynamically because
// Copilot keeps adding new capability fields and we don't want to drop them.
// ---------------------------------------------------------------------------
modelsRoute.get("/upstream", (c) => {
  // Spread the model record so any forward-compat fields Copilot adds in the
  // future (new supports.* / limits.* / unknown top-level keys) surface in
  // the catalog response without a code change here.
  const items = (state.models?.data ?? []).map((m) => ({
    ...(m as Record<string, unknown>),
  }))
  // Sort: enabled first, then vendor, then id
  items.sort((a, b) => {
    const aP = (a as { model_picker_enabled?: boolean }).model_picker_enabled
    const bP = (b as { model_picker_enabled?: boolean }).model_picker_enabled
    if (aP !== bP) return aP ? -1 : 1
    const aV = (a as { vendor?: string }).vendor ?? ""
    const bV = (b as { vendor?: string }).vendor ?? ""
    if (aV !== bV) return aV.localeCompare(bV)
    const aI = (a as { id?: string }).id ?? ""
    const bI = (b as { id?: string }).id ?? ""
    return aI.localeCompare(bI)
  })
  return c.json({ items, count: items.length })
})

// ---------------------------------------------------------------------------
// POST /admin/api/models/refresh
//
// Re-pulls the upstream Copilot model catalog and replaces state.models. Lets
// the admin UI surface newly-added upstream models (or capability changes)
// without restarting the proxy. Returns the fresh catalog size on success.
// Also defined BEFORE the catch-all `/:alias`.
// ---------------------------------------------------------------------------
modelsRoute.post("/refresh", async (c) => {
  try {
    await cacheModels()
    return c.json({
      ok: true,
      catalog_size: state.models?.data.length ?? 0,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return c.json({ ok: false, error: msg }, 502)
  }
})

modelsRoute.get("/", (c) => {
  const config = getConfig()
  const aliases = Object.entries(config.models)
  const now = Date.now()
  const since = now - DAY_MS
  const db = getDb()

  // Aggregate stats per alias
  const aggRows = db
    .query<ModelAggRow, [number]>(
      `SELECT model,
              COUNT(*) AS count,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
              MAX(ts) AS last_used
         FROM events
         WHERE ts >= ?
         GROUP BY model`,
    )
    .all(since)
  const aggByAlias = new Map<string, ModelAggRow>()
  for (const r of aggRows) aggByAlias.set(r.model, r)

  // Latest detected upstream model per alias (heuristic: take the most-recent
  // upstream_model string).
  const upstreamRows = db
    .query<{ model: string; upstream_model: string; ts: number }, [number]>(
      `SELECT model, upstream_model, ts
         FROM events
         WHERE ts >= ?
         ORDER BY ts DESC`,
    )
    .all(since)
  const latestUpstreamByAlias = new Map<string, string>()
  for (const r of upstreamRows) {
    if (!latestUpstreamByAlias.has(r.model)) {
      latestUpstreamByAlias.set(r.model, r.upstream_model)
    }
  }

  // Build a capability lookup keyed by upstream id. We pass the upstream
  // `limits` and `supports` objects through verbatim — Copilot adds new
  // capability fields regularly (max_thinking_budget, reasoning_effort,
  // adaptive_thinking, structured_outputs, vision.*, …) and consumers should
  // walk the records rather than rely on the proxy to enumerate every key.
  // Also expose the top-level fields that matter for operators:
  // `supported_endpoints` (the authoritative endpoint router signal),
  // `policy.state` (whether the model is enabled at the GitHub policy
  // level), and `model_picker_category` (Copilot's UI grouping).
  const capsByUpstream = new Map<string, Record<string, unknown>>()
  for (const m of state.models?.data ?? []) {
    capsByUpstream.set(m.id, {
      vendor: m.vendor,
      version: m.version,
      family: m.capabilities.family,
      type: m.capabilities.type,
      tokenizer: m.capabilities.tokenizer,
      limits: m.capabilities.limits,
      supports: m.capabilities.supports,
      preview: m.preview,
      model_picker_enabled: m.model_picker_enabled,
      model_picker_category: (m as { model_picker_category?: string })
        .model_picker_category,
      supported_endpoints: (m as { supported_endpoints?: Array<string> })
        .supported_endpoints,
      policy: m.policy,
    })
  }

  const items = aliases.map(([alias, entry]) => {
    const agg = aggByAlias.get(alias)
    const requests = agg?.count ?? 0
    const errors = agg?.errors ?? 0
    const caps = capsByUpstream.get(entry.upstream) ?? null
    return {
      alias,
      upstream: entry.upstream,
      enabled: entry.enabled,
      allowed_keys: entry.allowed_keys,
      detected_upstream: latestUpstreamByAlias.get(alias) ?? null,
      requests_24h: requests,
      errors_24h: errors,
      error_rate_24h: requests === 0 ? 0 : errors / requests,
      last_used: agg?.last_used ?? null,
      capabilities: caps,
    }
  })

  const aliases_in_use = items.filter((i) => i.requests_24h > 0).length
  const aliases_with_errors = items.filter((i) => i.errors_24h > 0).length

  return c.json({
    items,
    summary: {
      total_aliases: items.length,
      aliases_in_use,
      aliases_with_errors,
      catalog_size: state.models?.data.length ?? 0,
    },
  })
})

// ---------------------------------------------------------------------------
// GET /admin/api/models/:alias — detail (config + 20 recent + 24h errors)
// ---------------------------------------------------------------------------

modelsRoute.get("/:alias", (c) => {
  const alias = c.req.param("alias")
  const config = getConfig()
  const entry = (
    config.models as Record<
      string,
      | { upstream: string; enabled: boolean; allowed_keys: Array<string> }
      | undefined
    >
  )[alias]
  if (!entry) return c.json({ error: "Alias not found" }, 404)

  const db = getDb()
  const recent = db
    .query<
      {
        ts: number
        key_id: string
        upstream_model: string
        status: number
        latency_ms: number
        prompt_tokens: number | null
        completion_tokens: number | null
        error: string | null
      },
      [string]
    >(
      `SELECT ts, key_id, upstream_model, status, latency_ms,
              prompt_tokens, completion_tokens, error
         FROM events
         WHERE model = ?
         ORDER BY ts DESC
         LIMIT 20`,
    )
    .all(alias)

  const errors_24h = db
    .query<
      {
        ts: number
        key_id: string
        status: number
        error: string | null
      },
      [string, number]
    >(
      `SELECT ts, key_id, status, error
         FROM events
         WHERE model = ? AND ts >= ? AND status >= 400
         ORDER BY ts DESC
         LIMIT 20`,
    )
    .all(alias, Date.now() - DAY_MS)

  // Capability metadata for the alias's upstream
  const upstreamModel = state.models?.data.find((m) => m.id === entry.upstream)

  return c.json({
    alias,
    config: entry,
    upstream_info:
      upstreamModel ?
        {
          id: upstreamModel.id,
          name: upstreamModel.name,
          vendor: upstreamModel.vendor,
          version: upstreamModel.version,
          preview: upstreamModel.preview,
          capabilities: upstreamModel.capabilities,
        }
      : null,
    recent_calls: recent,
    errors_24h,
  })
})
