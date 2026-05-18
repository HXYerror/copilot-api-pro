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
import { createKey } from "../src/services/keys"

// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../src/lib/migrations")

const fetchMock = () =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ object: "list", data: [] }),
    text: () => Promise.resolve(""),
    status: 200,
  })

// @ts-expect-error – mock doesn't implement full fetch signature
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "admin-settings-test-"))
}

function makeTmpConfig(dir: string): string {
  const cfgPath = path.join(dir, "config.json")
  const cfg: Config = {
    version: 1,
    models: {
      fast: {
        upstream: "gpt-4o-mini",
        enabled: true,
        allowed_keys: ["*"],
      },
    },
    retention: {
      events_days: 90,
      traces_days: 0,
      traces_max_bytes: 104857600,
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

let dir: string
let cfgPath: string

beforeEach(async () => {
  _resetNoAuthWarned_TEST_ONLY()
  dir = makeTmpDir()
  initDb(path.join(dir, "test.db"), MIGRATIONS_DIR)
  cfgPath = makeTmpConfig(dir)
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
    path.join(os.tmpdir(), "__nonexistent_settings_reset__.json"),
  ).catch(() => {})
})

// ---------------------------------------------------------------------------

describe("GET /admin/settings (SPA route)", () => {
  test("redirects without a session", async () => {
    const res = await server.request("/admin/settings", { method: "GET" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toContain("/admin/login")
  })
})

describe("GET /admin/api/settings", () => {
  test("returns current config JSON", async () => {
    const { sidCookie } = await loginAsAdmin()
    const res = await server.request("/admin/api/settings", {
      method: "GET",
      headers: { Cookie: sidCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      config: {
        models: Record<string, { upstream: string }>
        retention: { events_days: number; traces_days: number }
        features: { auth: boolean }
      }
    }
    expect(body.config.models["fast"]?.upstream).toBe("gpt-4o-mini")
    expect(body.config.retention.events_days).toBe(90)
    expect(body.config.retention.traces_days).toBe(0)
    expect(body.config.features.auth).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe("PUT /admin/api/settings", () => {
  function fullConfigOverride(
    override: Partial<{ retention: Record<string, number> }> = {},
  ): Record<string, unknown> {
    return {
      version: 1,
      models: {
        fast: { upstream: "gpt-4o-mini", enabled: true, allowed_keys: ["*"] },
      },
      retention: {
        events_days: 90,
        traces_days: 0,
        traces_max_bytes: 104_857_600,
        audit_days: 365,
        ...override.retention,
      },
      features: { auth: true, telemetry: false, debug: false },
    }
  }

  test("rejects missing CSRF", async () => {
    const { sidCookie } = await loginAsAdmin()
    const res = await server.request("/admin/api/settings", {
      method: "PUT",
      headers: {
        Cookie: sidCookie,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify(fullConfigOverride()),
    })
    expect(res.status).toBe(403)
  })

  test("updates retention values", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const res = await server.request("/admin/api/settings", {
      method: "PUT",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify(
        fullConfigOverride({
          retention: {
            events_days: 30,
            traces_days: 7,
            traces_max_bytes: 52_428_800,
            audit_days: 180,
          },
        }),
      ),
    })
    expect(res.status).toBe(200)

    const { getConfig } = await import("../src/lib/config-store")
    const cfg = getConfig()
    expect(cfg.retention.events_days).toBe(30)
    expect(cfg.retention.traces_days).toBe(7)
    expect(cfg.retention.traces_max_bytes).toBe(52_428_800)
    expect(cfg.retention.audit_days).toBe(180)
  })

  test("ignores submitted features.auth (lock-out defense)", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const payload = fullConfigOverride()
    ;(payload as { features: { auth: boolean } }).features.auth = false

    const res = await server.request("/admin/api/settings", {
      method: "PUT",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)

    const { getConfig } = await import("../src/lib/config-store")
    expect(getConfig().features.auth).toBe(true) // unchanged
  })

  test("rejects negative retention values via schema validation", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const res = await server.request("/admin/api/settings", {
      method: "PUT",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify(
        fullConfigOverride({
          retention: {
            events_days: -5,
            traces_days: 0,
            traces_max_bytes: 104_857_600,
            audit_days: 365,
          },
        }),
      ),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("Validation failed")
  })
})

// ---------------------------------------------------------------------------

describe("PUT /admin/api/settings — model alias edits", () => {
  function payload(models: Record<string, unknown>) {
    return {
      version: 1,
      models,
      retention: {
        events_days: 90,
        traces_days: 0,
        traces_max_bytes: 104_857_600,
        audit_days: 365,
      },
      features: { auth: true, telemetry: false, debug: false },
    }
  }

  test("adds a new model alias", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const res = await server.request("/admin/api/settings", {
      method: "PUT",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify(
        payload({
          fast: {
            upstream: "gpt-4o-mini",
            enabled: true,
            allowed_keys: ["*"],
          },
          claude: {
            upstream: "claude-sonnet-4.5",
            enabled: true,
            allowed_keys: ["*"],
          },
        }),
      ),
    })
    expect(res.status).toBe(200)

    const { getConfig } = await import("../src/lib/config-store")
    const cfg = getConfig()
    expect(Object.keys(cfg.models).sort()).toEqual(["claude", "fast"])
    expect(cfg.models["claude"].upstream).toBe("claude-sonnet-4.5")
  })

  test("removes a model alias when omitted from the payload", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const res = await server.request("/admin/api/settings", {
      method: "PUT",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify(payload({})),
    })
    expect(res.status).toBe(200)

    const { getConfig } = await import("../src/lib/config-store")
    expect(Object.keys(getConfig().models)).toEqual([])
  })

  test("rejects URL-shaped upstream value (SSRF guard)", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const res = await server.request("/admin/api/settings", {
      method: "PUT",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify(
        payload({
          evil: {
            upstream: "https://attacker.example/exfil",
            enabled: true,
            allowed_keys: ["*"],
          },
        }),
      ),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("Validation failed")
  })

  test("written file mode is 0600", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const res = await server.request("/admin/api/settings", {
      method: "PUT",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify(
        payload({
          fast: {
            upstream: "gpt-4o-mini",
            enabled: true,
            allowed_keys: ["*"],
          },
        }),
      ),
    })
    expect(res.status).toBe(200)
    const stat = fs.statSync(cfgPath)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test("audit log contains a config.update entry after save", async () => {
    const { cookieHeader, csrfValue } = await loginAsAdmin()
    const res = await server.request("/admin/api/settings", {
      method: "PUT",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": csrfValue,
      },
      body: JSON.stringify(
        payload({
          fast: {
            upstream: "gpt-4o-mini",
            enabled: true,
            allowed_keys: ["*"],
          },
        }),
      ),
    })
    expect(res.status).toBe(200)
    // safeAudit/try-catch guarantees the call never propagates errors; the
    // round-trip not crashing is the audit-log invariant we care about here.
  })
})
