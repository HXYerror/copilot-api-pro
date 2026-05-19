import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Config } from "../src/lib/config-store"

import {
  CSRF_COOKIE,
  CSRF_HEADER,
  csrfCookieValue,
  extractCsrfCookie,
  generateCsrfToken,
  verifyCsrfToken,
} from "../src/admin/csrf"
import {
  SESSION_COOKIE,
  SESSION_LIFETIME_MS,
  createSession,
  deleteSession,
  extractSessionId,
  getSession,
  purgeExpiredSessions,
  sessionCookieValue,
} from "../src/admin/session"
import { isRequestAllowed } from "../src/admin/session-middleware"
import { loadConfig, saveConfig } from "../src/lib/config-store"
import { closeDb, getDb, initDb, resetDb } from "../src/lib/db"
import { _resetNoAuthWarned_TEST_ONLY } from "../src/middleware/auth"
import { server } from "../src/server"
import { createKey, findKeyByHash, revokeKey } from "../src/services/keys"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../src/lib/migrations")

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const fetchMock = () =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        object: "list",
        data: [
          {
            id: "gpt-4o",
            name: "GPT-4o",
            vendor: "openai",
            object: "model",
            model_picker_enabled: true,
            preview: false,
            version: "1",
            capabilities: {
              family: "gpt-4",
              object: "model_capabilities",
              tokenizer: "o200k_base",
              type: "chat",
              limits: {},
              supports: {},
            },
          },
        ],
      }),
    text: () => Promise.resolve(""),
    status: 200,
  })

// @ts-expect-error – mock doesn't implement full fetch signature
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "admin-test-"))
}

function makeTmpConfig(
  dir: string,
  override: Partial<Config["features"]> = {},
): string {
  const cfgPath = path.join(dir, "config.json")
  const cfg: Config = {
    version: 1,
    models: {},
    retention: {
      events_days: 90,
      traces_days: 7,
      traces_max_bytes: 104857600,
      audit_days: 365,
    },
    features: { auth: true, telemetry: false, debug: false, ...override },
    default_model_alias: "",
  }
  saveConfig(cfg, cfgPath)
  return cfgPath
}

/** Hash a plain key string the same way auth middleware does */
function hashPlain(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex")
}

/** Build a mock Hono Context for isRequestAllowed tests */
function makeIsAllowedCtx(options: {
  host?: string
  proto?: string
  url?: string
}): Parameters<typeof isRequestAllowed>[0] {
  return {
    req: {
      header: (name: string) => {
        if (name === "x-forwarded-proto") return options.proto
        if (name === "host") return options.host ?? "localhost:4141"
        return undefined
      },
      url: options.url ?? "http://localhost:4141/admin",
    },
  } as unknown as Parameters<typeof isRequestAllowed>[0]
}

/** Safely get all Set-Cookie headers from a Response */
function getSetCookies(res: Response): Array<string> {
  if (
    typeof (res.headers as { getSetCookie?: () => Array<string> }).getSetCookie
    === "function"
  ) {
    return (res.headers as { getSetCookie: () => Array<string> }).getSetCookie()
  }
  const single = res.headers.get("set-cookie")
  return single ? [single] : []
}

// ---------------------------------------------------------------------------
// CSRF unit tests
// ---------------------------------------------------------------------------

