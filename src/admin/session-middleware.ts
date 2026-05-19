/**
 * Session middleware for the /admin/* routes and logout endpoint.
 *
 * Responsibilities:
 * 1. Validate the `sid` cookie on every /admin request (except /admin/login).
 * 2. Enforce HTTPS-or-loopback: refuse plain HTTP from non-loopback addresses.
 * 3. CSRF check on every state-changing (non-GET/HEAD) request.
 * 4. Expose the resolved session on the Hono context (`c.get("session")`).
 * 5. Provide the POST /admin/session/logout endpoint.
 */

import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"
import { Hono } from "hono"
import crypto from "node:crypto"

import { CSRF_HEADER, extractCsrfCookie, verifyCsrfToken } from "./csrf"
import {
  clearSessionCookieValue,
  deleteSession,
  extractSessionId,
  getSession,
  sessionCookieValue,
  type SessionRow,
} from "./session"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionVar = { session: SessionRow }

// ---------------------------------------------------------------------------
// HTTPS / loopback guard
// ---------------------------------------------------------------------------

const LOOPBACK_RE = /^(?:127\.\d+\.\d+\.\d+|::1|localhost)$/

/**
 * Constant-time string equality. Used to compare CSRF tokens against the
 * canonical value stored in the sessions table so a server restart doesn't
 * force users to re-login (the HMAC secret changes across processes but
 * the DB token does not).
 */
function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

function stripBracketsAndPort(host: string): string {
  // IPv6 addresses in Host headers arrive as [::1] or [::1]:port
  const ipv6Match = /^\[([^\]]+)\](?::\d+)?$/.exec(host)
  if (ipv6Match) return ipv6Match[1]
  // IPv4 / hostname with optional :port
  const colonIdx = host.lastIndexOf(":")
  return colonIdx === -1 ? host : host.slice(0, colonIdx)
}

function isLoopback(hostOrHostname: string): boolean {
  // WHATWG URL.hostname preserves brackets for IPv6: [::1] → strip them
  const bare = hostOrHostname.replaceAll(/^\[|\]$/g, "")
  return LOOPBACK_RE.test(bare)
}

/**
 * Returns true when the request is safe to serve:
 * - over HTTPS (regardless of host), or
 * - over HTTP but only from a loopback address, or
 * - the operator has explicitly opted into plain HTTP via the
 *   `ADMIN_INSECURE_HTTP=true` env var (LAN-only convenience for
 *   self-hosted setups behind a trusted network — session cookies travel
 *   in the clear and CAN be sniffed; never expose to the open internet).
 *
 * X-Forwarded-Proto is only consulted when the TRUST_PROXY env var is set to
 * "true". Without that flag, any client could forge the header and bypass the
 * HTTPS requirement.
 */
export function isRequestAllowed(c: Context): boolean {
  // Operator-acknowledged plain-HTTP bypass. Documented in start.ts banner.
  if (process.env.ADMIN_INSECURE_HTTP === "true") return true

  const trustProxy = process.env.TRUST_PROXY === "true"
  const proto = c.req.header("x-forwarded-proto") ?? ""
  const host = c.req.header("host") ?? ""
  const url = new URL(c.req.url)

  // HTTPS check: only trust X-Forwarded-Proto behind a known proxy
  const isHttps = (trustProxy && proto === "https") || url.protocol === "https:"
  if (isHttps) return true

  // Plain HTTP — only allow loopback addresses
  const hostNoPort = stripBracketsAndPort(host)
  return isLoopback(hostNoPort) || isLoopback(url.hostname)
}

// ---------------------------------------------------------------------------
// Session middleware (applied to all protected /admin/* routes)
// ---------------------------------------------------------------------------

