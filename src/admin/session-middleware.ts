/**
 * Session middleware for the /admin/* routes and logout endpoint.
 *
 * Responsibilities:
 * 1. Validate the `sid` cookie on every /admin request (except /admin/login).
 * 2. Enforce HTTPS-or-loopback: refuse plain HTTP from non-loopback addresses.
 * 3. CSRF check on every state-changing (non-GET/HEAD) request.
 * 4. Expose the resolved session on the Hono context (`c.get("session")`).
 * 5. Provide the DELETE /admin/session/logout endpoint.
 */

/** @jsxImportSource hono/jsx */
import type { Context, MiddlewareHandler } from "hono"

import { Hono } from "hono"

import { CSRF_HEADER, extractCsrfCookie, verifyCsrfToken } from "./csrf"
import {
  clearSessionCookieValue,
  deleteSession,
  extractSessionId,
  getSession,
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

function isLoopback(host: string): boolean {
  const colonIdx = host.lastIndexOf(":")
  const hostname = colonIdx === -1 ? host : host.slice(0, colonIdx)
  return LOOPBACK_RE.test(hostname)
}

/**
 * Returns true when the request is safe to serve:
 * - over HTTPS (regardless of host), or
 * - over HTTP but only from a loopback address.
 */
export function isRequestAllowed(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto") ?? ""
  const host = c.req.header("host") ?? ""
  const url = new URL(c.req.url)

  const isHttps = proto === "https" || url.protocol === "https:"
  if (isHttps) return true

  // Plain HTTP — only allow if the request is from loopback
  return isLoopback(host) || isLoopback(url.hostname)
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

  const session = getSession(sessionId)
  if (!session) {
    // Session expired or not found — clear cookie and redirect
    const headers = new Headers({ Location: "/admin/login" })
    headers.set("Set-Cookie", clearSessionCookieValue())
    return new Response(null, { status: 302, headers })
  }

  // CSRF check on state-changing methods
  const method = c.req.method.toUpperCase()
  if (method !== "GET" && method !== "HEAD") {
    const fetchSite = c.req.header("sec-fetch-site")
    const tokenHeader = c.req.header(CSRF_HEADER)
    const tokenCookie = extractCsrfCookie(cookieHeader)

    if (fetchSite !== "same-origin") {
      return c.json({ error: "CSRF: Sec-Fetch-Site must be same-origin" }, 403)
    }
    if (!tokenHeader || !tokenCookie) {
      return c.json({ error: "CSRF: missing token" }, 403)
    }
    if (
      !verifyCsrfToken(session.id, tokenHeader)
      || !verifyCsrfToken(session.id, tokenCookie)
    ) {
      return c.json({ error: "CSRF: token mismatch" }, 403)
    }
  }

  c.set("session", session)
  await next()
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
