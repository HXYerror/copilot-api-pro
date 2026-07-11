import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"
import crypto from "node:crypto"

import type { KeyRow } from "~/services/keys"

import { getConfig } from "~/lib/config-store"
import { HTTPError } from "~/lib/error"
import { checkKeyRateLimit } from "~/lib/rate-limit"
import { audit } from "~/services/audit"
import { findKeyByHash } from "~/services/keys"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KeyVar = {
  key: KeyRow
  /**
   * Set by authMiddleware when the request arrived with `X-Capi-Debug: 1`
   * AND the resolved key is admin-tier. The header itself is always
   * stripped (so it never reaches upstream); downstream middleware (e.g.
   * the trace capture in middleware/trace.ts) must read this flag instead.
   */
  debug_via_header?: boolean
}

// Regex for full sk-cap- token format: prefix + 52 base32 uppercase chars
const SK_CAP_RE = /^sk-cap-[A-Z2-7]{52}$/

// ---------------------------------------------------------------------------
// Sentinel key for --no-auth mode
// ---------------------------------------------------------------------------

const NO_AUTH_SENTINEL: KeyRow = {
  id: "__noauth__",
  hash: "",
  tier: "admin",
  label: null,
  allowed_models: '["*"]',
  rate_limit_override: null,
  // Sentinel is NOT a real key — it can't toggle per-key debug. Capture
  // in --no-auth mode is decided by the global `features.debug` toggle
  // in Settings → Advanced. captureLevel() checks that gate first, so
  // operators can opt in / out at the global level.
  debug_enabled: 0,
  debug_expires_at: null,
  created_at: 0,
  revoked_at: null,
}

// ---------------------------------------------------------------------------
// Startup warning
// ---------------------------------------------------------------------------

let _noAuthWarnedOnce = false

/**
 * Emit a startup warning when auth is disabled.
 * Safe to call unconditionally — reads the config and skips if auth is enabled.
 * Idempotent (only warns once per process lifetime).
 */
export function warnNoAuth(): void {
  if (_noAuthWarnedOnce || getConfig().features.auth) return
  _noAuthWarnedOnce = true
  consola.warn(
    "\x1B[33m[auth] --no-auth mode: authentication is DISABLED. All requests are accepted as admin.\x1B[0m",
  )
}

/** Test-only reset so each test gets a fresh warned state. */
export function _resetNoAuthWarned_TEST_ONLY(): void {
  _noAuthWarnedOnce = false
}

// ---------------------------------------------------------------------------
// requireAdmin middleware
// ---------------------------------------------------------------------------

/**
 * Hono middleware that enforces admin tier.
 * Mount on any route group that requires admin access.
 * Usage: `adminRoutes.use("*", requireAdminMiddleware)`
 */
export const requireAdminMiddleware: MiddlewareHandler<{
  Variables: KeyVar
}> = async (c, next) => {
  const key = c.get("key")
  if (key.tier !== "admin") {
    return c.json(
      {
        error: {
          message: "Admin tier required",
          type: "permission_denied",
          code: "permission_denied",
        },
      },
      403,
    )
  }
  await next()
}

/**
 * Helper for one-off admin checks in route handlers.
 * Returns a 403 Response if the caller is not admin, null otherwise.
 * Callers MUST check the return value and return it from the handler.
 */
