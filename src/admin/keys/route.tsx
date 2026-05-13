/** @jsxImportSource hono/jsx */
import { Hono } from "hono"

import { getConfig } from "~/lib/config-store"
import { audit } from "~/services/audit"
import {
  countActiveDebugKeys,
  createKey,
  findKeyById,
  listKeys,
  revokeKey,
  setDebugEnabled,
  updateKeyScope,
} from "~/services/keys"

import type { SessionVar } from "../session-middleware"

import { ADMIN_SECURITY_HEADERS, Layout } from "../layout"
import { KeyDetail } from "./detail"
import { KeyList } from "./list"
import { KeyCreatedBanner, NewKeyForm } from "./new"

// ---------------------------------------------------------------------------
// In-memory flash store (process-lifetime): plain key, shown once then gone.
// Key: random flash token  Value: { plain, keyId, expires }
// ---------------------------------------------------------------------------

interface FlashEntry {
  plain: string
  keyId: string
  expires: number
}

const flashStore = new Map<string, FlashEntry>()
const FLASH_TTL_MS = 5 * 60 * 1000 // 5 minutes max to view

function createFlash(plain: string, keyId: string): string {
  const token = crypto.randomUUID()
  flashStore.set(token, { plain, keyId, expires: Date.now() + FLASH_TTL_MS })
  // Sweep stale entries (amortised)
  const now = Date.now()
  for (const [k, v] of flashStore) {
    if (v.expires < now) flashStore.delete(k)
  }
  return token
}

function consumeFlash(token: string): FlashEntry | null {
  const entry = flashStore.get(token)
  if (!entry) return null
  flashStore.delete(token) // one-time
  if (entry.expires < Date.now()) return null
  return entry
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50

function parseAllowedModels(
  raw: string | Array<string> | undefined,
): Array<string> {
  if (!raw) return ["*"]
  if (Array.isArray(raw)) return raw.length > 0 ? raw : ["*"]
  return [raw]
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (!raw || raw.trim() === "") return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// ---------------------------------------------------------------------------
// Keys app (mounted at /admin/keys inside sessionProtected)
// ---------------------------------------------------------------------------

const keysApp = new Hono<{ Variables: SessionVar }>()

// Apply security headers
keysApp.use("*", async (c, next) => {
  await next()
  for (const [k, v] of Object.entries(ADMIN_SECURITY_HEADERS)) {
    c.header(k, v)
  }
})

// ---------------------------------------------------------------------------
// GET /admin/keys
// ---------------------------------------------------------------------------

keysApp.get("/", (c) => {
  const session = c.get("session")
  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10))
  const offset = (page - 1) * PAGE_SIZE
  const { rows, total } = listKeys(PAGE_SIZE, offset)
  const debugKeyCount = countActiveDebugKeys()

  return c.html(
    <Layout
      title="Keys"
      active="keys"
      csrfToken={session.csrf_token}
      debugKeyCount={debugKeyCount}
    >
      <KeyList
        keys={rows}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        csrfToken={session.csrf_token}
      />
    </Layout>,
  )
})

// ---------------------------------------------------------------------------
// GET /admin/keys/new
// ---------------------------------------------------------------------------

keysApp.get("/new", (c) => {
  const session = c.get("session")
  const config = getConfig()

  return c.html(
    <Layout title="New Key" active="keys" csrfToken={session.csrf_token}>
      <NewKeyForm
        csrfToken={session.csrf_token}
        tracesDays={config.retention.traces_days}
      />
    </Layout>,
  )
})

// ---------------------------------------------------------------------------
// POST /admin/keys/new
// ---------------------------------------------------------------------------

keysApp.post("/new", async (c) => {
  const session = c.get("session")
  const body = await c.req.parseBody()

  const label = typeof body["label"] === "string" ? body["label"].trim() : ""
  if (!label) {
    const config = getConfig()
    return c.html(
      <Layout title="New Key" active="keys" csrfToken={session.csrf_token}>
        <NewKeyForm
          csrfToken={session.csrf_token}
          tracesDays={config.retention.traces_days}
          error="Label is required"
        />
      </Layout>,
      400,
    )
  }

  const tier =
    body["tier"] === "admin" || body["tier"] === "client" ?
      body["tier"]
    : "client"
  const allowedModels = parseAllowedModels(
    body["allowed_models"] as string | Array<string> | undefined,
  )
  const rateLimitOverride =
    parseIntOrNull(body["rate_limit_override"] as string | undefined)
    ?? undefined
  const debugEnabled = body["debug_enabled"] === "1"

  try {
    const { plain, row } = createKey({
      tier,
      label,
      allowedModels,
      rateLimitOverride,
      debugEnabled,
    })

    audit({
      actor_key_id: session.key_id,
      actor_tier: "admin",
      action: "key.create",
      target: row.id,
      after: {
        label,
        tier,
        allowed_models: allowedModels,
        rate_limit_override: rateLimitOverride ?? null,
        debug_enabled: debugEnabled,
      },
    })

    const flashToken = createFlash(plain, row.id)
    return c.redirect(`/admin/keys/created?flash=${flashToken}`, 303)
  } catch (err) {
    const config = getConfig()
    return c.html(
      <Layout title="New Key" active="keys" csrfToken={session.csrf_token}>
        <NewKeyForm
          csrfToken={session.csrf_token}
          tracesDays={config.retention.traces_days}
          error={String(err)}
        />
      </Layout>,
      400,
    )
  }
})

