import consola from "consola";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import fs$1 from "node:fs";
import { Database } from "bun:sqlite";

//#region src/lib/paths.ts
function resolveXdgDataHome() {
	const xdg = process.env.XDG_DATA_HOME;
	if (xdg !== void 0 && path.isAbsolute(xdg)) return xdg;
	return path.join(os.homedir(), ".local", "share");
}
const XDG_DATA_HOME = resolveXdgDataHome();
const APP_DIR = path.join(XDG_DATA_HOME, "copilot-api-pro");
const GITHUB_TOKEN_PATH = path.join(APP_DIR, "github_token");
const CONFIG_PATH = path.join(APP_DIR, "config.json");
const DB_PATH = path.join(APP_DIR, "copilot-api.db");
const TRACES_DIR = path.join(APP_DIR, "traces");
const LEARNED_BETA_PATH = path.join(APP_DIR, "learned-unsupported-beta.txt");
const PATHS = {
	APP_DIR,
	GITHUB_TOKEN_PATH,
	CONFIG_PATH,
	DB_PATH,
	TRACES_DIR,
	LEARNED_BETA_PATH
};
function configPath() {
	return CONFIG_PATH;
}
function dbPath() {
	return DB_PATH;
}
/**
* Per-day trace JSONL files live here. The directory is created lazily by
* the trace-writer with mode 0o700 (this matches the parent APP_DIR
* permissions) so test environments that never write a trace don't
* accidentally create the directory just by importing this module.
*/
function tracesDir() {
	return TRACES_DIR;
}
async function ensurePaths() {
	await fs.mkdir(PATHS.APP_DIR, { recursive: true });
	await ensureFile(PATHS.GITHUB_TOKEN_PATH);
}
async function ensureFile(filePath) {
	try {
		await fs.access(filePath, fs.constants.W_OK);
	} catch {
		await fs.writeFile(filePath, "");
		await fs.chmod(filePath, 384);
	}
}

