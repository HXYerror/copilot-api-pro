import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { closeDb, getDb, initDb, resetDb } from "../src/lib/db"
import {
  countActiveAdminKeys,
  createKey,
  findKeyByHash,
  generateKey,
  hashKey,
  listKeys,
  revokeKey,
  setDebugEnabled,
} from "../src/services/keys"

// Use import.meta.dir so tests work regardless of the cwd from which `bun test` is run
const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../src/lib/migrations")

function makeTmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keys-test-"))
  const dbFile = path.join(dir, "test.db")
  return { dir, dbFile }
}

describe("generateKey", () => {
  test("has correct prefix", () => {
    expect(generateKey()).toMatch(/^sk-cap-/)
  })
  test("has correct total length (59 chars)", () => {
    expect(generateKey()).toHaveLength(59)
  })
  test("generates unique keys", () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateKey()))
    expect(keys.size).toBe(100)
  })
  test("contains only valid base32 + prefix chars", () => {
    expect(generateKey()).toMatch(/^sk-cap-[A-Z2-7]{52}$/)
  })
  test("no zero-padding: last char is not always 'A'", () => {
    // With 33 random bytes, the last base32 char is derived from real entropy.
    // There should be variation across a sample — it won't always be 'A'.
    const lastChars = new Set(
      Array.from({ length: 200 }, () => generateKey().slice(-1)),
    )
    expect(lastChars.size).toBeGreaterThan(1)
  })
})

describe("hashKey", () => {
  test("is deterministic", () => {
    const key = "sk-cap-TESTKEY"
    expect(hashKey(key)).toBe(hashKey(key))
  })
  test("produces 64-char hex string", () => {
    expect(hashKey("test")).toMatch(/^[0-9a-f]{64}$/)
  })
  test("different inputs produce different hashes", () => {
    expect(hashKey("a")).not.toBe(hashKey("b"))
  })
})

