import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Config } from "../src/lib/config-store"

import { CSRF_COOKIE } from "../src/admin/csrf"
import { loadConfig, saveConfig } from "../src/lib/config-store"
import { closeDb, getDb, initDb, resetDb } from "../src/lib/db"
import { _resetNoAuthWarned_TEST_ONLY } from "../src/middleware/auth"
import { server } from "../src/server"
import { recordEvent } from "../src/services/events"
import { createKey } from "../src/services/keys"

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../src/lib/migrations")

const fetchMock = () =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        object: "list",
        data: [],
      }),
    text: () => Promise.resolve(""),
    status: 200,
  })

// @ts-expect-error – mock doesn't implement full fetch signature
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "admin-usage-test-"))
}

function makeTmpConfig(dir: string): string {
  const cfgPath = path.join(dir, "config.json")
  const cfg: Config = {
    version: 1,
    models: {},
    retention: {
      events_days: 90,
      traces_days: 7,
      traces_max_bytes: 104_857_600,
      audit_days: 365,
    },
    features: { auth: true, telemetry: false, debug: false },
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
}

async function loginAsAdmin(): Promise<LoggedIn> {
  const { plain } = createKey({ tier: "admin", label: "test-admin" })
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
  return { sidCookie, csrfValue, cookieHeader }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let dir: string

beforeEach(async () => {
  _resetNoAuthWarned_TEST_ONLY()
  dir = makeTmpDir()
  initDb(path.join(dir, "test.db"), MIGRATIONS_DIR)
  await loadConfig(makeTmpConfig(dir))
})

afterEach(async () => {
  try {
    closeDb(getDb())
  } catch {
    /* already closed */
  }
  resetDb()
  fs.rmSync(dir, { recursive: true, force: true })
  // Reset to the shared "auth=false" config file written by telemetry.test.ts
  // so later test files (responses-route.test.ts, etc.) don't suddenly see
  // features.auth=true after we exit.
  await loadConfig(
    path.join(os.tmpdir(), "__nonexistent_keys_reset__.json"),
  ).catch(() => {})
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /admin/usage", () => {
  test("redirects to /admin/login without a session", async () => {
    const res = await server.request("/admin/usage", { method: "GET" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toContain("/admin/login")
  })

  test("returns 200 HTML with chart containers + data island for admin session", async () => {
    const { sidCookie } = await loginAsAdmin()
    // Seed at least one event so the dashboard renders the charts (not empty)
    recordEvent({
      ts: Date.now() - 60_000,
      key_id: "kx",
      model: "gpt-4o",
      upstream_model: "gpt-4o",
      prompt_tokens: 5,
      completion_tokens: 7,
      status: 200,
      latency_ms: 42,
      error: null,
      usage_unknown: 0,
    })

    const res = await server.request("/admin/usage?range=24h", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    const html = await res.text()

    // Chart containers
    expect(html).toContain(`id="chart-rpm"`)
    expect(html).toContain(`id="chart-tph"`)
    expect(html).toContain(`id="chart-p95"`)

    // Embedded JSON data island
    expect(html).toContain(`id="usage-data"`)
    expect(html).toContain(`type="application/json"`)

    // External scripts loaded (CSP-safe)
    expect(html).toContain(`/admin/assets/uplot.min.js`)
    expect(html).toContain(`/admin/assets/usage.js`)

    // Nav highlights Usage
    expect(html).toContain("admin-nav__link--active")
  })

  test("renders the empty state when there are no events", async () => {
    const { sidCookie } = await loginAsAdmin()
    const res = await server.request("/admin/usage?range=24h", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("No events in the selected window")
  })

  test("CSP header forbids inline script and the page has no inline JS", async () => {
    const { sidCookie } = await loginAsAdmin()
    const res = await server.request("/admin/usage?range=24h", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    const csp = res.headers.get("content-security-policy") ?? ""
    expect(csp).toContain("default-src 'self'")
    const html = await res.text()
    // No inline event handlers
    expect(html).not.toMatch(/onclick=/)
    expect(html).not.toMatch(/onload=/)
    // The data island uses type="application/json", which the browser does
    // NOT execute as script.  Anything in a <script src="…"> tag is loaded
    // from /admin/assets which is same-origin.
  })
})

describe("GET /admin/usage/export.csv", () => {
  test("redirects without a session", async () => {
    const res = await server.request("/admin/usage/export.csv", {
      method: "GET",
    })
    expect(res.status).toBe(302)
  })

  test("returns CSV with header row + correct headers", async () => {
    const { sidCookie } = await loginAsAdmin()
    recordEvent({
      ts: Date.now() - 1000,
      key_id: "kk",
      model: "gpt-4o",
      upstream_model: "gpt-4o",
      prompt_tokens: 11,
      completion_tokens: 22,
      status: 200,
      latency_ms: 33,
      error: null,
      usage_unknown: 0,
    })

    const res = await server.request("/admin/usage/export.csv?range=24h", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/csv")
    expect(res.headers.get("content-disposition")).toContain("attachment")
    expect(res.headers.get("content-disposition")).toContain("usage-")
    const body = await res.text()
    const lines = body.split("\n")
    expect(lines[0]).toBe(
      "id,ts,key_id,model,upstream_model,prompt_tokens,completion_tokens,status,latency_ms,error,usage_unknown",
    )
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[1]).toContain("gpt-4o")
  })

  test("quotes fields containing commas or quotes (RFC 4180)", async () => {
    const { sidCookie } = await loginAsAdmin()
    recordEvent({
      ts: Date.now() - 100,
      key_id: "key,with,commas",
      model: `model"with"quotes`,
      upstream_model: "ok",
      prompt_tokens: 1,
      completion_tokens: 2,
      status: 500,
      latency_ms: 1,
      error: "upstream",
      usage_unknown: 0,
    })

    const res = await server.request("/admin/usage/export.csv?range=24h", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    // Comma-bearing key_id is wrapped in quotes
    expect(body).toContain(`"key,with,commas"`)
    // Embedded double-quotes are doubled
    expect(body).toContain(`"model""with""quotes"`)
  })
})

describe("Static assets", () => {
  test("/admin/assets/uplot.min.js is served with javascript MIME", async () => {
    const { sidCookie } = await loginAsAdmin()
    const res = await server.request("/admin/assets/uplot.min.js", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("javascript")
    const text = await res.text()
    expect(text).toContain("uPlot")
  })

  test("/admin/assets/usage.js is served with javascript MIME", async () => {
    const { sidCookie } = await loginAsAdmin()
    const res = await server.request("/admin/assets/usage.js", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("javascript")
    const text = await res.text()
    expect(text).toContain("usage-data")
  })

  test("/admin/assets/uplot.min.css is served with css MIME", async () => {
    const { sidCookie } = await loginAsAdmin()
    const res = await server.request("/admin/assets/uplot.min.css", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/css")
  })
})
