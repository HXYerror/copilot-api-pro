/** @jsxImportSource hono/jsx */
import consola from "consola"
import { Hono } from "hono"
import crypto from "node:crypto"

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
import { recentCallsForKey, usageForKey } from "../usage/queries"
import { KeyDetail } from "./detail"
import { KeyList } from "./list"
import { KeyCreatedBanner, NewKeyForm } from "./new"

// ---------------------------------------------------------------------------
// In-memory flash store (process-lifetime): plain key, shown once then gone.
// Key: random flash token  Value: { plain, keyId, expires }
//
// Note: on process restart this is lost. A user who didn't view the page yet
// will be redirected to /admin/keys with an explicit error message and must
// revoke + recreate the key (covered in handleMissingFlash below).
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
const MAX_LABEL_LEN = 200
// UUID v4 / v7 style id (services/keys.ts uses crypto.randomUUID())
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Parse the allowed_models field from a parsed form body.
 *
 * Behaviour:
 * - field absent AND `allowed_models_present` sentinel absent → undefined
 *   (caller decides: for /new this becomes the default; for /scope it means
 *   "no field, no update").
 * - field present (even if empty array) → return the explicit list. An
 *   empty list is a privilege-narrowing operation that callers must REJECT
 *   rather than widen to "*".
 */
