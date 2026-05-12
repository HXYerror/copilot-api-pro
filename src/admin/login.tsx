import { Hono } from "hono"
/** @jsxImportSource hono/jsx */
import crypto from "node:crypto"

import { getDb } from "~/lib/db"
import { findKeyByHash } from "~/services/keys"

import { csrfCookieValue, generateCsrfToken } from "./csrf"
import { ADMIN_SECURITY_HEADERS, LoginLayout } from "./layout"
import { createSession, sessionCookieValue } from "./session"

// ---------------------------------------------------------------------------
// Login app
// ---------------------------------------------------------------------------

const loginApp = new Hono()

// Apply security headers to all login responses
loginApp.use("*", async (c, next) => {
  await next()
  for (const [k, v] of Object.entries(ADMIN_SECURITY_HEADERS)) {
    c.header(k, v)
  }
})

// ---------------------------------------------------------------------------
// GET /admin/login
// ---------------------------------------------------------------------------

function errorMessage(error: string | undefined): string | undefined {
  if (error === "invalid")
    return "Invalid or insufficient key. Admin keys only."
  if (error === "missing") return "Please enter your admin API key."
  return undefined
}

loginApp.get("/", (c) => {
  const errorMsg = errorMessage(c.req.query("error"))

  return c.html(
    <LoginLayout>
      <div class="login-card">
        <h1>Admin Login</h1>
        <p class="login-hint">Paste an admin-tier API key to continue.</p>
        {errorMsg && <p class="login-error">{errorMsg}</p>}
        <form method="post" action="/admin/login">
          <label for="key">API Key</label>
          <input
            id="key"
            type="password"
            name="key"
            placeholder="sk-cap-…"
            autocomplete="current-password"
            required
          />
          <button type="submit">Login</button>
        </form>
      </div>
    </LoginLayout>,
  )
})

// ---------------------------------------------------------------------------
// POST /admin/login
// ---------------------------------------------------------------------------

loginApp.post("/", async (c) => {
  const body = await c.req.parseBody()
  const key = typeof body["key"] === "string" ? body["key"].trim() : ""

  if (!key) {
    return c.redirect("/admin/login?error=missing", 303)
  }

  // Hash and look up the key
  const hash = crypto.createHash("sha256").update(key).digest("hex")
  const keyRecord = findKeyByHash(hash)

  if (
    !keyRecord
    || keyRecord.revoked_at !== null
    || keyRecord.tier !== "admin"
  ) {
    return c.redirect("/admin/login?error=invalid", 303)
  }

  // Invalidate any existing sessions for this key before creating a new one.
  // This ensures stolen sessions cannot outlive a legitimate re-login and
  // enforces "one active session per key" semantics.
  getDb().run("DELETE FROM sessions WHERE key_id = ?", [keyRecord.id])

  // Create session
  const session = createSession(keyRecord.id)
  const csrfToken = generateCsrfToken(session.id)

  // Set session + CSRF cookies
  const headers = new Headers()
  headers.append("Set-Cookie", sessionCookieValue(session.id))
  headers.append("Set-Cookie", csrfCookieValue(csrfToken))
  headers.set("Location", "/admin")

  return new Response(null, { status: 303, headers })
})

export { loginApp }
