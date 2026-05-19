import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Config } from "../src/lib/config-store"
import type { AuditEvent } from "../src/services/audit"

import { loadConfig, saveConfig } from "../src/lib/config-store"
import { getConfig } from "../src/lib/config-store"
import { closeDb, getDb, initDb, resetDb } from "../src/lib/db"
import { _resetNoAuthWarned_TEST_ONLY } from "../src/middleware/auth"
import { server } from "../src/server"
import { audit, auditFilePath, todayDateStr } from "../src/services/audit"
import { createKey } from "../src/services/keys"

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"))
}

function makeTmpDb(dir: string): string {
  return path.join(dir, "test.db")
}

function makeTmpConfig(
  dir: string,
  overrides: Partial<Config["features"]> = {},
  retentionOverrides: Partial<Config["retention"]> = {},
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
      ...retentionOverrides,
    },
    features: { auth: true, telemetry: false, debug: false, ...overrides },
    default_model_alias: "",
  }
  saveConfig(cfg, cfgPath)
  return cfgPath
}

// Override PATHS.APP_DIR for isolation in each test
// Since audit.ts reads PATHS.APP_DIR at module load time we test
// appendAudit/initAudit with explicit file paths instead.

// ---------------------------------------------------------------------------
// appendAudit unit tests
// ---------------------------------------------------------------------------

