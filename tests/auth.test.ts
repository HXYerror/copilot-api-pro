import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Config } from "../src/lib/config-store"
import type { KeyRow } from "../src/services/keys"

import { loadConfig, saveConfig } from "../src/lib/config-store"
import { closeDb, getDb, initDb, resetDb } from "../src/lib/db"
import {
  _resetNoAuthWarned_TEST_ONLY,
  isModelAllowed,
  requireAdmin,
} from "../src/middleware/auth"
import { server } from "../src/server"
import { createKey, hashKey, revokeKey } from "../src/services/keys"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../src/lib/migrations")

// ---------------------------------------------------------------------------
// Mock fetch so upstream calls never hit real GitHub APIs
// ---------------------------------------------------------------------------

const fetchMock = mock(() =>
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
  }),
)

// @ts-expect-error – mock doesn't implement full fetch signature
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDb(): { dir: string; dbFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"))
  const dbFile = path.join(dir, "test.db")
  return { dir, dbFile }
}

function makeTmpConfig(override: Partial<Config["features"]> = {}): {
  tmpDir: string
  cfgPath: string
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-cfg-test-"))
  const cfgPath = path.join(tmpDir, "config.json")
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
  return { tmpDir, cfgPath }
}

// ---------------------------------------------------------------------------
// Test DB / Config lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string
let dbFile: string
let cfgTmpDir: string
let cfgPath: string

beforeEach(async () => {
  _resetNoAuthWarned_TEST_ONLY()
  const db = makeTmpDb()
  tmpDir = db.dir
  dbFile = db.dbFile
  initDb(dbFile, MIGRATIONS_DIR)

  const cfg = makeTmpConfig({ auth: true })
  cfgTmpDir = cfg.tmpDir
  cfgPath = cfg.cfgPath
  await loadConfig(cfgPath)
})

afterEach(async () => {
  try {
    closeDb(getDb())
  } catch {
    // already closed
  }
  resetDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(cfgTmpDir, { recursive: true, force: true })
  // Reset to default config (auth: false is the schema default)
  await loadConfig(
    path.join(os.tmpdir(), "__nonexistent_config_reset__.json"),
  ).catch(() => {})
})

// ---------------------------------------------------------------------------
// Helper: make a valid bearer token + DB row
// ---------------------------------------------------------------------------

function makeKey(opts?: {
  tier?: "admin" | "client"
  allowedModels?: Array<string>
}): { plain: string; row: KeyRow } {
  return createKey({
    tier: opts?.tier ?? "admin",
    allowedModels: opts?.allowedModels,
  })
}

function authHeader(plain: string): Record<string, string> {
  return { Authorization: `Bearer ${plain}` }
}

// ---------------------------------------------------------------------------
// isModelAllowed unit tests
// ---------------------------------------------------------------------------

