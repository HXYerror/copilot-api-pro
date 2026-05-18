/**
 * POST /admin/api/logout — JSON-friendly logout for the SPA.
 *
 * The legacy HTML form posts to /admin/session/logout and follows a 303 to
 * /admin/login. The SPA wants a JSON ack so it can clear its query cache
 * and then navigate via window.location. Same underlying session.delete +
 * cookie clear — just a different response shape.
 */

import { Hono } from "hono"

import {
  clearSessionCookieValue,
  deleteSession,
  extractSessionId,
} from "../session"

import type { SessionVar } from "../session-middleware"

export const logoutRoute = new Hono<{ Variables: SessionVar }>()

logoutRoute.post("/", (c) => {
  const cookieHeader = c.req.header("cookie")
  const sessionId = extractSessionId(cookieHeader)
  if (sessionId) deleteSession(sessionId)

  // Clear both cookies. The csrf cookie has no clearer helper today so we
  // emit a manual one with Max-Age=0 — same Path / Secure / SameSite as the
  // login flow so the browser actually wipes it. The browser matches on
  // (name, path); the other attributes just have to be set-compatible.
  // Match the Secure flag used at login so the wipe targets the actual cookie
  // (ADMIN_INSECURE_HTTP-mode cookies aren't Secure; a "Secure"-flagged clear
  // wouldn't match them on plain-HTTP).
  const secure = process.env.ADMIN_INSECURE_HTTP === "true" ? "" : "; Secure"
  const headers = new Headers({ "Content-Type": "application/json" })
  headers.append("Set-Cookie", clearSessionCookieValue())
  headers.append(
    "Set-Cookie",
    `csrf=; Path=/admin; Max-Age=0; SameSite=Strict${secure}`,
  )

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
})