describe("keys CRUD", () => {
  let dbFile: string
  let dir: string

  beforeEach(() => {
    const tmp = makeTmpDb()
    dir = tmp.dir
    dbFile = tmp.dbFile
    initDb(dbFile, MIGRATIONS_DIR)
  })

  afterEach(() => {
    try {
      closeDb(getDb())
    } catch {
      // db may already be closed
    }
    resetDb()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("createKey creates admin key with correct fields", () => {
    const { plain, row } = createKey({ tier: "admin", label: "test-admin" })
    expect(plain).toMatch(/^sk-cap-[A-Z2-7]{52}$/)
    expect(row.tier).toBe("admin")
    expect(row.label).toBe("test-admin")
    expect(row.hash).toBe(hashKey(plain))
    expect(row.revoked_at).toBeNull()
  })

  test("plain key is never in DB (hash only)", () => {
    const { plain } = createKey({ tier: "client" })
    const all = listKeys()
    for (const row of all) {
      expect(row.hash).not.toBe(plain)
    }
  })

  test("findKeyByHash returns correct row", () => {
    const { plain } = createKey({ tier: "admin" })
    const found = findKeyByHash(hashKey(plain))
    expect(found).not.toBeNull()
    expect(found?.tier).toBe("admin")
  })

  test("findKeyByHash returns null for unknown hash", () => {
    const result = findKeyByHash("nonexistenthashvalue")
    expect(result).toBeNull()
  })

  test("revokeKey sets revoked_at and returns true", () => {
    const { row } = createKey({ tier: "client" })
    const result = revokeKey(row.id)
    expect(result).toBe(true)
    const updated = findKeyByHash(row.hash)
    expect(updated?.revoked_at).not.toBeNull()
  })

  test("revokeKey returns false on missing id", () => {
    expect(revokeKey("nonexistent-id")).toBe(false)
  })

  test("revokeKey is idempotent: revoked_at unchanged on second call", () => {
    const { row } = createKey({ tier: "client" })
    revokeKey(row.id)
    const firstRevoke = findKeyByHash(row.hash)?.revoked_at
    // Second call should be a no-op (returns false, revoked_at unchanged)
    const second = revokeKey(row.id)
    expect(second).toBe(false)
    const secondRevoke = findKeyByHash(row.hash)?.revoked_at
    expect(secondRevoke).toBe(firstRevoke)
  })

  test("countActiveAdminKeys returns 0 initially", () => {
    expect(countActiveAdminKeys()).toBe(0)
  })

  test("countActiveAdminKeys increments on admin key creation", () => {
    createKey({ tier: "admin" })
    createKey({ tier: "admin" })
    expect(countActiveAdminKeys()).toBe(2)
  })

  test("countActiveAdminKeys excludes revoked keys", () => {
    const { row } = createKey({ tier: "admin" })
    createKey({ tier: "admin" })
    revokeKey(row.id)
    expect(countActiveAdminKeys()).toBe(1)
  })

  test("countActiveAdminKeys excludes client-tier keys", () => {
    createKey({ tier: "client" })
    createKey({ tier: "client" })
    expect(countActiveAdminKeys()).toBe(0)
  })

  test("listKeys returns rows in stable created_at,id order", () => {
    createKey({ tier: "admin" })
    createKey({ tier: "client" })
    createKey({ tier: "admin" })
    const all = listKeys()
    expect(all).toHaveLength(3)
    // Verify order is deterministic (created_at ASC, then id ASC for ties)
    for (let i = 1; i < all.length; i++) {
      expect(all[i].created_at).toBeGreaterThanOrEqual(all[i - 1].created_at)
    }
  })

  test("createKey with explicit allowedModels stores correctly", () => {
    const { row } = createKey({
      tier: "client",
      allowedModels: ["gpt-4o", "claude-sonnet-4-5"],
    })
    const models = JSON.parse(row.allowed_models) as Array<string>
    expect(models).toEqual(["gpt-4o", "claude-sonnet-4-5"])
  })

  test("createKey rejects empty allowedModels array", () => {
    expect(() => createKey({ tier: "client", allowedModels: [] })).toThrow(
      "empty",
    )
  })

  test("createKey rejects URL-shaped model name in allowedModels", () => {
    expect(() =>
      createKey({ tier: "client", allowedModels: ["https://evil.com"] }),
    ).toThrow("Invalid model name")
  })

  test("rate_limit_override 0 is stored as null", () => {
    const { row } = createKey({ tier: "client", rateLimitOverride: 0 })
    expect(row.rate_limit_override).toBeNull()
  })

  test("rate_limit_override above 10x cap throws", () => {
    expect(() =>
      createKey({
        tier: "client",
        rateLimitOverride: 601,
        globalRateLimit: 60,
      }),
    ).toThrow("cap")
  })

  test("rate_limit_override exactly at 10x cap is accepted", () => {
    const { row } = createKey({
      tier: "client",
      rateLimitOverride: 600,
      globalRateLimit: 60,
    })
    expect(row.rate_limit_override).toBe(600)
  })

  test("negative rateLimitOverride throws", () => {
    expect(() => createKey({ tier: "client", rateLimitOverride: -1 })).toThrow(
      "non-negative integer",
    )
  })

  test("float rateLimitOverride throws", () => {
    expect(() => createKey({ tier: "client", rateLimitOverride: 0.5 })).toThrow(
      "non-negative integer",
    )
  })

  test("setDebugEnabled returns true when key exists", () => {
    const { row } = createKey({ tier: "client" })
    expect(setDebugEnabled(row.id, true)).toBe(true)
    const updated = findKeyByHash(row.hash)
    expect(updated?.debug_enabled).toBe(1)
  })

  test("setDebugEnabled returns false for missing key", () => {
    expect(setDebugEnabled("nonexistent-id", true)).toBe(false)
  })

  test("setDebugEnabled toggles back to false", () => {
    const { row } = createKey({ tier: "client", debugEnabled: true })
    setDebugEnabled(row.id, false)
    const updated = findKeyByHash(row.hash)
    expect(updated?.debug_enabled).toBe(0)
  })

  test("bootstrap idempotency: countActiveAdminKeys is the guard", () => {
    createKey({ tier: "admin" })
    expect(countActiveAdminKeys()).toBe(1)
    // A second createKey would work; the guard is in runBootstrap (which checks count > 0)
    // This test verifies the count function works as the idempotency sentinel
    createKey({ tier: "admin" })
    expect(countActiveAdminKeys()).toBe(2)
  })
})
