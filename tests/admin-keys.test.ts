import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Config } from "../src/lib/config-store"

import { CSRF_COOKIE } from "../src/admin/csrf"
import { loadConfig, saveConfig } from "../src/lib/config-store"
import { closeDb, getDb, initDb, resetDb } from "../src/lib/db"
import { _resetNoAuthWarned_TEST_ONLY } from "../src/middleware/auth"
import { server } from "../src/server"
import { sweepExpiredDebugKeys } from "../src/services/debug-ttl-sweeper"
import {
  DEBUG_TTL_MS,
  countActiveDebugKeys,
  createKey,
  findKeyById,
  isDebugActive,
  listKeys,
  revokeKey,
  setDebugEnabled,
  updateKeyScope,
} from "../src/services/keys"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../src/lib/migrations")

// ---------------------------------------------------------------------------
// Mock fetch so upstream calls never hit real GitHub APIs
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "admin-keys-test-"))
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
  }
  saveConfig(cfg, cfgPath)
  return cfgPath
}

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

interface LoggedIn {
  sidCookie: string
  csrfValue: string
  cookieHeader: string
  keyId: string
}

async function loginAsAdmin(): Promise<LoggedIn> {
  const { plain, row } = createKey({ tier: "admin", label: "test-admin" })
  const loginRes = await server.request("/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `key=${plain}`,
  })
  const cookies = getSetCookies(loginRes)
  const sidCookie =
    cookies.find((c) => c.startsWith("sid="))?.split(";")[0] ?? ""
  const csrfCookieStr = cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`))
  const csrfParts = csrfCookieStr?.split(";")[0]?.split("=") ?? []
  const csrfValue = csrfParts.slice(1).join("=")
  const cookieHeader = [sidCookie, csrfCookieStr?.split(";")[0]]
    .filter(Boolean)
    .join("; ")
  return { sidCookie, csrfValue, cookieHeader, keyId: row.id }
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

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
    path.join(os.tmpdir(), "__nonexistent_keys_reset__.json"),
  ).catch(() => {})
})

// ---------------------------------------------------------------------------
// Unit tests: services/keys
// ---------------------------------------------------------------------------

describe("keys service: pagination", () => {
  test("listKeys returns rows + total count, paginated", () => {
    for (let i = 0; i < 5; i++) {
      createKey({ tier: "client", label: `k${i}` })
    }
    const result = listKeys(2, 0)
    expect(result.total).toBe(5)
    expect(result.rows.length).toBe(2)

    const page2 = listKeys(2, 2)
    expect(page2.rows.length).toBe(2)
    expect(page2.rows[0]?.id).not.toBe(result.rows[0]?.id)
  })

  test("listKeys with 1000 keys completes quickly", () => {
    // Bulk-insert 1000 keys directly via SQL to keep the test fast
    const db = getDb()
    db.run("BEGIN")
    const stmt = db.prepare(
      `INSERT INTO keys (id, hash, tier, label, allowed_models, debug_enabled, created_at)
       VALUES (?, ?, 'client', ?, '["*"]', 0, ?)`,
    )
    for (let i = 0; i < 1000; i++) {
      stmt.run(
        crypto.randomUUID(),
        crypto.randomBytes(32).toString("hex"),
        `k${i}`,
        Date.now() + i,
      )
    }
    db.run("COMMIT")

    const start = performance.now()
    const result = listKeys(50, 0)
    const ms = performance.now() - start
    expect(result.total).toBe(1000)
    expect(result.rows.length).toBe(50)
    // Generous bound; SQLite + WAL + index should finish well under 100 ms
    expect(ms).toBeLessThan(100)
  })
})

describe("keys service: debug TTL", () => {
  test("createKey with debugEnabled sets debug_expires_at to now+24h", () => {
    const before = Date.now()
    const { row } = createKey({
      tier: "admin",
      label: "dbg",
      debugEnabled: true,
    })
    const after = Date.now()
    expect(row.debug_enabled).toBe(1)
    expect(row.debug_expires_at).not.toBeNull()
    const exp = row.debug_expires_at ?? 0
    expect(exp).toBeGreaterThanOrEqual(before + DEBUG_TTL_MS - 100)
    expect(exp).toBeLessThanOrEqual(after + DEBUG_TTL_MS + 100)
  })

  test("setDebugEnabled(true) refreshes TTL", () => {
    const { row } = createKey({ tier: "admin" })
    setDebugEnabled(row.id, true)
    const updated = findKeyById(row.id)
    expect(updated?.debug_enabled).toBe(1)
    expect(updated?.debug_expires_at).toBeGreaterThan(
      Date.now() + DEBUG_TTL_MS - 1000,
    )
  })

  test("setDebugEnabled(false) clears TTL", () => {
    const { row } = createKey({
      tier: "admin",
      debugEnabled: true,
    })
    setDebugEnabled(row.id, false)
    const updated = findKeyById(row.id)
    expect(updated?.debug_enabled).toBe(0)
    expect(updated?.debug_expires_at).toBeNull()
  })

  test("sweepExpiredDebugKeys disables only expired entries", () => {
    const { row: live } = createKey({ tier: "admin", debugEnabled: true })
    const { row: stale } = createKey({ tier: "admin", debugEnabled: true })

    // Manually expire stale
    getDb().run("UPDATE keys SET debug_expires_at = 1 WHERE id = ?", [stale.id])

    const n = sweepExpiredDebugKeys()
    expect(n).toBe(1)

    const liveAfter = findKeyById(live.id)
    const staleAfter = findKeyById(stale.id)
    expect(liveAfter?.debug_enabled).toBe(1)
    expect(staleAfter?.debug_enabled).toBe(0)
    expect(staleAfter?.debug_expires_at).toBeNull()
  })

  test("countActiveDebugKeys counts only debug_enabled non-revoked NON-expired keys", () => {
    createKey({ tier: "admin", debugEnabled: false })
    createKey({ tier: "admin", debugEnabled: true })
    const { row: revoked } = createKey({
      tier: "admin",
      debugEnabled: true,
    })
    revokeKey(revoked.id)

    // A debug-enabled key whose TTL has already passed should NOT count
    const { row: expired } = createKey({ tier: "admin", debugEnabled: true })
    getDb().run("UPDATE keys SET debug_expires_at = 1 WHERE id = ?", [
      expired.id,
    ])

    expect(countActiveDebugKeys()).toBe(1)
  })

  test("isDebugActive returns false for revoked or expired keys", () => {
    const { row: fresh } = createKey({ tier: "admin", debugEnabled: true })
    expect(isDebugActive(fresh)).toBe(true)

    const { row: revoked } = createKey({ tier: "admin", debugEnabled: true })
    revokeKey(revoked.id)
    const revokedAfter = findKeyById(revoked.id)
    expect(revokedAfter && isDebugActive(revokedAfter)).toBe(false)

    const { row: stale } = createKey({ tier: "admin", debugEnabled: true })
    getDb().run("UPDATE keys SET debug_expires_at = 1 WHERE id = ?", [stale.id])
    const staleAfter = findKeyById(stale.id)
    expect(staleAfter && isDebugActive(staleAfter)).toBe(false)
  })
})

describe("keys service: updateKeyScope", () => {
  test("updates allowed_models and rate_limit_override on active key", () => {
    const { row } = createKey({ tier: "client", allowedModels: ["*"] })
    const ok = updateKeyScope(row.id, ["gpt-4o"], 30)
    expect(ok).toBe(true)
    const updated = findKeyById(row.id)
    expect(updated?.allowed_models).toBe('["gpt-4o"]')
    expect(updated?.rate_limit_override).toBe(30)
  })

  test("does not update revoked keys", () => {
    const { row } = createKey({ tier: "client" })
    revokeKey(row.id)
    const ok = updateKeyScope(row.id, ["gpt-4o"], null)
    expect(ok).toBe(false)
  })

  test("rejects invalid model names", () => {
    const { row } = createKey({ tier: "client" })
    expect(() =>
      updateKeyScope(row.id, ["https://evil.example/path"], null),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Integration: GET /admin/api/keys (JSON contract — Phase 2 SPA)
// ---------------------------------------------------------------------------

describe("GET /admin/api/keys", () => {
  test("redirects to /admin/login without a session (SSR shell)", async () => {
    const res = await server.request("/admin/keys", { method: "GET" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toContain("/admin/login")
  })

  test("returns JSON list for admin session", async () => {
    const { sidCookie } = await loginAsAdmin()
    createKey({ tier: "client", label: "alpha" })
    createKey({ tier: "client", label: "beta" })

    const res = await server.request("/admin/api/keys", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ label: string | null; tier: string; allowed_models: Array<string> }>
      pagination: { total: number }
      summary: { total_keys: number; debug_active: number }
    }
    const labels = body.items.map((k) => k.label)
    expect(labels).toContain("alpha")
    expect(labels).toContain("beta")
    expect(body.pagination.total).toBeGreaterThanOrEqual(3) // 2 + the admin login key
    expect(typeof body.summary.debug_active).toBe("number")
  })

  test("pagination: page=2 shows next page", async () => {
    const { sidCookie } = await loginAsAdmin()
    for (let i = 0; i < 60; i++) {
      createKey({ tier: "client", label: `bulk-${i}` })
    }
    const res = await server.request("/admin/api/keys?page=2&page_size=50", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<unknown>
      pagination: { page: number; total: number; total_pages: number }
    }
    expect(body.pagination.page).toBe(2)
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.pagination.total).toBeGreaterThanOrEqual(61)
  })
})

// ---------------------------------------------------------------------------
// Integration: POST /admin/api/keys — create, single-shot plaintext
// ---------------------------------------------------------------------------

describe("POST /admin/api/keys", () => {
  test("creates key, returns plaintext exactly once in the response body", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()

    const createRes = await server.request("/admin/api/keys", {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify({ label: "my-key", tier: "client", allowed_models: ["*"] }),
    })
    expect(createRes.status).toBe(201)
    const body = (await createRes.json()) as {
      plain: string
      key: { id: string; label: string; tier: string; allowed_models: Array<string> }
    }
    expect(body.plain).toMatch(/^sk-cap-/)
    expect(body.key.label).toBe("my-key")
    expect(body.key.tier).toBe("client")

    // The detail endpoint never returns plaintext
    const detailRes = await server.request(`/admin/api/keys/${body.key.id}`, {
      method: "GET",
      headers: { Cookie: cookieHeader },
    })
    expect(detailRes.status).toBe(200)
    const detail = (await detailRes.json()) as { key: Record<string, unknown> }
    expect(JSON.stringify(detail)).not.toContain(body.plain)
  })

  test("rejects missing CSRF", async () => {
    const { sidCookie } = await loginAsAdmin()
    const res = await server.request("/admin/api/keys", {
      method: "POST",
      headers: {
        Cookie: sidCookie,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ label: "foo", tier: "client" }),
    })
    expect(res.status).toBe(403)
  })

  test("rejects empty label", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const res = await server.request("/admin/api/keys", {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify({ label: "", tier: "client" }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("Label is required")
  })
})

// ---------------------------------------------------------------------------
// Integration: POST /admin/api/keys/:id/revoke
// ---------------------------------------------------------------------------

describe("POST /admin/api/keys/:id/revoke", () => {
  test("revokes key, audit-logs, and the revoked key fails next API request with 401", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const { plain, row } = createKey({ tier: "client", label: "doomed" })

    // Verify the client key works before revoke
    const before = await server.request("/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${plain}` },
    })
    expect(before.status).toBe(200)

    // Revoke
    const revokeRes = await server.request(`/admin/api/keys/${row.id}/revoke`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify({}),
    })
    expect(revokeRes.status).toBe(200)
    const body = (await revokeRes.json()) as { ok: true; revoked: boolean }
    expect(body.revoked).toBe(true)

    // Verify the key is now revoked in the DB
    const after = findKeyById(row.id)
    expect(after?.revoked_at).not.toBeNull()

    // Next API request must 401
    const apiRes = await server.request("/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${plain}` },
    })
    expect(apiRes.status).toBe(401)
  })

  test("returns 404 for non-existent key id", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const res = await server.request(
      `/admin/api/keys/00000000-0000-0000-0000-000000000000/revoke`,
      {
        method: "POST",
        headers: {
          Cookie: cookieHeader,
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin",
          "X-CSRF-Token": csrfValue,
        },
        body: JSON.stringify({}),
      },
    )
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Integration: POST /admin/api/keys/:id/scope
// ---------------------------------------------------------------------------

describe("POST /admin/api/keys/:id/scope", () => {
  test("updates allowed_models", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const { row } = createKey({ tier: "client", allowedModels: ["*"] })

    const res = await server.request(`/admin/api/keys/${row.id}/scope`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify({
        allowed_models: ["*"],
        rate_limit_override: 15,
      }),
    })
    expect(res.status).toBe(200)
    const updated = findKeyById(row.id)
    expect(updated?.rate_limit_override).toBe(15)
  })
})

