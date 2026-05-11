/**
 * bun:sqlite database setup with WAL, migration runner, and permission hardening.
 */
import { Database } from "bun:sqlite"
import consola from "consola"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { dbPath } from "./paths"

const MIGRATIONS_DIR = path.join(import.meta.dirname, "migrations")
const isWin = os.platform() === "win32"

export let db: Database | undefined

export function getDb(): Database {
  if (!db) throw new Error("Database not initialized — call initDb() first")
  return db
}

export function hardenDbFiles(dbFile: string): void {
  if (isWin) return
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      const stat = fs.statSync(f)
      if ((stat.mode & 0o777) > 0o600) {
        consola.warn(`DB file ${f} has permissions wider than 0600 — fixing`)
      }
      fs.chmodSync(f, 0o600)
    } catch {
      // file doesn't exist yet, skip
    }
  }
}

export function openDb(filePath?: string): Database {
  const file = filePath ?? dbPath()
  const prev = isWin ? undefined : process.umask(0o077)
  const database = new Database(file, { create: true })
  if (!isWin && prev !== undefined) process.umask(prev)

  // PRAGMAs must run outside any transaction
  database.run("PRAGMA journal_mode=WAL")
  database.run("PRAGMA synchronous=NORMAL")
  database.run("PRAGMA foreign_keys=ON")

  const row = database
    .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
    .get()
  if (row?.journal_mode !== "wal") {
    throw new Error(`Failed to set WAL mode (got: ${row?.journal_mode})`)
  }

  hardenDbFiles(file)
  return database
}

export function runMigrations(
  database: Database,
  migrationsDir?: string,
): void {
  const dir = migrationsDir ?? MIGRATIONS_DIR
  const row = database
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()
  let version = row?.user_version ?? 0

  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort()

  for (const file of files) {
    const num = Number.parseInt(file.slice(0, 3), 10)
    if (num <= version) continue

    const sql = fs.readFileSync(path.join(dir, file), "utf8")
    try {
      database.run("BEGIN")
      if (sql.trim()) database.run(sql)
      database.run(`PRAGMA user_version = ${num}`)
      database.run("COMMIT")
      version = num
      consola.info(`Applied migration: ${file}`)
    } catch (err) {
      database.run("ROLLBACK")
      throw new Error(
        `Migration failed [${file}]: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

export function initDb(filePath?: string, migrationsDir?: string): Database {
  const database = openDb(filePath)
  runMigrations(database, migrationsDir)
  db = database
  return database
}

export function closeDb(database: Database): void {
  database.close()
}

/** Reset module-level db state (test use only). */
export function resetDb(): void {
  db = undefined
}
