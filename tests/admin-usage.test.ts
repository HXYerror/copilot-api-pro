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
    default_model_alias: "",
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

describe("GET /admin/api/usage", () => {
  test("returns 401 JSON without a session", async () => {
    const res = await server.request("/admin/api/usage", { method: "GET" })
    expect(res.status).toBe(401)
  })

  test("/admin/usage HTML route redirects without a session (SPA shell)", async () => {
    const res = await server.request("/admin/usage", { method: "GET" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toContain("/admin/login")
  })

  test("returns full dashboard payload for admin session", async () => {
    const { sidCookie } = await loginAsAdmin()
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

    const res = await server.request("/admin/api/usage?range=24h", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      filter: { range: string; since: number; until: number }
      stats: { total_requests: number; total_tokens: number; error_rate: number }
      activity: { rpm: Array<unknown>; tokens: Array<unknown>; latency: Array<unknown> }
      top_models: Array<{ model: string; count: number }>
      top_keys: Array<unknown>
      errors_by_status: Array<unknown>
      all_keys: Array<unknown>
      all_models: Array<string>
    }
    expect(body.filter.range).toBe("24h")
    expect(body.stats.total_requests).toBeGreaterThanOrEqual(1)
    expect(body.stats.total_tokens).toBeGreaterThanOrEqual(12)
    expect(body.activity.rpm.length).toBeGreaterThan(0)
    expect(body.top_models.some((m) => m.model === "gpt-4o")).toBe(true)
    expect(body.all_models).toContain("gpt-4o")
  })

  test("empty window returns zero stats but valid shape", async () => {
    const { sidCookie } = await loginAsAdmin()
    const res = await server.request("/admin/api/usage?range=24h", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      stats: { total_requests: number; total_tokens: number }
      activity: { rpm: Array<unknown> }
    }
    expect(body.stats.total_requests).toBe(0)
    expect(body.stats.total_tokens).toBe(0)
    expect(body.activity.rpm).toEqual([])
  })
})

describe("GET /admin/api/usage/export.csv", () => {
  test("redirects without a session (path matches /admin/* so SPA fallback redirect kicks in)", async () => {
    const res = await server.request("/admin/api/usage/export.csv", {
      method: "GET",
    })
    expect(res.status).toBe(401)
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

    const res = await server.request("/admin/api/usage/export.csv?range=24h", {
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

    const res = await server.request("/admin/api/usage/export.csv?range=24h", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(`"key,with,commas"`)
    expect(body).toContain(`"model""with""quotes"`)
  })
})

describe("Legacy SSR /admin/legacy/usage", () => {
  test("legacy SSR page still serves with chart containers", async () => {
    const { sidCookie } = await loginAsAdmin()
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
    const res = await server.request("/admin/legacy/usage?range=24h", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain(`id="chart-rpm"`)
    expect(html).toContain(`id="usage-data"`)
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
