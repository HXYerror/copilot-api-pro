import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"
import crypto from "node:crypto"

import type { KeyRow } from "~/services/keys"

import { getConfig } from "~/lib/config-store"
import { HTTPError } from "~/lib/error"
import { checkKeyRateLimit } from "~/lib/rate-limit"
import { findKeyByHash } from "~/services/keys"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KeyVar = { key: KeyRow }

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
  debug_enabled: 0,
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
// Auth middleware
// ---------------------------------------------------------------------------

export const authMiddleware: MiddlewareHandler<{ Variables: KeyVar }> = async (
  c,
  next,
) => {
  // Strip sensitive client headers BEFORE any branching so they are never
  // forwarded upstream in no-auth mode or after auth passes.
  //
  // Note: Bun's Fetch API uses a "request" guard that allows .delete() on
  // server-side Request.headers. This is a Bun extension (not guaranteed by
  // the Fetch spec) — tracked at https://github.com/oven-sh/bun/issues/XXXX.
  // Downstream copilotHeaders() builds its own outbound Headers from
  // state.copilotToken, so even if delete() were a no-op, the client's
  // Authorization would not be used for the upstream call.
  c.req.raw.headers.delete("x-api-key")
  c.req.raw.headers.delete("cookie")

  const config = getConfig()

  // --no-auth short-circuit
  if (!config.features.auth) {
    c.set("key", NO_AUTH_SENTINEL)
    await next()
    return
  }

  const authHeader = c.req.header("Authorization")

  if (!authHeader) {
    return c.json(
      {
        error: {
          message: "Missing Authorization header",
          type: "invalid_api_key",
          code: "invalid_api_key",
        },
      },
      401,
      { "WWW-Authenticate": 'Bearer realm="copilot-api"' },
    )
  }

  // Extract bearer token — case-insensitive scheme per RFC 7235 §2
  const lower = authHeader.toLowerCase()
  const bearer = lower.startsWith("bearer ") ? authHeader.slice(7) : authHeader

  // Strip the Authorization header from the raw request after extraction
  c.req.raw.headers.delete("authorization")

  // Validate full sk-cap- token format before hashing
  if (!SK_CAP_RE.test(bearer)) {
    const hint =
      bearer.startsWith("sk-cap-") ?
        "Malformed sk-cap-* key (expected sk-cap- + 52 uppercase base32 chars)"
      : "this proxy does not forward your GitHub token; use a sk-cap-* key issued by this server"
    consola.warn("[auth] Rejected request: invalid bearer token format")
    return c.json(
      {
        error: {
          message: hint,
          type: "invalid_api_key",
          code: "invalid_api_key",
        },
      },
      401,
      { "WWW-Authenticate": 'Bearer realm="copilot-api"' },
    )
  }

  // Hash and look up
  const hash = crypto.createHash("sha256").update(bearer).digest("hex")
  const keyRecord = findKeyByHash(hash)

  if (!keyRecord || keyRecord.revoked_at !== null) {
    consola.warn("[auth] Rejected request: key not found or revoked")
    return c.json(
      {
        error: {
          message: "Invalid API key",
          type: "invalid_api_key",
          code: "invalid_api_key",
        },
      },
      401,
      { "WWW-Authenticate": 'Bearer realm="copilot-api"' },
    )
  }

  // X-Capi-Debug header: strip from raw request unconditionally so it is
  // never forwarded to GitHub. Honour it only for admin-tier keys via context.
  const debugHeader = c.req.header("x-capi-debug")
  c.req.raw.headers.delete("x-capi-debug")
  if (debugHeader !== undefined && keyRecord.tier !== "admin") {
    consola.warn("[auth] Stripped X-Capi-Debug from client-tier request")
  }

  // Per-key rate limit check — checkKeyRateLimit throws HTTPError on breach
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