describe("CSRF utilities", () => {
  test("generateCsrfToken returns a non-empty string", () => {
    const token = generateCsrfToken("session-id-123")
    expect(typeof token).toBe("string")
    expect(token.length).toBeGreaterThan(0)
  })

  test("verifyCsrfToken returns true for matching token", () => {
    const sessionId = "my-session-id"
    const token = generateCsrfToken(sessionId)
    expect(verifyCsrfToken(sessionId, token)).toBe(true)
  })

  test("verifyCsrfToken returns false for wrong session id", () => {
    const token = generateCsrfToken("session-a")
    expect(verifyCsrfToken("session-b", token)).toBe(false)
  })

  test("verifyCsrfToken returns false for tampered token", () => {
    const sessionId = "session-id"
    const token = generateCsrfToken(sessionId)
    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")
    expect(verifyCsrfToken(sessionId, tampered)).toBe(false)
  })

  test("csrfCookieValue includes cookie name and SameSite=Strict", () => {
    const val = csrfCookieValue("mytoken")
    expect(val).toContain(`${CSRF_COOKIE}=mytoken`)
    expect(val).toContain("SameSite=Strict")
  })

  test("extractCsrfCookie returns the token from cookie string", () => {
    const cookieStr = `other=val; ${CSRF_COOKIE}=abc123; more=x`
    expect(extractCsrfCookie(cookieStr)).toBe("abc123")
  })

  test("extractCsrfCookie returns undefined when cookie missing", () => {
    expect(extractCsrfCookie("other=val")).toBeUndefined()
    expect(extractCsrfCookie(undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Session unit tests (require DB)
// ---------------------------------------------------------------------------

describe("Session management", () => {
  let dir: string
  let cfgPath: string

  beforeEach(async () => {
    _resetNoAuthWarned_TEST_ONLY()
    dir = makeTmpDir()
    initDb(path.join(dir, "test.db"), MIGRATIONS_DIR)
    cfgPath = makeTmpConfig(dir, { auth: true })
    await loadConfig(cfgPath)
  })

  afterEach(async () => {
    try {
      closeDb(getDb())
    } catch {
      /* already closed */
    }
    resetDb()
    fs.rmSync(dir, { recursive: true, force: true })
    await loadConfig(
      path.join(os.tmpdir(), "__nonexistent_admin_reset__.json"),
    ).catch(() => {})
  })

  test("createSession returns a session with correct fields", () => {
    const { plain } = createKey({ tier: "admin" })
    const hash = hashPlain(plain)
    const keyRow = findKeyByHash(hash)
    if (!keyRow) throw new Error("key not found")
    const session = createSession(keyRow.id)
    expect(typeof session.id).toBe("string")
    expect(session.id.length).toBe(64) // 32 bytes hex
    expect(session.key_id).toBe(keyRow.id)
    expect(session.expires_at).toBeGreaterThan(Date.now())
    expect(session.expires_at - session.created_at).toBeCloseTo(
      SESSION_LIFETIME_MS,
      -2,
    )
  })

  test("getSession extends expires_at in the DB (sliding window)", () => {
    const { plain } = createKey({ tier: "admin" })
    const keyRow = findKeyByHash(hashPlain(plain))
    if (!keyRow) throw new Error("key not found")
    const session = createSession(keyRow.id)

    // Manually wind back the expiry
    const earlyExpiry = Date.now() + 60_000 // 1 minute from now
    getDb().run("UPDATE sessions SET expires_at = ? WHERE id = ?", [
      earlyExpiry,
      session.id,
    ])

    const fetched = getSession(session.id)
    expect(fetched).not.toBeNull()
    // The returned expiry should be much greater than earlyExpiry
    expect(fetched?.expires_at).toBeGreaterThan(earlyExpiry + 100_000)
  })

  test("getSession returns null for non-existent session", () => {
    expect(getSession("non-existent-id")).toBeNull()
  })

  test("deleteSession removes the session", () => {
    const { plain } = createKey({ tier: "admin" })
    const keyRow = findKeyByHash(hashPlain(plain))
    if (!keyRow) throw new Error("key not found")
    const session = createSession(keyRow.id)
    deleteSession(session.id)
    expect(getSession(session.id)).toBeNull()
  })

  test("purgeExpiredSessions removes expired sessions only", () => {
    const { plain } = createKey({ tier: "admin" })
    const keyRow = findKeyByHash(hashPlain(plain))
    if (!keyRow) throw new Error("key not found")
    const session = createSession(keyRow.id)
    // Manually expire it
    getDb().run("UPDATE sessions SET expires_at = 1 WHERE id = ?", [session.id])
    purgeExpiredSessions()
    expect(getSession(session.id)).toBeNull()
  })

  test("sessionCookieValue includes HttpOnly, Secure, SameSite=Strict, Path=/admin", () => {
    const val = sessionCookieValue("some-sid")
    expect(val).toContain(`${SESSION_COOKIE}=some-sid`)
    expect(val).toContain("HttpOnly")
    expect(val).toContain("Secure")
    expect(val).toContain("SameSite=Strict")
    expect(val).toContain("Path=/admin")
    expect(val).toContain("Max-Age=")
  })

  test("extractSessionId returns the sid from cookie header", () => {
    const val = `${SESSION_COOKIE}=my-session-id; other=value`
    expect(extractSessionId(val)).toBe("my-session-id")
  })

  test("extractSessionId returns undefined when no sid", () => {
    expect(extractSessionId("other=value")).toBeUndefined()
    expect(extractSessionId(undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// isRequestAllowed unit tests
// ---------------------------------------------------------------------------

describe("isRequestAllowed", () => {
  test("allows localhost HTTP", () => {
    expect(isRequestAllowed(makeIsAllowedCtx({ host: "localhost:4141" }))).toBe(
      true,
    )
  })

  test("allows 127.0.0.1 HTTP", () => {
    expect(isRequestAllowed(makeIsAllowedCtx({ host: "127.0.0.1:4141" }))).toBe(
      true,
    )
  })

  test("allows IPv6 [::1] HTTP", () => {
    expect(
      isRequestAllowed(
        makeIsAllowedCtx({
          host: "[::1]:4141",
          url: "http://[::1]:4141/admin",
        }),
      ),
    ).toBe(true)
  })

  test("allows HTTPS from any host", () => {
    expect(
      isRequestAllowed(
        makeIsAllowedCtx({ host: "example.com", proto: "https" }),
      ),
    ).toBe(true)
  })

  test("blocks plain HTTP from non-loopback", () => {
    expect(
      isRequestAllowed(
        makeIsAllowedCtx({
          host: "1.2.3.4:4141",
          url: "http://1.2.3.4:4141/admin",
        }),
      ),
    ).toBe(false)
  })

  test("ADMIN_INSECURE_HTTP=true allows plain HTTP from non-loopback", () => {
    const prev = process.env.ADMIN_INSECURE_HTTP
    process.env.ADMIN_INSECURE_HTTP = "true"
    try {
      expect(
        isRequestAllowed(
          makeIsAllowedCtx({
            host: "1.2.3.4:4141",
            url: "http://1.2.3.4:4141/admin",
          }),
        ),
      ).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.ADMIN_INSECURE_HTTP
      else process.env.ADMIN_INSECURE_HTTP = prev
    }
  })

  test("ADMIN_INSECURE_HTTP unset still blocks non-loopback HTTP", () => {
    const prev = process.env.ADMIN_INSECURE_HTTP
    delete process.env.ADMIN_INSECURE_HTTP
    try {
      expect(
        isRequestAllowed(
          makeIsAllowedCtx({
            host: "1.2.3.4:4141",
            url: "http://1.2.3.4:4141/admin",
          }),
        ),
      ).toBe(false)
    } finally {
      if (prev !== undefined) process.env.ADMIN_INSECURE_HTTP = prev
    }
  })
})

// ---------------------------------------------------------------------------
// /healthz and /readyz integration tests
// ---------------------------------------------------------------------------

describe("Health probes", () => {
  let dir: string
  let cfgPath: string

  beforeEach(async () => {
    _resetNoAuthWarned_TEST_ONLY()
    dir = makeTmpDir()
    initDb(path.join(dir, "test.db"), MIGRATIONS_DIR)
    cfgPath = makeTmpConfig(dir, { auth: false })
    await loadConfig(cfgPath)
  })

  afterEach(async () => {
    try {
      closeDb(getDb())
    } catch {
      /* already closed */
    }
    resetDb()
    fs.rmSync(dir, { recursive: true, force: true })
    await loadConfig(
      path.join(os.tmpdir(), "__nonexistent_admin_reset__.json"),
    ).catch(() => {})
  })

  test("GET /healthz returns 200 with {status:'ok'}", async () => {
    const res = await server.request("/healthz", { method: "GET" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe("ok")
  })

  test("GET /healthz requires no auth header", async () => {
    const res = await server.request("/healthz", { method: "GET" })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// /admin/login integration tests
// ---------------------------------------------------------------------------

describe("GET /admin/login", () => {
  let dir: string
  let cfgPath: string

  beforeEach(async () => {
    _resetNoAuthWarned_TEST_ONLY()
    dir = makeTmpDir()
    initDb(path.join(dir, "test.db"), MIGRATIONS_DIR)
    cfgPath = makeTmpConfig(dir, { auth: true })
    await loadConfig(cfgPath)
  })

  afterEach(async () => {
    try {
      closeDb(getDb())
    } catch {
      /* already closed */
    }
    resetDb()
    fs.rmSync(dir, { recursive: true, force: true })
    await loadConfig(
      path.join(os.tmpdir(), "__nonexistent_admin_reset__.json"),
    ).catch(() => {})
  })

  test("returns 200 HTML with a login form", async () => {
    const res = await server.request("/admin/login", { method: "GET" })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("<form")
    expect(body).toContain('name="key"')
  })

  test("has CSP header", async () => {
    const res = await server.request("/admin/login", { method: "GET" })
    const csp = res.headers.get("content-security-policy")
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  test("has X-Frame-Options: DENY", async () => {
    const res = await server.request("/admin/login", { method: "GET" })
    expect(res.headers.get("x-frame-options")).toBe("DENY")
  })

  test("POST with missing key redirects to /admin/login?error=missing", async () => {
    const res = await server.request("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "key=",
    })
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toContain("error=missing")
  })

  test("POST with invalid key redirects to /admin/login?error=invalid", async () => {
    const res = await server.request("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "key=sk-cap-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    })
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toContain("error=invalid")
  })

  test("POST login invalidates previous sessions for the same key", async () => {
    const { plain } = createKey({ tier: "admin" })

    // First login
    const loginRes1 = await server.request("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `key=${plain}`,
    })
    const cookies1 = getSetCookies(loginRes1)
    const sid1 = cookies1.find((c) => c.startsWith("sid="))?.split(";")[0] ?? ""
    const sidValue1 = sid1.split("=")[1] ?? ""

    // Verify first session exists
    expect(getSession(sidValue1)).not.toBeNull()

    // Second login (re-login invalidates first session)
    await server.request("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `key=${plain}`,
    })

    // First session must now be gone
    expect(getSession(sidValue1)).toBeNull()
  })

  test("POST with revoked key redirects to /admin/login?error=invalid", async () => {
    const { plain, row } = createKey({ tier: "admin" })
    revokeKey(row.id)
    const res = await server.request("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `key=${plain}`,
    })
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toContain("error=invalid")
  })

  test("POST with client-tier key redirects to /admin/login?error=invalid", async () => {
    const { plain } = createKey({ tier: "client" })
    const res = await server.request("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `key=${plain}`,
    })
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toContain("error=invalid")
  })

  test("POST with valid admin key sets sid cookie with security flags", async () => {
    const { plain } = createKey({ tier: "admin" })
    const res = await server.request("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `key=${plain}`,
    })
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/admin")

    // Collect all Set-Cookie headers
    const cookies = getSetCookies(res)
    const sidCookie = cookies.find((c) => c.startsWith("sid="))
    expect(sidCookie).toBeDefined()
    expect(sidCookie).toContain("HttpOnly")
    expect(sidCookie).toContain("Secure")
    expect(sidCookie).toContain("SameSite=Strict")
    expect(sidCookie).toContain("Path=/admin")

    const csrfCookieHeader = cookies.find((c) =>
      c.startsWith(`${CSRF_COOKIE}=`),
    )
    expect(csrfCookieHeader).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// /admin session-protected routes
// ---------------------------------------------------------------------------

describe("Session-protected /admin routes", () => {
  let dir: string
  let cfgPath: string

  beforeEach(async () => {
    _resetNoAuthWarned_TEST_ONLY()
    dir = makeTmpDir()
    initDb(path.join(dir, "test.db"), MIGRATIONS_DIR)
    cfgPath = makeTmpConfig(dir, { auth: true })
    await loadConfig(cfgPath)
  })

  afterEach(async () => {
    try {
      closeDb(getDb())
    } catch {
      /* already closed */
    }
    resetDb()
    fs.rmSync(dir, { recursive: true, force: true })
    await loadConfig(
      path.join(os.tmpdir(), "__nonexistent_admin_reset__.json"),
    ).catch(() => {})
  })

  test("GET /admin without session redirects to /admin/login", async () => {
    const res = await server.request("/admin", { method: "GET" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toContain("/admin/login")
  })

  test("GET /admin with valid session returns 200 HTML", async () => {
    const { plain } = createKey({ tier: "admin" })
    // Login
    const loginRes = await server.request("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `key=${plain}`,
    })
    const cookies = getSetCookies(loginRes)
    const sidCookie = cookies.find((c) => c.startsWith("sid="))
    const sidValue = sidCookie?.split(";")[0] ?? ""

    // Access /admin with session cookie. The new React SPA shell is served
    // here; previously this was the legacy SSR Overview page. The shell
    // contains the SPA bootstrap script — assert on that. We separately
    // assert against the legacy SSR markup below.
    const res = await server.request("/admin", {
      method: "GET",
      headers: { Cookie: sidValue },
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    // SPA shell loaded — Vite emits a /admin/_app/assets/... module script.
    expect(body).toContain("/admin/_app/")
    expect(body).toContain("Copilot API Admin")

    // Legacy SSR Overview is still available under /admin/legacy during the
    // page-by-page migration. Assert it still works.
    const legacyRes = await server.request("/admin/legacy", {
      method: "GET",
      headers: { Cookie: sidValue },
    })
    expect(legacyRes.status).toBe(200)
    const legacyBody = await legacyRes.text()
    expect(legacyBody).toContain("Overview")
  })

  test("POST /admin/session/logout clears session cookie (CSRF via form body)", async () => {
    const { plain } = createKey({ tier: "admin" })
    const loginRes = await server.request("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `key=${plain}`,
    })
    const cookies = getSetCookies(loginRes)
    const sidCookie = cookies.find((c) => c.startsWith("sid="))
    const sidValue = sidCookie?.split(";")[0] ?? ""
    const csrfCookieStr = cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`))
    const csrfParts = csrfCookieStr?.split(";")[0]?.split("=") ?? []
    const csrfValue = csrfParts.slice(1).join("=")

    const cookieHeader = [sidValue, csrfCookieStr?.split(";")[0]]
      .filter(Boolean)
      .join("; ")

    // Send CSRF token in form body (as an HTML form would)
    const logoutRes = await server.request("/admin/session/logout", {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `csrf_token=${encodeURIComponent(csrfValue)}`,
    })
    expect(logoutRes.status).toBe(303)
    const afterCookies = getSetCookies(logoutRes)
    const clearCookie = afterCookies.find((c) => c.startsWith("sid="))
    expect(clearCookie).toContain("Max-Age=0")
  })

  test("POST /admin/session/logout without CSRF returns 403", async () => {
    const { plain } = createKey({ tier: "admin" })
    const loginRes = await server.request("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `key=${plain}`,
    })
    const cookies = getSetCookies(loginRes)
    const sidValue =
      cookies.find((c) => c.startsWith("sid="))?.split(";")[0] ?? ""

    // No CSRF token at all
    const logoutRes = await server.request("/admin/session/logout", {
      method: "POST",
      headers: {
        Cookie: sidValue,
        "Sec-Fetch-Site": "same-origin",
      },
    })
    expect(logoutRes.status).toBe(403)
  })

  test("POST /admin/session/logout without Sec-Fetch-Site returns 403", async () => {
    const { plain } = createKey({ tier: "admin" })
    const loginRes = await server.request("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `key=${plain}`,
    })
    const cookies = getSetCookies(loginRes)
    const sidCookie = cookies.find((c) => c.startsWith("sid="))
    const sidValue = sidCookie?.split(";")[0] ?? ""
    const csrfCookieStr = cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`))
    const csrfParts = csrfCookieStr?.split(";")[0]?.split("=") ?? []
    const csrfValue = csrfParts.slice(1).join("=")

    const cookieHeader = [sidValue, csrfCookieStr?.split(";")[0]]
      .filter(Boolean)
      .join("; ")

    // Missing Sec-Fetch-Site header
    const logoutRes = await server.request("/admin/session/logout", {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        [CSRF_HEADER]: csrfValue,
      },
    })
    expect(logoutRes.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Snapshot test — rendered HTML structure
// ---------------------------------------------------------------------------

describe("HTML snapshot tests", () => {
  let dir: string
  let cfgPath: string

  beforeEach(async () => {
    _resetNoAuthWarned_TEST_ONLY()
    dir = makeTmpDir()
    initDb(path.join(dir, "test.db"), MIGRATIONS_DIR)
    cfgPath = makeTmpConfig(dir, { auth: true })
    await loadConfig(cfgPath)
  })

  afterEach(async () => {
    try {
      closeDb(getDb())
    } catch {
      /* already closed */
    }
    resetDb()
    fs.rmSync(dir, { recursive: true, force: true })
    await loadConfig(
      path.join(os.tmpdir(), "__nonexistent_admin_reset__.json"),
    ).catch(() => {})
  })

  test("login page contains expected structural elements", async () => {
    const res = await server.request("/admin/login", { method: "GET" })
    const html = await res.text()
    expect(html).toContain("<html")
    expect(html).toContain("Login")
    expect(html).toContain('type="password"')
    expect(html).toContain('name="key"')
    expect(html).toContain('method="post"')
    expect(html).toContain("/admin/assets/style.css")
  })

  test("admin index page contains nav links when authenticated", async () => {
    const { plain } = createKey({ tier: "admin" })
    const loginRes = await server.request("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `key=${plain}`,
    })
    const cookies = getSetCookies(loginRes)
    const sidValue =
      cookies.find((c) => c.startsWith("sid="))?.split(";")[0] ?? ""

    // The /admin shell is now the React SPA — nav links live inside the
    // bundled JS, not the initial HTML. Assert the legacy SSR view (kept
    // available at /admin/legacy during migration) still renders the nav.
    const res = await server.request("/admin/legacy", {
      method: "GET",
      headers: { Cookie: sidValue },
    })
    const html = await res.text()
    expect(html).toContain("Keys")
    expect(html).toContain("Audit")
    expect(html).toContain("Logout")
  })
})
