/**
 * /admin/api/keys — JSON endpoints for the SPA's Keys pages.
 *
 * Endpoints
 *   GET    /admin/api/keys                 list (pagination)
 *   POST   /admin/api/keys                 create
 *   GET    /admin/api/keys/:id             detail (row + usage windows + recent)
 *   POST   /admin/api/keys/:id/revoke      revoke
 *   POST   /admin/api/keys/:id/scope       update scope (allowed_models / rate)
 *   POST   /admin/api/keys/:id/debug       toggle debug + 24h TTL renew
 *
 * Notes
 *   - Plain key string is returned EXACTLY ONCE in the POST /keys response.
 *     The SPA shows it once in a drawer with a "Copy" button and never asks
 *     again. There is no read-back endpoint.
 *   - Allowed_models is stored as a JSON string in the DB. We always return
 *     it parsed for the client.
 *   - All mutation routes audit-log via safeAudit (best-effort, never blocks
 *     the response).
 *   - Debug-enable requires an explicit confirm body field (debug_confirm:
 *     true), matching the legacy form gate.
 */

import consola from "consola"
import { Hono } from "hono"

import { getConfig } from "~/lib/config-store"
import { audit } from "~/services/audit"
import {
  countActiveDebugKeys,
  createKey,
  findKeyById,
  isDebugActive,
  listKeys,
  revokeKey,
  setDebugEnabled,
  updateKeyScope,
  type KeyRow,
} from "~/services/keys"

import type { SessionVar } from "../session-middleware"

import { recentCallsForKey, usageForKey } from "../usage/queries"

// UUID v4 / v7 style id (services/keys.ts uses crypto.randomUUID())
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PAGE_SIZE = 50
const MAX_LABEL_LEN = 200
const DAY_MS = 86_400_000

function safeAudit(event: Parameters<typeof audit>[0]): void {
  try {
    audit(event)
  } catch (err) {
    consola.error(`[admin] audit failed (continuing): ${String(err)}`)
  }
}

function parseAllowedModels(raw: unknown): Array<string> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) return undefined
  return raw.filter((m): m is string => typeof m === "string")
}

function parseRateLimit(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null || raw === "") return null
  const n =
    typeof raw === "number" ? raw
    : typeof raw === "string" ? Number.parseInt(raw, 10)
    : NaN
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

/** Serialise a KeyRow for the client. Adds parsed allowed_models + debug status. */
function serializeKey(row: KeyRow) {
  let allowedModels: Array<string>
  try {
    allowedModels = JSON.parse(row.allowed_models) as Array<string>
  } catch {
    allowedModels = ["*"]
  }
  return {
    id: row.id,
    tier: row.tier,
    label: row.label,
    allowed_models: allowedModels,
    rate_limit_override: row.rate_limit_override,
    debug_enabled: row.debug_enabled === 1,
    debug_active: isDebugActive(row),
    debug_expires_at: row.debug_expires_at,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  }
}

export const keysRoute = new Hono<{ Variables: SessionVar }>()

// ---------------------------------------------------------------------------
// GET /admin/api/keys
// ---------------------------------------------------------------------------
keysRoute.get("/", (c) => {
  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1)
  const pageSize = Math.min(
    100,
    Math.max(
      1,
      Number.parseInt(c.req.query("page_size") ?? `${PAGE_SIZE}`, 10)
        || PAGE_SIZE,
    ),
  )
  const offset = (page - 1) * pageSize
  const { rows, total } = listKeys(pageSize, offset)
  const debugKeyCount = countActiveDebugKeys()
  const activeCount = rows.filter((r) => r.revoked_at === null).length

  return c.json({
    items: rows.map(serializeKey),
    pagination: {
      page,
      page_size: pageSize,
      total,
      total_pages: Math.max(1, Math.ceil(total / pageSize)),
    },
    summary: {
      total_keys: total,
      active_on_page: activeCount,
      debug_active: debugKeyCount,
    },
  })
})

// ---------------------------------------------------------------------------
// POST /admin/api/keys
// ---------------------------------------------------------------------------
keysRoute.post("/", async (c) => {
  const session = c.get("session")
  let body: Record<string, unknown> = {}
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }

  const label =
    typeof body.label === "string" ? body.label.trim() : ""
  if (!label) return c.json({ error: "Label is required" }, 400)
  if (label.length > MAX_LABEL_LEN) {
    return c.json(
      { error: `Label too long (max ${MAX_LABEL_LEN} chars)` },
      400,
    )
  }

  const tier =
    body.tier === "admin" || body.tier === "client" ? body.tier : "client"

  const allowedModels = parseAllowedModels(body.allowed_models)
  if (allowedModels !== undefined && allowedModels.length === 0) {
    return c.json(
      { error: "Select at least one allowed model (or '*')" },
      400,
    )
  }

  const rateLimit = parseRateLimit(body.rate_limit_override)
  const debugEnabled = body.debug_enabled === true
  const debugConfirm = body.debug_confirm === true

  if (debugEnabled && !debugConfirm) {
    return c.json(
      { error: "Debug enable requires debug_confirm: true" },
      400,
    )
  }

  try {
    const { plain, row } = createKey({
      tier,
      label,
      allowedModels: allowedModels ?? ["*"],
      rateLimitOverride: rateLimit === null ? undefined : rateLimit,
      debugEnabled,
    })

    safeAudit({
      actor_key_id: session.key_id,
      actor_tier: "admin",
      action: "key.create",
      target: row.id,
      after: {
        label,
        tier,
        allowed_models: allowedModels ?? ["*"],
        rate_limit_override: rateLimit ?? null,
        debug_enabled: debugEnabled,
      },
    })

    return c.json(
      {
        key: serializeKey(row),
        plain, // shown once on the client, never persisted server-side beyond this response
      },
      201,
    )
  } catch (err) {
    return c.json({ error: String(err) }, 400)
  }
})

