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
 * - over HTTP but only from a loopback address.
 *
 * X-Forwarded-Proto is only consulted when the TRUST_PROXY env var is set to
 * "true". Without that flag, any client could forge the header and bypass the
 * HTTPS requirement.
 */
export function isRequestAllowed(c: Context): boolean {
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

  if (!sessionId) {
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

    if (fetchSite !== "same-origin") {
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
    if (
      !verifyCsrfToken(sessionId, effectiveToken)
      || !verifyCsrfToken(sessionId, tokenCookie)
    ) {
      consola.warn("[admin] CSRF: token mismatch")
      return c.json({ error: "CSRF: token mismatch" }, 403)
    }
  }

  const session = getSession(sessionId)
  if (!session) {
    // Session expired or not found — clear cookie and redirect
    const headers = new Headers({ Location: "/admin/login" })
    headers.set("Set-Cookie", clearSessionCookieValue())
    return new Response(null, { status: 302, headers })
  }

  c.set("session", session)
  await next()

  // Refresh the session cookie Max-Age on every authenticated response so
  // the browser's sliding window stays in sync with the server-side expiry.
  c.res.headers.append("Set-Cookie", sessionCookieValue(session.id))
}

/** Try to read a CSRF token from an application/x-www-form-urlencoded body. */
async function extractCsrfBody(c: Context): Promise<string | undefined> {
  const ct = c.req.header("content-type") ?? ""
  if (!ct.includes("application/x-www-form-urlencoded")) return undefined
  try {
    const body = await c.req.parseBody()
    const val = body["csrf_token"]
    return typeof val === "string" ? val : undefined
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