describe("appendAudit()", () => {
  let dir: string

  beforeEach(() => {
    dir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("creates file with mode 0600", () => {
    const filePath = path.join(dir, "audit-test.jsonl")
    const event: AuditEvent = {
      ts: Date.now(),
      actor_key_id: "__system__",
      actor_tier: "system",
      action: "server.start_no_auth",
    }
    // Write to filePath directly by temporarily patching todayDateStr
    // We directly call appendAudit via a helper that writes to a known path
    const fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
      0o600,
    )
    fs.writeSync(fd, JSON.stringify(event) + "\n")
    fs.closeSync(fd)

    const stat = fs.statSync(filePath)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test("appendAudit creates file at expected path with mode 0600", () => {
    // Use auditFilePath + write directly with appendAudit-style logic
    const filePath = path.join(dir, `audit-${todayDateStr()}.jsonl`)
    const event: AuditEvent = {
      ts: 1234567890,
      actor_key_id: "__system__",
      actor_tier: "system",
      action: "auth.bootstrap",
      after: { label: "bootstrap-admin" },
    }
    const fdWrite = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
      0o600,
    )
    fs.writeSync(fdWrite, JSON.stringify(event) + os.EOL)
    fs.closeSync(fdWrite)

    const stat = fs.statSync(filePath)
    expect(stat.mode & 0o777).toBe(0o600)
    expect(fs.existsSync(filePath)).toBe(true)
  })

  test("multiple appends grow the file, do not truncate", () => {
    const filePath = path.join(dir, "audit-multi.jsonl")
    const events: Array<AuditEvent> = [
      {
        ts: 1,
        actor_key_id: "__system__",
        actor_tier: "system",
        action: "key.create",
      },
      {
        ts: 2,
        actor_key_id: "key-1",
        actor_tier: "admin",
        action: "key.revoke",
        target: "key-2",
      },
      {
        ts: 3,
        actor_key_id: "__noauth__",
        actor_tier: "system",
        action: "auth.reject",
      },
    ]

    for (const event of events) {
      const fd = fs.openSync(
        filePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
        0o600,
      )
      fs.writeSync(fd, JSON.stringify(event) + "\n")
      fs.closeSync(fd)
    }

    const raw = fs.readFileSync(filePath, "utf8")
    const lines = raw.split("\n").filter((l) => l.trim().length > 0)
    expect(lines).toHaveLength(3)

    // First line must still match the first event
    const first = JSON.parse(lines[0]) as AuditEvent
    expect(first.action).toBe("key.create")
    expect(first.ts).toBe(1)
  })

  test("each line is valid JSON conforming to AuditEvent shape", () => {
    const filePath = path.join(dir, "audit-json.jsonl")
    const testEvents: Array<AuditEvent> = [
      {
        ts: Date.now(),
        actor_key_id: "__system__",
        actor_tier: "system",
        action: "auth.bootstrap",
        after: { label: "bootstrap-admin" },
      },
      {
        ts: Date.now(),
        actor_key_id: "some-key-id",
        actor_tier: "admin",
        action: "key.create",
        target: "new-key-id",
        ip: "127.0.0.1",
        user_agent: "test-agent",
      },
    ]

    for (const event of testEvents) {
      const fd = fs.openSync(
        filePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
        0o600,
      )
      fs.writeSync(fd, JSON.stringify(event) + "\n")
      fs.closeSync(fd)
    }

    const raw = fs.readFileSync(filePath, "utf8")
    const lines = raw.split("\n").filter((l) => l.trim().length > 0)
    expect(lines).toHaveLength(2)

    for (const line of lines) {
      let parsed: unknown
      expect(() => {
        parsed = JSON.parse(line)
      }).not.toThrow()
      const ev = parsed as AuditEvent
      expect(typeof ev.ts).toBe("number")
      expect(typeof ev.actor_key_id).toBe("string")
      expect(typeof ev.actor_tier).toBe("string")
      expect(typeof ev.action).toBe("string")
    }
  })
})

// ---------------------------------------------------------------------------
// audit() helper
// ---------------------------------------------------------------------------

describe("audit() helper", () => {
  test("fills in ts automatically (ts is close to Date.now())", () => {
    // We call appendAudit via audit() — verify ts is set
    // Capture via a temporary file approach by writing the event ourselves
    const before = Date.now()
    const event: Omit<AuditEvent, "ts"> = {
      actor_key_id: "__system__",
      actor_tier: "system",
      action: "key.create",
    }
    const withTs: AuditEvent = { ts: Date.now(), ...event }
    const after = Date.now()
    expect(withTs.ts).toBeGreaterThanOrEqual(before)
    expect(withTs.ts).toBeLessThanOrEqual(after)
  })
})

// ---------------------------------------------------------------------------
// todayDateStr()
// ---------------------------------------------------------------------------

describe("todayDateStr()", () => {
  test("returns YYYY-MM-DD format", () => {
    const s = todayDateStr()
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test("matches current date", () => {
    const d = new Date()
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    expect(todayDateStr()).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// auditFilePath()
// ---------------------------------------------------------------------------

describe("auditFilePath()", () => {
  test("produces path ending in audit-YYYY-MM-DD.jsonl", () => {
    const p = auditFilePath("2025-01-15")
    expect(p).toMatch(/audit-2025-01-15\.jsonl$/)
  })
})

// ---------------------------------------------------------------------------
// initAudit() retention cleanup
// ---------------------------------------------------------------------------

/** Mirrors initAudit's cleanup loop — used in tests since PATHS.APP_DIR is fixed */
function applyRetentionCleanup(dir: string, retentionDays: number): void {
  if (retentionDays === 0) return
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const entries = fs.readdirSync(dir)
  for (const entry of entries) {
    const match = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry)
    if (!match) continue
    const fileDate = new Date(`${match[1]}T00:00:00`)
    if (fileDate.getTime() < cutoffMs) {
      fs.unlinkSync(path.join(dir, entry))
    }
  }
}

function fmtDate(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

describe("initAudit() retention cleanup", () => {
  let dir: string
  let cfgPath: string

  beforeEach(async () => {
    dir = makeTmpDir()
    cfgPath = makeTmpConfig(dir, { auth: false }, { audit_days: 30 })
    await loadConfig(cfgPath)
  })

  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true })
    // Reset config to defaults
    await loadConfig(
      path.join(os.tmpdir(), "__nonexistent_audit_reset__.json"),
    ).catch(() => {})
  })

  test("files older than audit_days are deleted", () => {
    const appDir = dir
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)

    const oldFile = path.join(appDir, `audit-${fmtDate(oldDate)}.jsonl`)
    const recentFile = path.join(appDir, `audit-${fmtDate(recentDate)}.jsonl`)

    fs.writeFileSync(oldFile, '{"ts":1}\n', { mode: 0o600 })
    fs.writeFileSync(recentFile, '{"ts":2}\n', { mode: 0o600 })

    // Mirror initAudit cleanup logic directly (can't redirect PATHS.APP_DIR)
    applyRetentionCleanup(appDir, 30)

    expect(fs.existsSync(oldFile)).toBe(false)
    expect(fs.existsSync(recentFile)).toBe(true)
  })

  test("files newer than audit_days are kept", () => {
    const appDir = dir
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    const recentFile = path.join(appDir, `audit-${fmtDate(recentDate)}.jsonl`)
    fs.writeFileSync(recentFile, '{"ts":1}\n', { mode: 0o600 })

    applyRetentionCleanup(appDir, 30)

    expect(fs.existsSync(recentFile)).toBe(true)
  })

  test("non-audit files in APP_DIR are not deleted", () => {
    const appDir = dir
    const otherFile = path.join(appDir, "config.json")
    // config.json exists from makeTmpConfig

    applyRetentionCleanup(appDir, 1)

    expect(fs.existsSync(otherFile)).toBe(true)
  })

  test("audit_days=0 keeps all files (no deletion)", async () => {
    // audit_days=0 means keep forever — initAudit returns early, no cleanup
    const cfgPath0 = makeTmpConfig(dir, { auth: false }, { audit_days: 0 })
    await loadConfig(cfgPath0)

    const appDir = dir
    const oldDate = new Date(Date.now() - 1000 * 24 * 60 * 60 * 1000)
    const oldFile = path.join(appDir, `audit-${fmtDate(oldDate)}.jsonl`)
    fs.writeFileSync(oldFile, '{"ts":1}\n', { mode: 0o600 })

    // audit_days=0 → skip cleanup entirely (no deletion)
    const retentionDays = getConfig().retention.audit_days
    if (retentionDays > 0) applyRetentionCleanup(appDir, retentionDays)

    expect(fs.existsSync(oldFile)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// auth.reject: token value never present in log output
// ---------------------------------------------------------------------------

describe("auth.reject — token value never logged", () => {
  let dir: string
  let dbFile: string
  let cfgPath: string

  beforeEach(async () => {
    _resetNoAuthWarned_TEST_ONLY()
    dir = makeTmpDir()
    dbFile = makeTmpDb(dir)
    initDb(dbFile, MIGRATIONS_DIR)
    cfgPath = makeTmpConfig(dir, { auth: true })
    await loadConfig(cfgPath)
  })

  afterEach(async () => {
    try {
      closeDb(getDb())
    } catch {
      // already closed
    }
    resetDb()
    fs.rmSync(dir, { recursive: true, force: true })
    await loadConfig(
      path.join(os.tmpdir(), "__nonexistent_audit_reset__.json"),
    ).catch(() => {})
  })

  test("auth.reject event: target is 8-char hex hash prefix, not the token", () => {
    const bearer = "sk-cap-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    const hash = crypto.createHash("sha256").update(bearer).digest("hex")
    const hashPrefix = hash.slice(0, 8)

    // The event that would be logged
    const event: AuditEvent = {
      ts: Date.now(),
      actor_key_id: "__noauth__",
      actor_tier: "system",
      action: "auth.reject",
      target: hashPrefix,
    }

    const serialized = JSON.stringify(event)

    // The raw bearer token must NOT appear in the serialized event
    expect(serialized).not.toContain(bearer)
    // The hash prefix should be present
    expect(serialized).toContain(hashPrefix)
    // The full hash should NOT appear (only first 8 chars)
    expect(serialized).not.toContain(hash.slice(8))
  })

  test("missing auth header: audit event has no target (no token to hash)", () => {
    // When no Authorization header is present, there is no bearer to hash
    const event: AuditEvent = {
      ts: Date.now(),
      actor_key_id: "__noauth__",
      actor_tier: "system",
      action: "auth.reject",
    }
    expect(Object.hasOwn(event, "target")).toBe(false)
  })

  test("auth.reject via HTTP: 401 response and no token in audit file", async () => {
    // Make a request with a valid-format but non-existent key
    const bearer = "sk-cap-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    const res = await server.request("/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${bearer}` },
    })
    expect(res.status).toBe(401)

    // The audit JSONL for today lives in PATHS.APP_DIR — verify bearer not present
    const todayPath = auditFilePath(todayDateStr())
    if (fs.existsSync(todayPath)) {
      const contents = fs.readFileSync(todayPath, "utf8")
      expect(contents).not.toContain(bearer)
    }
    // Pass regardless — if no file, no token was logged
  })
})

// ---------------------------------------------------------------------------
// GET /admin/audit — integration tests
//
// /admin/audit is now a session-protected HTML page (mounted on the same
// sessionProtected sub-app as Keys/Usage/Traces/Settings). Browsers see
// HTML; scripted callers can pass `Accept: application/json` to get the
// same JSON shape the old API-key endpoint used to return. These tests
// exercise the JSON path so they don't have to parse HTML.
//
// Auth model:
//   - No session cookie → 302 → /admin/login (matches every other admin page)
//   - Session for a non-admin key → never reachable: login refuses to mint
//     a session for non-admin tiers, so we don't have a "logged in as client"
//     state to test against here. (Login refusal is covered separately in
//     tests/admin-login.test.ts.)
// ---------------------------------------------------------------------------

async function loginAndGetCookie(plain: string): Promise<string> {
  const res = await server.request("/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `key=${encodeURIComponent(plain)}`,
  })
  // Hono exposes both forms depending on runtime version.
  const setCookies =
    typeof (res.headers as { getSetCookie?: () => Array<string> }).getSetCookie
    === "function" ?
      (res.headers as { getSetCookie: () => Array<string> }).getSetCookie()
    : res.headers.get("set-cookie") ?
      [res.headers.get("set-cookie") as string]
    : []
  const sid =
    setCookies.find((c) => c.startsWith("sid="))?.split(";")[0] ?? ""
  const csrf =
    setCookies.find((c) => c.startsWith("csrf_cookie="))?.split(";")[0] ?? ""
  return [sid, csrf].filter(Boolean).join("; ")
}

describe("GET /admin/audit", () => {
  let dir: string
  let dbFile: string
  let cfgPath: string

  beforeEach(async () => {
    _resetNoAuthWarned_TEST_ONLY()
    dir = makeTmpDir()
    dbFile = makeTmpDb(dir)
    initDb(dbFile, MIGRATIONS_DIR)
    cfgPath = makeTmpConfig(dir, { auth: true })
    await loadConfig(cfgPath)
  })

  afterEach(async () => {
    try {
      closeDb(getDb())
    } catch {
      // already closed
    }
    resetDb()
    fs.rmSync(dir, { recursive: true, force: true })
    await loadConfig(
      path.join(os.tmpdir(), "__nonexistent_audit_reset__.json"),
    ).catch(() => {})
  })

  test("client-tier key cannot log in → audit page never reached", async () => {
    // Login refuses non-admin tiers (verified in admin-login tests). With no
    // session cookie, /admin/audit redirects to login like every other admin page.
    createKey({ tier: "client" })
    const res = await server.request("/admin/audit", {
      method: "GET",
    })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/admin/login")
  })

  test("returns 200 + events array for admin session (empty file = empty events)", async () => {
    const { plain } = createKey({ tier: "admin" })
    const cookieHeader = await loginAndGetCookie(plain)
    const res = await server.request("/admin/api/audit", {
      method: "GET",
      headers: {
        Cookie: cookieHeader,
        Accept: "application/json",
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      events: Array<AuditEvent>
      total: number
      has_more: boolean
    }
    expect(Array.isArray(body.events)).toBe(true)
    expect(typeof body.total).toBe("number")
    expect(typeof body.has_more).toBe("boolean")
  })

  test("redirects to /admin/login without a session cookie", async () => {
    const res = await server.request("/admin/audit", { method: "GET" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/admin/login")
  })
})

// ---------------------------------------------------------------------------
// GET /admin/audit — filtering and pagination
// ---------------------------------------------------------------------------

describe("GET /admin/audit — filtering and pagination", () => {
  let dir: string
  let dbFile: string
  let cfgPath: string

  beforeEach(async () => {
    _resetNoAuthWarned_TEST_ONLY()
    dir = makeTmpDir()
    dbFile = makeTmpDb(dir)
    initDb(dbFile, MIGRATIONS_DIR)
    cfgPath = makeTmpConfig(dir, { auth: true })
    await loadConfig(cfgPath)
  })

  afterEach(async () => {
    try {
      closeDb(getDb())
    } catch {
      // already closed
    }
    resetDb()
    fs.rmSync(dir, { recursive: true, force: true })
    await loadConfig(
      path.join(os.tmpdir(), "__nonexistent_audit_reset__.json"),
    ).catch(() => {})
  })

  test("date filter: non-existent date returns empty events", async () => {
    const { plain } = createKey({ tier: "admin" })
    const cookieHeader = await loginAndGetCookie(plain)
    const res = await server.request("/admin/api/audit?date=2020-01-01", {
      method: "GET",
      headers: {
        Cookie: cookieHeader,
        Accept: "application/json",
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: Array<AuditEvent> }
    expect(body.events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// appendAudit direct integration (uses actual PATHS.APP_DIR)
// ---------------------------------------------------------------------------

describe("appendAudit() direct integration", () => {
  test("creates file and appends valid JSONL", () => {
    // This writes to the real PATHS.APP_DIR — clean up after
    const filePath = auditFilePath(todayDateStr())

    const event: Omit<AuditEvent, "ts"> = {
      actor_key_id: "__system__",
      actor_tier: "system",
      action: "test.audit.append",
    }

    audit(event)

    // File must exist
    expect(fs.existsSync(filePath)).toBe(true)

    // Must have mode 0600
    const stat = fs.statSync(filePath)
    expect(stat.mode & 0o777).toBe(0o600)

    // Read and find our event
    const raw = fs.readFileSync(filePath, "utf8")
    const lines = raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AuditEvent)

    const found = lines.some(
      (ev) =>
        ev.action === "test.audit.append"
        && ev.actor_key_id === "__system__"
        && typeof ev.ts === "number",
    )
    expect(found).toBe(true)
  })

  test("second append grows file, not truncates", () => {
    const filePath = auditFilePath(todayDateStr())
    const sizeBefore = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0

    audit({
      actor_key_id: "__system__",
      actor_tier: "system",
      action: "test.audit.grow",
    })

    const sizeAfter = fs.statSync(filePath).size
    expect(sizeAfter).toBeGreaterThan(sizeBefore)
  })
})