// ---------------------------------------------------------------------------
// GET /admin/api/keys/:id
// ---------------------------------------------------------------------------
keysRoute.get("/:id", (c) => {
  const id = c.req.param("id")
  if (!UUID_RE.test(id)) return c.json({ error: "Not found" }, 404)
  const row = findKeyById(id)
  if (!row) return c.json({ error: "Not found" }, 404)

  const config = getConfig()
  const usage_24h = usageForKey(id, DAY_MS)
  const usage_7d = usageForKey(id, 7 * DAY_MS)
  const usage_30d = usageForKey(id, 30 * DAY_MS)
  const recent = recentCallsForKey(id, 20)

  return c.json({
    key: serializeKey(row),
    usage: {
      "24h": usage_24h,
      "7d": usage_7d,
      "30d": usage_30d,
    },
    recent_calls: recent,
    available_aliases: Object.keys(config.models),
    retention_traces_days: config.retention.traces_days,
  })
})

// ---------------------------------------------------------------------------
// POST /admin/api/keys/:id/revoke
// ---------------------------------------------------------------------------
keysRoute.post("/:id/revoke", (c) => {
  const session = c.get("session")
  const id = c.req.param("id")
  if (!UUID_RE.test(id)) return c.json({ error: "Not found" }, 404)
  const row = findKeyById(id)
  if (!row) return c.json({ error: "Not found" }, 404)

  const changed = revokeKey(id)
  if (changed) {
    safeAudit({
      actor_key_id: session.key_id,
      actor_tier: "admin",
      action: "key.revoke",
      target: id,
    })
  }
  const updated = findKeyById(id)
  return c.json({
    ok: true,
    revoked: changed,
    key: updated ? serializeKey(updated) : null,
  })
})

// ---------------------------------------------------------------------------
// POST /admin/api/keys/:id/scope
// ---------------------------------------------------------------------------
keysRoute.post("/:id/scope", async (c) => {
  const session = c.get("session")
  const id = c.req.param("id")
  if (!UUID_RE.test(id)) return c.json({ error: "Not found" }, 404)
  const row = findKeyById(id)
  if (!row) return c.json({ error: "Not found" }, 404)
  if (row.revoked_at !== null)
    return c.json({ error: "Key is revoked" }, 400)

  let body: Record<string, unknown> = {}
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }

  const allowedModels = parseAllowedModels(body.allowed_models)
  if (allowedModels === undefined) {
    return c.json({ error: "allowed_models is required" }, 400)
  }
  if (allowedModels.length === 0) {
    return c.json(
      { error: "Select at least one allowed model (or '*')" },
      400,
    )
  }

  const rateLimit = parseRateLimit(body.rate_limit_override)
  const rateLimitFinal = rateLimit === undefined ? null : rateLimit

  try {
    const changed = updateKeyScope(id, allowedModels, rateLimitFinal)
    if (changed) {
      safeAudit({
        actor_key_id: session.key_id,
        actor_tier: "admin",
        action: "key.scope_update",
        target: id,
        after: {
          allowed_models: allowedModels,
          rate_limit_override: rateLimitFinal,
        },
      })
    }
    const updated = findKeyById(id)
    return c.json({
      ok: true,
      changed,
      key: updated ? serializeKey(updated) : null,
    })
  } catch (err) {
    return c.json({ error: String(err) }, 400)
  }
})

// ---------------------------------------------------------------------------
// POST /admin/api/keys/:id/debug
//
// Body shape:
//   { enabled: true,  confirm: true }  → enable + 24h TTL
//   { enabled: false }                  → disable
//   { action: "renew" }                 → bump TTL by 24h (debug must be on)
// ---------------------------------------------------------------------------
keysRoute.post("/:id/debug", async (c) => {
  const session = c.get("session")
  const id = c.req.param("id")
  if (!UUID_RE.test(id)) return c.json({ error: "Not found" }, 404)
  const row = findKeyById(id)
  if (!row) return c.json({ error: "Not found" }, 404)
  if (row.revoked_at !== null)
    return c.json({ error: "Key is revoked" }, 400)

  let body: Record<string, unknown> = {}
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }

  let auditAction: string
  if (body.action === "renew") {
    setDebugEnabled(id, true)
    auditAction = "key.debug_renew"
  } else if (body.enabled === true) {
    if (body.confirm !== true) {
      return c.json(
        { error: "Debug enable requires confirm: true" },
        400,
      )
    }
    setDebugEnabled(id, true)
    auditAction = "key.debug_enable"
  } else {
    setDebugEnabled(id, false)
    auditAction = "key.debug_disable"
  }

  safeAudit({
    actor_key_id: session.key_id,
    actor_tier: "admin",
    action: auditAction,
    target: id,
  })

  const updated = findKeyById(id)
  return c.json({
    ok: true,
    key: updated ? serializeKey(updated) : null,
  })
})