export function requireAdmin(
  c: Context<{ Variables: KeyVar }>,
): Response | null {
  const key = c.get("key")
  if (key.tier !== "admin") {
    return Response.json(
      {
        error: {
          message: "Admin tier required",
          type: "permission_denied",
          code: "permission_denied",
        },
      },
      { status: 403 },
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// isModelAllowed
// ---------------------------------------------------------------------------

export function isModelAllowed(
  allowedModelsJson: string,
  model: string,
): boolean {
  let models: unknown
  try {
    models = JSON.parse(allowedModelsJson)
  } catch {
    consola.error(
      `[auth] Failed to parse allowed_models JSON: ${allowedModelsJson}`,
    )
    return false
  }
  if (!Array.isArray(models)) {
    consola.error(
      `[auth] allowed_models is not an array: ${JSON.stringify(models)}`,
    )
    return false
  }
  return models.some(
    (m): m is string => typeof m === "string" && (m === "*" || m === model),
  )
}

// ---------------------------------------------------------------------------
// Auth middleware helpers
// ---------------------------------------------------------------------------

const AUTH_401_HEADERS = { "WWW-Authenticate": 'Bearer realm="copilot-api"' }

type HonoCtx = Parameters<MiddlewareHandler<{ Variables: KeyVar }>>[0]

function auditReject(c: HonoCtx, hashPrefix?: string): void {
  audit({
    actor_key_id: "__noauth__",
    actor_tier: "system",
    action: "auth.reject",
    ...(hashPrefix !== undefined && { target: hashPrefix }),
    ip: c.req.header("x-forwarded-for"),
    user_agent: c.req.header("user-agent"),
  })
}

function rejectJson(c: HonoCtx, message: string): ReturnType<HonoCtx["json"]> {
  return c.json(
    { error: { message, type: "invalid_api_key", code: "invalid_api_key" } },
    401,
    AUTH_401_HEADERS,
  )
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

export const authMiddleware: MiddlewareHandler<{ Variables: KeyVar }> = async (
  c,
  next,
) => {
  // Strip sensitive client headers BEFORE any branching.
  // Note: Bun allows .delete() on server Request.headers (non-spec extension).
  // copilotHeaders() always builds its own Headers from state.copilotToken so
  // the client's Authorization is never forwarded upstream regardless.
  c.req.raw.headers.delete("x-api-key")
  c.req.raw.headers.delete("cookie")

  if (!getConfig().features.auth) {
    c.set("key", NO_AUTH_SENTINEL)
    await next()
    return
  }

  const authHeader = c.req.header("Authorization")
  if (!authHeader) {
    auditReject(c)
    return rejectJson(c, "Missing Authorization header")
  }

  // Case-insensitive scheme extraction per RFC 7235 §2
  const bearer =
    authHeader.toLowerCase().startsWith("bearer ") ?
      authHeader.slice(7)
    : authHeader
  c.req.raw.headers.delete("authorization")

  if (!SK_CAP_RE.test(bearer)) {
    const hint =
      bearer.startsWith("sk-cap-") ?
        "Malformed sk-cap-* key (expected sk-cap- + 52 uppercase base32 chars)"
      : "this proxy does not forward your GitHub token; use a sk-cap-* key issued by this server"
    consola.warn("[auth] Rejected request: invalid bearer token format")
    const prefix = crypto
      .createHash("sha256")
      .update(bearer)
      .digest("hex")
      .slice(0, 8)
    auditReject(c, prefix)
    return rejectJson(c, hint)
  }

  const hash = crypto.createHash("sha256").update(bearer).digest("hex")
  const keyRecord = findKeyByHash(hash)

  if (!keyRecord || keyRecord.revoked_at !== null) {
    consola.warn("[auth] Rejected request: key not found or revoked")
    auditReject(c, hash.slice(0, 8))
    return rejectJson(c, "Invalid API key")
  }

  // Strip X-Capi-Debug unconditionally; only honor for admin-tier keys via context
  const debugHeader = c.req.header("x-capi-debug")
  c.req.raw.headers.delete("x-capi-debug")
  if (debugHeader !== undefined && keyRecord.tier !== "admin") {
    consola.warn("[auth] Stripped X-Capi-Debug from client-tier request")
  }
  // Surface the admin-tier debug-toggle via context so downstream middleware
  // (trace.ts) can opt in to capture WITHOUT relying on the header (which
  // we've already deleted to avoid leaking the bit upstream).
  if (debugHeader === "1" && keyRecord.tier === "admin") {
    c.set("debug_via_header", true)
  }

  try {
    checkKeyRateLimit(keyRecord.id, keyRecord.rate_limit_override)
  } catch (err) {
    if (err instanceof HTTPError) {
      return new Response(err.response.body, {
        status: err.response.status,
        headers: err.response.headers,
      })
    }
    throw err
  }

  c.set("key", keyRecord)
  await next()
}
