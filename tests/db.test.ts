import type { Database } from "bun:sqlite"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { getDb, openDb, resetDb, runMigrations } from "../src/lib/db"

const isWin = os.platform() === "win32"

function makeTmpDb(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-test-"))
  const file = path.join(dir, "test.db")
  return { dir, file }
}

function makeTmpMigrations(sqls: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-test-"))
  for (const [name, content] of Object.entries(sqls)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

describe("openDb", () => {
  let database: Database | undefined

  afterEach(() => {
    database?.close()
  })

  it("creates the DB file and sets WAL mode", () => {
    const { file } = makeTmpDb()
    database = openDb(file)

    expect(fs.existsSync(file)).toBe(true)

    const row = database
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get()
    expect(row?.journal_mode).toBe("wal")
  })

  it("sets file permissions to 0600 on non-Windows", () => {
    if (isWin) return

    const { file } = makeTmpDb()
    database = openDb(file)

    const stat = fs.statSync(file)
    expect(stat.mode & 0o777).toBe(0o600)
  })
})

describe("runMigrations", () => {
  let database: Database | undefined

  beforeEach(() => {
    const { file } = makeTmpDb()
    database = openDb(file)
  })

  afterEach(() => {
    database?.close()
  })

  it("starts at user_version 0 on a fresh DB", () => {
    if (!database) throw new Error("database not initialized")
    const row = database
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()
    expect(row?.user_version).toBe(0)
  })

  it("applies migrations and bumps user_version", () => {
    if (!database) throw new Error("database not initialized")
    const migrationsDir = makeTmpMigrations({
      "001_init.sql": "CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY);",
      "002_add.sql": "CREATE TABLE IF NOT EXISTS t2 (id INTEGER PRIMARY KEY);",
    })

    runMigrations(database, migrationsDir)

    const row = database
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()
    expect(row?.user_version).toBe(2)
  })

  it("is idempotent — calling twice does not re-apply migrations", () => {
    if (!database) throw new Error("database not initialized")
    const migrationsDir = makeTmpMigrations({
      "001_init.sql": "CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY);",
    })

    runMigrations(database, migrationsDir)
    runMigrations(database, migrationsDir) // second call — should be a no-op

    const row = database
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()
    expect(row?.user_version).toBe(1)
  })

  it("applies all statements in a multi-statement migration file", () => {
    if (!database) throw new Error("database not initialized")
    const migrationsDir = makeTmpMigrations({
      "001_multi.sql":
        "CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY);\n"
        + "CREATE TABLE IF NOT EXISTS t2 (id INTEGER PRIMARY KEY);",
    })

    runMigrations(database, migrationsDir)

    // Both tables must exist — verifies that run() processes all statements
    // in a multi-statement SQL file (not just the first).
    const tables = database
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
    expect(tables.map((r) => r.name)).toContain("t1")
    expect(tables.map((r) => r.name)).toContain("t2")
  })

  it("throws with filename in error on corrupt SQL", () => {
    if (!database) throw new Error("database not initialized")
    const migrationsDir = makeTmpMigrations({
      "001_bad.sql": "THIS IS NOT VALID SQL !!!",
    })

    expect(() => runMigrations(database as Database, migrationsDir)).toThrow(
      "001_bad.sql",
    )
  })
})

describe("getDb", () => {
  it("throws if initDb has not been called", () => {
    resetDb()
    expect(() => getDb()).toThrow("not initialized")
  })
})