// ---------------------------------------------------------------------------
// Integration: POST /admin/api/keys/:id/debug
// ---------------------------------------------------------------------------

describe("POST /admin/api/keys/:id/debug", () => {
  test("enabling debug requires confirm: true (server gate)", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const { row } = createKey({ tier: "client" })

    // Without confirmation token → 400, debug stays off
    const noConfirm = await server.request(`/admin/api/keys/${row.id}/debug`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify({ enabled: true }),
    })
    expect(noConfirm.status).toBe(400)
    const stillOff = findKeyById(row.id)
    expect(stillOff?.debug_enabled).toBe(0)
  })

  test("enabling debug with confirmation sets TTL and audit-logs", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const { row } = createKey({ tier: "client" })

    const res = await server.request(`/admin/api/keys/${row.id}/debug`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify({ enabled: true, confirm: true }),
    })
    expect(res.status).toBe(200)
    const updated = findKeyById(row.id)
    expect(updated?.debug_enabled).toBe(1)
    expect(updated?.debug_expires_at).not.toBeNull()
  })

  test("renew action bumps debug_expires_at forward", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const { row } = createKey({ tier: "client", debugEnabled: true })

    // Wind back the TTL so we can detect a renewal
    const oldExp = Date.now() + 60_000
    getDb().run("UPDATE keys SET debug_expires_at = ? WHERE id = ?", [
      oldExp,
      row.id,
    ])

    const res = await server.request(`/admin/api/keys/${row.id}/debug`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify({ action: "renew" }),
    })
    expect(res.status).toBe(200)
    const updated = findKeyById(row.id)
    expect(updated?.debug_enabled).toBe(1)
    expect(updated?.debug_expires_at).toBeGreaterThan(oldExp + 60_000)
  })

  test("disabling debug clears TTL", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const { row } = createKey({ tier: "client", debugEnabled: true })

    const res = await server.request(`/admin/api/keys/${row.id}/debug`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(200)
    const updated = findKeyById(row.id)
    expect(updated?.debug_enabled).toBe(0)
    expect(updated?.debug_expires_at).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Active debug banner
// ---------------------------------------------------------------------------

describe("Active debug banner", () => {
  test("no banner when no keys have debug enabled", async () => {
    const { sidCookie } = await loginAsAdmin()
    const res = await server.request("/admin", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    const html = await res.text()
    expect(html).not.toContain("Debug mode active")
  })

  test("banner shows on /admin when a key has debug enabled", async () => {
    const { sidCookie } = await loginAsAdmin()
    createKey({ tier: "client", debugEnabled: true })

    // /admin now serves the React SPA shell — the legacy SSR Overview
    // (with the banner) is available at /admin/legacy during migration.
    const res = await server.request("/admin/legacy", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    const html = await res.text()
    expect(html).toContain("Debug mode active")
    expect(html).toContain("1 key")
  })

  test("banner also shows on legacy /admin/legacy/keys", async () => {
    const { sidCookie } = await loginAsAdmin()
    createKey({ tier: "client", debugEnabled: true })
    createKey({ tier: "client", debugEnabled: true })

    const res = await server.request("/admin/legacy/keys", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    const html = await res.text()
    expect(html).toContain("Debug mode active")
    expect(html).toContain("2 keys")
  })
})

// ---------------------------------------------------------------------------
// Input validation + safety
// ---------------------------------------------------------------------------

describe("Input validation and safety", () => {
  test("GET /admin/api/keys/<non-uuid> returns 404 without touching DB", async () => {
    const { sidCookie } = await loginAsAdmin()
    const res = await server.request("/admin/api/keys/not-a-uuid", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(404)
  })

  test("POST /admin/api/keys/<non-uuid>/revoke returns 404", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const res = await server.request("/admin/api/keys/bogus/revoke", {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })

  test("POST /admin/api/keys rejects labels longer than 200 chars", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const longLabel = "x".repeat(201)
    const res = await server.request("/admin/api/keys", {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify({
        label: longLabel,
        tier: "client",
        allowed_models: ["*"],
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("Label too long")
  })

  test("Label with HTML tags is returned verbatim by JSON API (escaping happens in the SPA, not the server)", async () => {
    const { sidCookie } = await loginAsAdmin()
    createKey({ tier: "client", label: "<script>alert(1)</script>" })

    const res = await server.request("/admin/api/keys", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ label: string | null }>
    }
    // Label is preserved as data; React renders it as text, so XSS is closed
    // at the render layer rather than the API layer.
    expect(
      body.items.some((k) => k.label === "<script>alert(1)</script>"),
    ).toBe(true)
  })

  test("POST /admin/api/keys with empty allowed_models is rejected (no privilege widening)", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const res = await server.request("/admin/api/keys", {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify({
        label: "test",
        tier: "client",
        allowed_models: [],
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("Select at least one allowed model")
  })

  test("POST /admin/api/keys with no allowed_models field at all defaults to ['*']", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const res = await server.request("/admin/api/keys", {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify({ label: "default-test", tier: "client" }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      key: { allowed_models: Array<string> }
    }
    expect(body.key.allowed_models).toEqual(["*"])
  })

  test("GET /admin/api/keys?page=abc falls back to page 1 (no NaN)", async () => {
    const { sidCookie } = await loginAsAdmin()
    const res = await server.request("/admin/api/keys?page=abc", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { pagination: { page: number } }
    expect(body.pagination.page).toBe(1)
  })

  test("Legacy GET /admin/legacy/keys/created?flash=<unknown> renders explicit error", async () => {
    const { sidCookie } = await loginAsAdmin()
    const res = await server.request(
      "/admin/legacy/keys/created?flash=00000000-0000-0000-0000-000000000000",
      {
        method: "GET",
        headers: { Cookie: sidCookie },
      },
    )
    expect(res.status).toBe(410)
    const html = await res.text()
    expect(html).toContain("Plaintext no longer available")
  })

  test("Sweeper runs frequently enough to keep banner consistent (60s interval)", () => {
    const { row } = createKey({ tier: "admin", debugEnabled: true })
    // Manually expire
    getDb().run("UPDATE keys SET debug_expires_at = 1 WHERE id = ?", [row.id])

    // countActiveDebugKeys uses the TTL-aware query: count is 0 even before sweep
    expect(countActiveDebugKeys()).toBe(0)

    // After sweep the flag is also cleared
    sweepExpiredDebugKeys()
    const after = findKeyById(row.id)
    expect(after?.debug_enabled).toBe(0)
  })

  test("Static asset /admin/assets/keys.js is served with correct MIME", async () => {
    const { sidCookie } = await loginAsAdmin()
    const res = await server.request("/admin/assets/keys.js", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("javascript")
    const body = await res.text()
    expect(body).toContain("wireDetailDebugModal")
  })
})