// ---------------------------------------------------------------------------
// GET /admin/keys/created — one-time plaintext display
// ---------------------------------------------------------------------------

keysApp.get("/created", (c) => {
  const session = c.get("session")
  const flashToken = c.req.query("flash") ?? ""
  const entry = consumeFlash(flashToken)

  if (!entry) {
    return c.redirect("/admin/keys", 302)
  }

  return c.html(
    <Layout title="Key Created" active="keys" csrfToken={session.csrf_token}>
      <KeyCreatedBanner plain={entry.plain} keyId={entry.keyId} />
    </Layout>,
  )
})

// ---------------------------------------------------------------------------
// GET /admin/keys/:id — key detail page
// ---------------------------------------------------------------------------

keysApp.get("/:id", (c) => {
  const session = c.get("session")
  const id = c.req.param("id")
  const row = findKeyById(id)
  if (!row) return c.text("Key not found", 404)

  const config = getConfig()
  const success = c.req.query("success")

  return c.html(
    <Layout title="Key Detail" active="keys" csrfToken={session.csrf_token}>
      <KeyDetail
        row={row}
        csrfToken={session.csrf_token}
        tracesDays={config.retention.traces_days}
        success={success}
      />
    </Layout>,
  )
})

// ---------------------------------------------------------------------------
// POST /admin/keys/:id/revoke
// ---------------------------------------------------------------------------

keysApp.post("/:id/revoke", (c) => {
  const session = c.get("session")
  const id = c.req.param("id")
  const row = findKeyById(id)
  if (!row) return c.text("Key not found", 404)

  const changed = revokeKey(id)
  if (changed) {
    audit({
      actor_key_id: session.key_id,
      actor_tier: "admin",
      action: "key.revoke",
      target: id,
    })
  }

  return c.redirect(`/admin/keys?success=revoked`, 303)
})

// ---------------------------------------------------------------------------
// POST /admin/keys/:id/scope
// ---------------------------------------------------------------------------

keysApp.post("/:id/scope", async (c) => {
  const session = c.get("session")
  const id = c.req.param("id")
  const row = findKeyById(id)
  if (!row) return c.text("Key not found", 404)
  if (row.revoked_at !== null) return c.text("Key is revoked", 400)

  const body = await c.req.parseBody()
  const allowedModels = parseAllowedModels(
    body["allowed_models"] as string | Array<string> | undefined,
  )
  const rateLimitOverride = parseIntOrNull(
    body["rate_limit_override"] as string | undefined,
  )

  try {
    const changed = updateKeyScope(id, allowedModels, rateLimitOverride)
    if (changed) {
      audit({
        actor_key_id: session.key_id,
        actor_tier: "admin",
        action: "key.scope_update",
        target: id,
        after: {
          allowed_models: allowedModels,
          rate_limit_override: rateLimitOverride,
        },
      })
    }
    return c.redirect(`/admin/keys/${id}?success=scope_updated`, 303)
  } catch (err) {
    const config = getConfig()
    const updatedRow = findKeyById(id) ?? row
    return c.html(
      <Layout title="Key Detail" active="keys" csrfToken={session.csrf_token}>
        <KeyDetail
          row={updatedRow}
          csrfToken={session.csrf_token}
          tracesDays={config.retention.traces_days}
          error={String(err)}
        />
      </Layout>,
      400,
    )
  }
})

// ---------------------------------------------------------------------------
// POST /admin/keys/:id/debug
// ---------------------------------------------------------------------------

keysApp.post("/:id/debug", async (c) => {
  const session = c.get("session")
  const id = c.req.param("id")
  const row = findKeyById(id)
  if (!row) return c.text("Key not found", 404)
  if (row.revoked_at !== null) return c.text("Key is revoked", 400)

  const body = await c.req.parseBody()
  const enabledRaw = body["debug_enabled"]
  const enabled = enabledRaw === "1" || enabledRaw === "true"

  // Require explicit confirmation for enabling debug (body must contain debug_enabled=1)
  // Disabling and renewing don't need extra confirmation
  setDebugEnabled(id, enabled)

  audit({
    actor_key_id: session.key_id,
    actor_tier: "admin",
    action: enabled ? "key.debug_enable" : "key.debug_disable",
    target: id,
  })

  return c.redirect(`/admin/keys/${id}?success=debug_updated`, 303)
})

export { keysApp }