//#endregion
//#region src/lib/db.ts
const MIGRATIONS_DIR = path.join(import.meta.dirname, "migrations");
const isWin = os.platform() === "win32";
let _db;
function getDb() {
	if (!_db) throw new Error("Database not initialized — call initDb() first");
	return _db;
}
function hardenDbFiles(dbFile) {
	if (isWin) return;
	for (const f of [
		dbFile,
		`${dbFile}-wal`,
		`${dbFile}-shm`
	]) {
		let fd;
		try {
			const lstat = fs$1.lstatSync(f);
			if (lstat.isSymbolicLink()) {
				consola.warn(`DB path ${f} is a symlink — refusing to chmod`);
				continue;
			}
			if ((lstat.mode & 511) > 384) consola.warn(`DB file ${f} has permissions wider than 0600 — fixing`);
			fd = fs$1.openSync(f, fs$1.constants.O_RDONLY);
			fs$1.fchmodSync(fd, 384);
		} catch (err) {
			if (err.code !== "ENOENT") consola.warn(`hardenDbFiles: could not harden ${f}: ${String(err)}`);
		} finally {
			if (fd !== void 0) fs$1.closeSync(fd);
		}
	}
}
function openDb(filePath) {
	const file = filePath ?? dbPath();
	try {
		if (fs$1.lstatSync(file).isSymbolicLink()) throw new Error(`DB path ${file} is a symlink — refusing to open (symlink attack prevention)`);
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	const prev = isWin ? void 0 : process.umask(63);
	let database;
	try {
		database = new Database(file, { create: true });
	} finally {
		if (!isWin && prev !== void 0) process.umask(prev);
	}
	database.run("PRAGMA journal_mode=WAL");
	database.run("PRAGMA synchronous=NORMAL");
	database.run("PRAGMA foreign_keys=ON");
	const row = database.query("PRAGMA journal_mode").get();
	if (row?.journal_mode !== "wal") throw new Error(`Failed to set WAL mode (got: ${row?.journal_mode})`);
	hardenDbFiles(file);
	return database;
}
function runMigrations(database, migrationsDir) {
	const dir = migrationsDir ?? MIGRATIONS_DIR;
	let version = database.query("PRAGMA user_version").get()?.user_version ?? 0;
	const files = fs$1.readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
	for (const file of files) {
		const num = Number.parseInt(file.slice(0, 3), 10);
		if (!Number.isInteger(num) || num <= version) continue;
		const sql = fs$1.readFileSync(path.join(dir, file), "utf8");
		try {
			database.run("BEGIN EXCLUSIVE");
			if (sql.replaceAll(/--[^\n]*/g, "").trim()) database.run(sql);
			database.run(`PRAGMA user_version = ${num}`);
			database.run("COMMIT");
			version = num;
			consola.info(`Applied migration: ${file}`);
		} catch (err) {
			try {
				database.run("ROLLBACK");
			} catch {}
			throw new Error(`Migration failed [${file}]`, { cause: err });
		}
	}
}
function initDb(filePath, migrationsDir) {
	const database = openDb(filePath);
	runMigrations(database, migrationsDir);
	hardenDbFiles(filePath ?? dbPath());
	_db = database;
	return database;
}
function closeDb(database) {
	database.close();
	if (database === _db) _db = void 0;
}

//#endregion
//#region src/services/keys.ts
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const MODEL_RE = /^\w[\w.:-]*$/;
/** 24 hours in milliseconds — the debug mode TTL */
const DEBUG_TTL_MS = 1440 * 60 * 1e3;
/**
* Generate a new API key: "sk-cap-" + 52 base32 chars = 59 chars total.
* Uses 33 random bytes = 264 bits of entropy; 264 / 5 = 52 full 5-bit groups
* (260 bits encoded) with 4 bits remaining — no zero-padding required.
*/
function generateKey() {
	const bytes = crypto.randomBytes(33);
	let result = "";
	let buffer = 0;
	let bitsLeft = 0;
	for (const byte of bytes) {
		buffer = buffer << 8 | byte;
		bitsLeft += 8;
		while (bitsLeft >= 5) {
			bitsLeft -= 5;
			result += BASE32_CHARS[buffer >> bitsLeft & 31];
		}
	}
	return `sk-cap-${result.slice(0, 52)}`;
}
/**
* Hash a plain key to SHA-256 hex for storage.
*
* Unsalted SHA-256 is intentional: API keys have ≥260 bits of random entropy
* so dictionary attacks and rainbow tables are meaningless.
* Do NOT use this function for user-chosen secrets (passwords, PINs, etc.).
*
* The plain key value must NEVER be written to the DB.
*/
function hashKey(plain) {
	return crypto.createHash("sha256").update(plain).digest("hex");
}
/** Validate allowedModels: non-empty array of valid model identifiers or "*" */
function validateAllowedModels(models) {
	if (models === void 0) return;
	if (models.length === 0) throw new Error("allowedModels must not be empty; use [\"*\"] for unrestricted access");
	for (const m of models) if (m !== "*" && !MODEL_RE.test(m)) throw new Error(`Invalid model name in allowedModels: "${m}". Must match /^\\w[\\w.:-]*$/ or be "*"`);
}
/**
* Compute the rate-limit integer to store: null means "inherit global".
* Positive values are capped at 10× globalDefault.
*/
function resolveRateLimit(override, globalDefault) {
	if (override === void 0 || override === 0) return null;
	if (!Number.isInteger(override) || override < 0) throw new Error("rateLimitOverride must be a non-negative integer");
	const cap = globalDefault * 10;
	if (override > cap) throw new Error(`rate_limit_override ${override} exceeds cap ${cap} (10× global default ${globalDefault})`);
	return override;
}
function createKey(options) {
	validateAllowedModels(options.allowedModels);
	const db = getDb();
	const plain = generateKey();
	const hash = hashKey(plain);
	const id = crypto.randomUUID();
	const now = Date.now();
	const rateLimit = resolveRateLimit(options.rateLimitOverride, options.globalRateLimit ?? 60);
	const allowedModels = JSON.stringify(options.allowedModels ?? ["*"]);
	const debugEnabled = options.debugEnabled ? 1 : 0;
	const debugExpiresAt = debugEnabled ? now + DEBUG_TTL_MS : null;
	db.run(`INSERT INTO keys (id, hash, tier, label, allowed_models, rate_limit_override, debug_enabled, debug_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
		id,
		hash,
		options.tier,
		options.label ?? null,
		allowedModels,
		rateLimit,
		debugEnabled,
		debugExpiresAt,
		now
	]);
	const row = {
		id,
		hash,
		tier: options.tier,
		label: options.label ?? null,
		allowed_models: allowedModels,
		rate_limit_override: rateLimit,
		debug_enabled: debugEnabled,
		debug_expires_at: debugExpiresAt,
		created_at: now,
		revoked_at: null
	};
	return {
		plain,
		row
	};
}
/**
* Revoke a key by ID.
* Idempotent: only sets revoked_at if the key is currently active.
* Returns true if the key was revoked, false if not found or already revoked.
*/
function revokeKey(id) {
	return getDb().run(`UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [Date.now(), id]).changes === 1;
}
function listKeys(limit = 50, offset = 0) {
	const db = getDb();
	const total = db.query("SELECT COUNT(*) as n FROM keys").get()?.n ?? 0;
	return {
		rows: db.query("SELECT * FROM keys ORDER BY created_at DESC, id LIMIT ? OFFSET ?").all(limit, offset),
		total
	};
}
function findKeyById(id) {
	return getDb().query("SELECT * FROM keys WHERE id = ?").get(id) ?? null;
}
function findKeyByHash(hash) {
	return getDb().query("SELECT * FROM keys WHERE hash = ?").get(hash) ?? null;
}
function countActiveAdminKeys() {
	return getDb().query("SELECT COUNT(*) as n FROM keys WHERE tier = 'admin' AND revoked_at IS NULL").get()?.n ?? 0;
}
/** Count keys that are currently in active debug mode (TTL not yet expired). */
function countActiveDebugKeys() {
	return getDb().query(`SELECT COUNT(*) as n FROM keys
       WHERE debug_enabled = 1
         AND revoked_at IS NULL
         AND (debug_expires_at IS NULL OR debug_expires_at > ?)`).get(Date.now())?.n ?? 0;
}
/**
* Single source of truth for "is debug effectively active right now".
* `debug_enabled = 1` alone is not enough: the row may be revoked, or the
* TTL may have passed but the periodic sweeper has not yet run.
*/
function isDebugActive(row, now = Date.now()) {
	if (row.debug_enabled !== 1) return false;
	if (row.revoked_at !== null) return false;
	if (row.debug_expires_at !== null && row.debug_expires_at <= now) return false;
	return true;
}
/**
* Set debug mode on a key with a 24h TTL.
* Returns true if the key was found and updated, false otherwise.
*/
function setDebugEnabled(id, enabled) {
	const debugExpiresAt = enabled ? Date.now() + DEBUG_TTL_MS : null;
	return getDb().run(`UPDATE keys SET debug_enabled = ?, debug_expires_at = ? WHERE id = ?`, [
		enabled ? 1 : 0,
		debugExpiresAt,
		id
	]).changes === 1;
}
/**
* Update a key's scope (allowed_models, rate_limit_override).
* Tier is immutable post-create.
*/
function updateKeyScope(id, allowedModels, rateLimitOverride) {
	validateAllowedModels(allowedModels);
	return getDb().run(`UPDATE keys SET allowed_models = ?, rate_limit_override = ? WHERE id = ? AND revoked_at IS NULL`, [
		JSON.stringify(allowedModels),
		rateLimitOverride,
		id
	]).changes === 1;
}

//#endregion
export { DEBUG_TTL_MS, PATHS, closeDb, configPath, countActiveAdminKeys, countActiveDebugKeys, createKey, ensurePaths, findKeyByHash, findKeyById, generateKey, getDb, hashKey, initDb, isDebugActive, listKeys, revokeKey, setDebugEnabled, tracesDir, updateKeyScope };