describe("isModelAllowed()", () => {
  test("wildcard allows any model", () => {
    expect(isModelAllowed('["*"]', "gpt-4o")).toBe(true)
    expect(isModelAllowed('["*"]', "claude-sonnet-4-5")).toBe(true)
  })

  test("explicit list allows listed model", () => {
    expect(isModelAllowed('["gpt-4o"]', "gpt-4o")).toBe(true)
  })

  test("explicit list rejects unlisted model", () => {
    expect(isModelAllowed('["gpt-4o"]', "claude-sonnet-4-5")).toBe(false)
  })

  test("invalid JSON returns false", () => {
    expect(isModelAllowed("not-json", "gpt-4o")).toBe(false)
  })

  test("non-array JSON (string '*') returns false — no bypass", () => {
    // A JSON string "\"*\"" must not bypass the wildcard check via String.prototype.includes
    expect(isModelAllowed('"*"', "any-model")).toBe(false)
  })

  test("null JSON value returns false", () => {
    expect(isModelAllowed("null", "gpt-4o")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// requireAdmin unit tests
// ---------------------------------------------------------------------------

describe("requireAdmin()", () => {
  test("returns null for admin key", () => {
    const { row } = makeKey({ tier: "admin" })
    const fakeCtx = {
      get: (_k: string) => row,
    } as unknown as Parameters<typeof requireAdmin>[0]
    expect(requireAdmin(fakeCtx)).toBeNull()
  })

  test("returns 403 Response for client key", () => {
    const { row } = makeKey({ tier: "client" })
    const fakeCtx = {
      get: (_k: string) => row,
    } as unknown as Parameters<typeof requireAdmin>[0]
    const result = requireAdmin(fakeCtx)
    expect(result).not.toBeNull()
    expect(result?.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Auth middleware integration tests via server.request
// ---------------------------------------------------------------------------

describe("GET /v1/models — auth middleware", () => {
  test("401 when no Authorization header", async () => {
    const res = await server.request("/v1/models", { method: "GET" })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_api_key")
  })

  test("401 response includes WWW-Authenticate header", async () => {
    const res = await server.request("/v1/models", { method: "GET" })
    expect(res.status).toBe(401)
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer")
  })

  test("401 when Authorization does not start with sk-cap-", async () => {
    const res = await server.request("/v1/models", {
      method: "GET",
      headers: { Authorization: "Bearer sk-proj-XXXXXXXX" },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as {
      error: { code: string; message: string }
    }
    expect(body.error.code).toBe("invalid_api_key")
    // Should include the "use sk-cap-*" guidance
    expect(body.error.message).toContain("sk-cap-")
  })

  test("401 when bearer has sk-cap- prefix but malformed (wrong length)", async () => {
    const res = await server.request("/v1/models", {
      method: "GET",
      headers: { Authorization: "Bearer sk-cap-SHORT" },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_api_key")
  })

  test("401 when key not found in DB", async () => {
    const res = await server.request("/v1/models", {
      method: "GET",
      headers: {
        Authorization:
          "Bearer sk-cap-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    })
    expect(res.status).toBe(401)
  })

  test("401 when key is revoked", async () => {
    const { plain, row } = makeKey()
    revokeKey(row.id)
    const res = await server.request("/v1/models", {
      method: "GET",
      headers: authHeader(plain),
    })
    expect(res.status).toBe(401)
  })

  test("200 when valid key", async () => {
    const { plain } = makeKey()
    const res = await server.request("/v1/models", {
      method: "GET",
      headers: authHeader(plain),
    })
    expect(res.status).toBe(200)
  })

  test("200 when valid key with lowercase 'bearer' scheme", async () => {
    const { plain } = makeKey()
    const res = await server.request("/v1/models", {
      method: "GET",
      headers: { Authorization: `bearer ${plain}` },
    })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// no-auth mode
// ---------------------------------------------------------------------------

describe("no-auth mode (features.auth = false)", () => {
  test("request without any key returns 200 for /v1/models", async () => {
    const { tmpDir: noAuthDir, cfgPath: noAuthCfg } = makeTmpConfig({
      auth: false,
    })
    try {
      await loadConfig(noAuthCfg)
      const res = await server.request("/v1/models", { method: "GET" })
      expect(res.status).toBe(200)
    } finally {
      await loadConfig(cfgPath) // restore auth: true
      fs.rmSync(noAuthDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// X-Capi-Debug stripping for client tier
// ---------------------------------------------------------------------------

describe("X-Capi-Debug header", () => {
  test("client-tier key with X-Capi-Debug still passes auth (200)", async () => {
    const { plain } = makeKey({ tier: "client" })
    const res = await server.request("/v1/models", {
      method: "GET",
      headers: {
        ...authHeader(plain),
        "X-Capi-Debug": "1",
      },
    })
    // Auth passes; debug header is stripped silently
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Model scope check
// ---------------------------------------------------------------------------

describe("Model scope check", () => {
  test("403 when client key with gpt-4o allowlist requests claude-sonnet-4-5 via /v1/messages", async () => {
    const { plain } = makeKey({
      tier: "client",
      allowedModels: ["gpt-4o"],
    })
    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        ...authHeader(plain),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("model_not_allowed")
  })

  test("403 when client key with gpt-4o allowlist requests claude-sonnet-4-5 via /v1/chat/completions", async () => {
    const { plain } = makeKey({
      tier: "client",
      allowedModels: ["gpt-4o"],
    })
    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        ...authHeader(plain),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("model_not_allowed")
  })

  test("wildcard key allows any model at /v1/messages (does not 403 or 401)", async () => {
    const { plain } = makeKey({ tier: "client", allowedModels: ["*"] })
    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        ...authHeader(plain),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })
})

// ---------------------------------------------------------------------------
// hashKey consistency (belt-and-suspenders)
// ---------------------------------------------------------------------------

describe("hashKey", () => {
  test("same key hashes to same value", () => {
    const plain = "sk-cap-TESTKEY"
    expect(hashKey(plain)).toBe(hashKey(plain))
  })
})
