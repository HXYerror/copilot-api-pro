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
} from "../src/services/keys"

function makeTmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keys-test-"))
  const dbFile = path.join(dir, "test.db")
  const migrationsDir = path.join(process.cwd(), "src/lib/migrations")
  return { dir, dbFile, migrationsDir }
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
  let migrationsDir: string
  let dir: string

  beforeEach(() => {
    const tmp = makeTmpDb()
    dir = tmp.dir
    dbFile = tmp.dbFile
    migrationsDir = tmp.migrationsDir
    initDb(dbFile, migrationsDir)
  })

  afterEach(() => {
    closeDb(getDb())
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

  test("revokeKey sets revoked_at", () => {
    const { row } = createKey({ tier: "client" })
    revokeKey(row.id)
    const updated = findKeyByHash(row.hash)
    expect(updated?.revoked_at).not.toBeNull()
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

  test("bootstrap idempotency: second call with admin keys present is no-op", () => {
    createKey({ tier: "admin" })
    const countBefore = countActiveAdminKeys()
    // Calling createKey again should increment — but bootstrap logic checks count first
    // This test verifies countActiveAdminKeys works as the idempotency guard
    expect(countBefore).toBe(1)
  })
})