export const sessionMiddleware: MiddlewareHandler<{
  Variables: SessionVar
}> = async (c, next) => {
  // Enforce HTTPS-or-loopback
  if (!isRequestAllowed(c)) {
    return c.text("HTTPS required for non-loopback access", 403)
  }

  const cookieHeader = c.req.header("cookie")
  const sessionId = extractSessionId(cookieHeader)

  // /admin/api/* is the JSON surface consumed by the React SPA. Returning an
  // HTML redirect when a session is missing would be useless to the client —
  // serve a 401 JSON instead so the SPA's fetch wrapper can bounce the user
  // to /admin/login itself. Pages outside /api still get the HTML redirect.
  const isJsonApi = c.req.path.startsWith("/admin/api/")

  if (!sessionId) {
    if (isJsonApi) {
      return c.json({ error: "Not authenticated" }, 401)
    }
    return c.redirect("/admin/login", 302)
  }

  // CSRF check on state-changing methods BEFORE the DB session lookup.
  // This prevents an attacker with a stolen sid from repeatedly causing DB
  // writes (expiry slide) while probing CSRF validity.
  const method = c.req.method.toUpperCase()
  if (method !== "GET" && method !== "HEAD") {
    const fetchSite = c.req.header("sec-fetch-site")
    const tokenHeader = c.req.header(CSRF_HEADER)
    const tokenCookie = extractCsrfCookie(cookieHeader)

    // Sec-Fetch-Site is defense-in-depth on top of the HMAC double-submit
    // CSRF token check below (which is the actual cryptographic guarantee).
    // We require `same-origin` by default; some older browsers and
    // ADMIN_INSECURE_HTTP=true LAN deployments don't always emit the header,
    // so we skip the strict check when the bypass is set OR the request
    // already includes a valid CSRF token pair (verified below).
    const insecureBypass = process.env.ADMIN_INSECURE_HTTP === "true"
    if (!insecureBypass && fetchSite !== "same-origin") {
      consola.warn("[admin] CSRF: Sec-Fetch-Site must be same-origin")
      return c.json({ error: "CSRF: Sec-Fetch-Site must be same-origin" }, 403)
    }

    // Accept CSRF token from either header (AJAX) or form body field (HTML form)
    const tokenBody = await extractCsrfBody(c)
    const effectiveToken = tokenHeader ?? tokenBody

    if (!effectiveToken || !tokenCookie) {
      consola.warn("[admin] CSRF: missing token")
      return c.json({ error: "CSRF: missing token" }, 403)
    }
    // Verify against the HMAC of the session id with our in-process secret.
    // This works as long as the server hasn't restarted since the session
    // was created. After a restart, the secret regenerates and HMAC fails —
    // so we ALSO accept the canonical csrf_token stored in the sessions
    // table (which was written at login with the secret of THAT process
    // and survives restarts). This way restarts no longer force users to
    // re-login: the sessions row is the source of truth.
    const sessionRow = getSession(sessionId)
    const dbToken = sessionRow?.csrf_token
    const matchesHmac =
      verifyCsrfToken(sessionId, effectiveToken)
      && verifyCsrfToken(sessionId, tokenCookie)
    const matchesDb =
      dbToken !== undefined
      && constantTimeEq(effectiveToken, dbToken)
      && constantTimeEq(tokenCookie, dbToken)
    if (!matchesHmac && !matchesDb) {
      consola.warn("[admin] CSRF: token mismatch")
      return c.json({ error: "CSRF: token mismatch" }, 403)
    }
  }

  const session = getSession(sessionId)
  if (!session) {
    // Session expired or not found — clear cookie and redirect (or 401 JSON
    // for the /admin/api/* surface — see comment above).
    const headers = new Headers()
    headers.set("Set-Cookie", clearSessionCookieValue())
    if (isJsonApi) {
      headers.set("Content-Type", "application/json")
      return new Response(JSON.stringify({ error: "Session expired" }), {
        status: 401,
        headers,
      })
    }
    headers.set("Location", "/admin/login")
    return new Response(null, { status: 302, headers })
  }

  c.set("session", session)
  await next()

  // Refresh the session cookie Max-Age on every authenticated response so
  // the browser's sliding window stays in sync with the server-side expiry.
  c.res.headers.append("Set-Cookie", sessionCookieValue(session.id))
}

/**
 * Defense-in-depth guard: re-verify the underlying key is still admin-tier
 * and not revoked, on every request to a session-protected admin route.
 *
 * The login flow already rejects non-admin keys (src/admin/login.tsx), so the
 * only way to obtain a session is to authenticate as admin.  This middleware
 * protects against a regression in that flow, AND against the case where the
 * key is revoked after the session is created (in which case the session
 * must be terminated and the user redirected to login).
 */
export const requireAdminSession: MiddlewareHandler<{
  Variables: SessionVar
}> = async (c, next) => {
  const session = c.get("session")
  // Lazy require to avoid a cycle with services/keys → lib/db.
  const { findKeyById } = await import("~/services/keys")
  const key = findKeyById(session.key_id)
  if (!key || key.revoked_at !== null || key.tier !== "admin") {
    // The session refers to a key that's no longer trustworthy. Tear the
    // session down and bounce to login so the operator has to re-authenticate.
    // For the JSON API surface, return a 401 instead of an HTML redirect.
    deleteSession(session.id)
    const headers = new Headers()
    headers.set("Set-Cookie", clearSessionCookieValue())
    if (c.req.path.startsWith("/admin/api/")) {
      headers.set("Content-Type", "application/json")
      return new Response(JSON.stringify({ error: "Key revoked" }), {
        status: 401,
        headers,
      })
    }
    headers.set("Location", "/admin/login")
    return new Response(null, { status: 302, headers })
  }
  await next()
}

/** Try to read a CSRF token from an application/x-www-form-urlencoded body.
 *
 * Important: we parse with `{ all: true }` so multi-value form fields
 * (e.g. allowed_models checkboxes) come back as arrays. Hono caches the
 * parsed body on the request object, and the FIRST call's options win — if
 * we used the default (all=false), downstream handlers would see flattened
 * single-value fields no matter what they request later. (See keys/route.tsx
 * scope edit for the affected handler.)
 */
async function extractCsrfBody(c: Context): Promise<string | undefined> {
  const ct = c.req.header("content-type") ?? ""
  if (!ct.includes("application/x-www-form-urlencoded")) return undefined
  try {
    const body = await c.req.parseBody({ all: true })
    const val = body["csrf_token"]
    // With { all: true }, a single-occurrence field is still a string;
    // duplicates become an array. We only ever expect one csrf_token, but
    // defend against both shapes.
    if (typeof val === "string") return val
    if (Array.isArray(val) && typeof val[0] === "string") return val[0]
    return undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Logout route: POST /admin/session/logout
// ---------------------------------------------------------------------------

const sessionApp = new Hono()

sessionApp.post("/logout", (c) => {
  const cookieHeader = c.req.header("cookie")
  const sessionId = extractSessionId(cookieHeader)
  if (sessionId) deleteSession(sessionId)

  const headers = new Headers({ Location: "/admin/login" })
  headers.set("Set-Cookie", clearSessionCookieValue())
  return new Response(null, { status: 303, headers })
})

export { sessionApp }