function parseAllowedModels(body: Record<string, unknown>): {
  explicit: boolean
  models: Array<string>
} {
  const raw = body["allowed_models"]
  const hasSentinel =
    typeof body["allowed_models_present"] === "string"
    && body["allowed_models_present"] === "1"

  let list: Array<string>
  if (Array.isArray(raw)) {
    list = raw.filter((m): m is string => typeof m === "string")
  } else if (typeof raw === "string" && raw.length > 0) {
    list = [raw]
  } else {
    list = []
  }

  const explicit = hasSentinel || list.length > 0
  return { explicit, models: list }
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (!raw || raw.trim() === "") return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function parsePageParam(raw: string | undefined): number {
  if (!raw) return 1
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/** Best-effort audit: log but never let a failing audit break a mutation. */
function safeAudit(event: Parameters<typeof audit>[0]): void {
  try {
    audit(event)
  } catch (err) {
    consola.error(`[admin] audit failed (continuing): ${String(err)}`)
  }
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
  const page = parsePageParam(c.req.query("page"))
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
  // `{ all: true }` so multi-value fields (allowed_models checkboxes) come
  // back as arrays. The session middleware also parses the body (to extract
  // the CSRF token) and Hono caches the parsed result, so we keep both
  // call sites aligned on `{ all: true }` to avoid the cache producing a
  // flattened (single-value) view here.
  const body = await c.req.parseBody({ all: true })
  const config = getConfig()

  const renderErr = (msg: string): Response =>
    c.html(
      <Layout title="New Key" active="keys" csrfToken={session.csrf_token}>
        <NewKeyForm
          csrfToken={session.csrf_token}
          tracesDays={config.retention.traces_days}
          error={msg}
        />
      </Layout>,
      400,
    )

  // Label validation
  const label = typeof body["label"] === "string" ? body["label"].trim() : ""
  if (!label) return renderErr("Label is required")
  if (label.length > MAX_LABEL_LEN) {
    return renderErr(`Label too long (max ${MAX_LABEL_LEN} chars)`)
  }

  const tier =
    body["tier"] === "admin" || body["tier"] === "client" ?
      body["tier"]
    : "client"

  // Allowed models: parse, reject empty-when-explicit (privilege widening)
  const { explicit, models } = parseAllowedModels(body)
  if (explicit && models.length === 0) {
    return renderErr("Select at least one allowed model (or '*')")
  }
  const allowedModels = explicit ? models : ["*"]

  const rateLimitOverride =
    parseIntOrNull(body["rate_limit_override"] as string | undefined)
    ?? undefined
  const debugEnabled = body["debug_enabled"] === "1"

  // Server-side gate: debug requires explicit confirmation token, not just
  // the checkbox value. The frontend modal sets debug_confirm=yes after the
  // operator acknowledges the trace-persistence warning. This makes the gate
  // real (CSP-independent) rather than purely UX.
  if (debugEnabled && body["debug_confirm"] !== "yes") {
    return renderErr(
      "Debug mode requires explicit confirmation. Re-check the box and confirm the modal.",
    )
  }

  try {
    const { plain, row } = createKey({
      tier,
      label,
      allowedModels,
      rateLimitOverride,
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
        allowed_models: allowedModels,
        rate_limit_override: rateLimitOverride ?? null,
        debug_enabled: debugEnabled,
      },
    })

    const flashToken = createFlash(plain, row.id)
    return c.redirect(`/admin/keys/created?flash=${flashToken}`, 303)
  } catch (err) {
    return renderErr(String(err))
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
    // Two reasons we end up here: token already consumed (back/refresh) or
    // process restarted between the POST and this GET. In either case the
    // plaintext is gone forever; surface it visibly rather than silently
    // redirecting.
    return c.html(
      <Layout title="Key Lost" active="keys" csrfToken={session.csrf_token}>
        <div class="form-error">
          <strong>Plaintext no longer available.</strong> The one-time view of
          this key has been consumed or expired (server may have restarted).
          Revoke this key and create a new one if you didn't copy it.{" "}
          <a href="/admin/keys">Back to keys</a>
        </div>
      </Layout>,
      410,
    )
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
  if (!isUuid(id)) return c.text("Key not found", 404)
  const row = findKeyById(id)
  if (!row) return c.text("Key not found", 404)

  const config = getConfig()
  const success = c.req.query("success")

  // Per-key usage summaries over three windows + recent calls (task #26).
  // Pulled with separate queries so each window can use its own ts range
  // (the events table is indexed on (key_id, ts)).
  const DAY = 86_400_000
  const usage24h = usageForKey(id, DAY)
  const usage7d = usageForKey(id, 7 * DAY)
  const usage30d = usageForKey(id, 30 * DAY)
  const recent = recentCallsForKey(id, 20)

  return c.html(
    <Layout title="Key Detail" active="keys" csrfToken={session.csrf_token}>
      <KeyDetail
        row={row}
        csrfToken={session.csrf_token}
        tracesDays={config.retention.traces_days}
        availableAliases={Object.keys(config.models)}
        success={success}
        usage24h={usage24h}
        usage7d={usage7d}
        usage30d={usage30d}
        recent={recent}
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
  if (!isUuid(id)) return c.text("Key not found", 404)
  const row = findKeyById(id)
  if (!row) return c.text("Key not found", 404)

  const changed = revokeKey(id)
  if (changed) {
    safeAudit({
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
  if (!isUuid(id)) return c.text("Key not found", 404)
  const row = findKeyById(id)
  if (!row) return c.text("Key not found", 404)
  if (row.revoked_at !== null) return c.text("Key is revoked", 400)

  // `{ all: true }` so multi-value fields (allowed_models checkboxes) come
  // back as arrays. The session middleware also parses the body (to extract
  // the CSRF token) and Hono caches the parsed result, so we keep both
  // call sites aligned on `{ all: true }` to avoid the cache producing a
  // flattened (single-value) view here.
  const body = await c.req.parseBody({ all: true })
  const { explicit, models } = parseAllowedModels(body)
  const config = getConfig()

  const renderErr = (msg: string, status: 400): Response => {
    const DAY = 86_400_000
    return c.html(
      <Layout title="Key Detail" active="keys" csrfToken={session.csrf_token}>
        <KeyDetail
          row={findKeyById(id) ?? row}
          csrfToken={session.csrf_token}
          tracesDays={config.retention.traces_days}
          availableAliases={Object.keys(config.models)}
          error={msg}
          usage24h={usageForKey(id, DAY)}
          usage7d={usageForKey(id, 7 * DAY)}
          usage30d={usageForKey(id, 30 * DAY)}
          recent={recentCallsForKey(id, 20)}
        />
      </Layout>,
      status,
    )
  }

  if (!explicit) {
    return renderErr("Form did not submit any allowed_models field", 400)
  }
  if (models.length === 0) {
    return renderErr("Select at least one allowed model (or '*')", 400)
  }

  const rateLimitOverride = parseIntOrNull(
    body["rate_limit_override"] as string | undefined,
  )

  try {
    const changed = updateKeyScope(id, models, rateLimitOverride)
    if (changed) {
      safeAudit({
        actor_key_id: session.key_id,
        actor_tier: "admin",
        action: "key.scope_update",
        target: id,
        after: {
          allowed_models: models,
          rate_limit_override: rateLimitOverride,
        },
      })
    }
    return c.redirect(`/admin/keys/${id}?success=scope_updated`, 303)
  } catch (err) {
    return renderErr(String(err), 400)
  }
})

// ---------------------------------------------------------------------------
// POST /admin/keys/:id/debug
//
// Three actions, mutually exclusive:
// - action=renew  → bump debug_expires_at by 24h (debug must already be on)
// - debug_enabled=1 with debug_confirm=yes  → enable + 24h TTL
// - debug_enabled=0  → disable + clear TTL
// ---------------------------------------------------------------------------

keysApp.post("/:id/debug", async (c) => {
  const session = c.get("session")
  const id = c.req.param("id")
  if (!isUuid(id)) return c.text("Key not found", 404)
  const row = findKeyById(id)
  if (!row) return c.text("Key not found", 404)
  if (row.revoked_at !== null) return c.text("Key is revoked", 400)

  const body = await c.req.parseBody()
  const action = body["action"]
  const enabledRaw = body["debug_enabled"]
  const confirm = body["debug_confirm"]

  let auditAction: string
  if (action === "renew") {
    // Refresh TTL: treat as enable (setDebugEnabled(true) bumps TTL).
    setDebugEnabled(id, true)
    auditAction = "key.debug_renew"
  } else if (enabledRaw === "1" || enabledRaw === "true") {
    // Enabling requires explicit confirmation token from the modal.
    if (confirm !== "yes") {
      return c.text(
        "Debug enable requires explicit confirmation (debug_confirm=yes)",
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

  return c.redirect(`/admin/keys/${id}?success=debug_updated`, 303)
})

export { keysApp }
