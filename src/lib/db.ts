/**
 * bun:sqlite database setup with WAL, migration runner, and permission hardening.
 */
import { Database } from "bun:sqlite"
import consola from "consola"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { dbPath } from "./paths"

// Resolved at load time; falls back gracefully when bundled / compiled.
// Callers may pass an explicit migrationsDir to runMigrations to override.
const MIGRATIONS_DIR = path.join(import.meta.dirname, "migrations")
const isWin = os.platform() === "win32"

// Module-level handle — not exported directly to prevent external mutation.
// Use getDb() / initDb() / closeDb() instead.
let _db: Database | undefined

export function getDb(): Database {
  if (!_db) throw new Error("Database not initialized — call initDb() first")
  return _db
}

// ---------------------------------------------------------------------------
// Permission hardening
// ---------------------------------------------------------------------------

export function hardenDbFiles(dbFile: string): void {
  if (isWin) return
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    let fd: number | undefined
    try {
      // lstat first — abort if the path is a symlink (symlink-clobber guard)
      const lstat = fs.lstatSync(f)
      if (lstat.isSymbolicLink()) {
        consola.warn(`DB path ${f} is a symlink — refusing to chmod`)
        continue
      }
      if ((lstat.mode & 0o777) > 0o600) {
        consola.warn(`DB file ${f} has permissions wider than 0600 — fixing`)
      }
      // fchmod on an open fd to avoid TOCTOU between lstat and chmod
      fd = fs.openSync(f, fs.constants.O_RDONLY)
      fs.fchmodSync(fd, 0o600)
    } catch (err) {
      // file doesn't exist yet, or open failed — skip
      const code = (err as NodeJS.ErrnoException).code
      if (code !== "ENOENT") {
        consola.warn(`hardenDbFiles: could not harden ${f}: ${String(err)}`)
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export function openDb(filePath?: string): Database {
  const file = filePath ?? dbPath()

  // Check for symlink at the DB path before SQLite opens it
  try {
    const lstat = fs.lstatSync(file)
    if (lstat.isSymbolicLink()) {
      throw new Error(
        `DB path ${file} is a symlink — refusing to open (symlink attack prevention)`,
      )
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ENOENT is fine — file will be created; re-throw anything else
    if (code !== "ENOENT") throw err
  }

  // umask(077) ensures a newly created DB file gets mode 0600.
  // Must be restored in a finally block in case Database() throws.
  const prev = isWin ? undefined : process.umask(0o077)
  let database: Database
  try {
    database = new Database(file, { create: true })
  } finally {
    if (!isWin && prev !== undefined) process.umask(prev)
  }

  // PRAGMAs MUST run outside any transaction (PRAGMA journal_mode is a no-op
  // inside BEGIN).
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

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

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
    if (!Number.isInteger(num) || num <= version) continue

    const sql = fs.readFileSync(path.join(dir, file), "utf8")
    try {
      // BEGIN EXCLUSIVE acquires the write lock immediately, preventing
      // SQLITE_BUSY mid-migration when another writer holds a reserved lock.
      database.run("BEGIN EXCLUSIVE")
      // run() in bun:sqlite handles multiple semicolon-separated statements.
      // exec() is deprecated — use run() for the full SQL string.
      // Strip line comments before testing for emptiness: a comment-only file
      // (e.g. placeholder migrations) should be treated as a no-op so that
      // bun:sqlite does not throw "Query contained no valid SQL statement".
      const sqlNoComments = sql.replaceAll(/--[^\n]*/g, "")
      if (sqlNoComments.trim()) database.run(sql)
      // PRAGMA user_version cannot use a bound parameter — interpolate the
      // validated integer directly.
      database.run(`PRAGMA user_version = ${num}`)
      database.run("COMMIT")
      version = num
      consola.info(`Applied migration: ${file}`)
    } catch (err) {
      try {
        database.run("ROLLBACK")
      } catch {
        // ignore rollback error
      }
      throw new Error(`Migration failed [${file}]`, { cause: err })
    }
  }

  // Re-harden after migrations (WAL/SHM files are created on first write)
  // filePath is not available here; caller (initDb) calls hardenDbFiles again.
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export function initDb(filePath?: string, migrationsDir?: string): Database {
  const database = openDb(filePath)
  runMigrations(database, migrationsDir)
  // Re-harden now that WAL/SHM may exist after the first write
  hardenDbFiles(filePath ?? dbPath())
  _db = database
  return database
}

export function closeDb(database: Database): void {
  database.close()
  // Nullify module-level handle so getDb() gives a clear error rather than
  // returning a closed (dangling) Database object.
  if (database === _db) _db = undefined
}

/** Reset module-level db state (test use only). Close the handle first. */
export function resetDb(): void {
  _db = undefined
}
