import crypto from "node:crypto"

import { getDb } from "~/lib/db"

// Row type from DB (full — includes hash for internal auth use)
export interface KeyRow {
  id: string
  hash: string
  tier: "admin" | "client"
  label: string | null
  allowed_models: string // JSON array string e.g. '["*"]'
  rate_limit_override: number | null
  debug_enabled: number // 0 | 1
  debug_expires_at: number | null // unix ms; NULL if debug is off or no TTL
  created_at: number // unix timestamp ms
  revoked_at: number | null
}

// Base32 alphabet (RFC 4648, no padding)
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

// Regex that mirrors the upstream model-name validation in config-store (SSRF prevention)
const MODEL_RE = /^\w[\w.:-]*$/

/** 24 hours in milliseconds — the debug mode TTL */
export const DEBUG_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Generate a new API key: "sk-cap-" + 52 base32 chars = 59 chars total.
 * Uses 33 random bytes = 264 bits of entropy; 264 / 5 = 52 full 5-bit groups
 * (260 bits encoded) with 4 bits remaining — no zero-padding required.
 */
export function generateKey(): string {
  const bytes = crypto.randomBytes(33)
  // Encode to base32: each 5 bits → one char; 33 bytes = 264 bits → exactly 52 chars
  let result = ""
  let buffer = 0
  let bitsLeft = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bitsLeft += 8
    while (bitsLeft >= 5) {
      bitsLeft -= 5
      result += BASE32_CHARS[(buffer >> bitsLeft) & 0x1f]
    }
  }
  // 33 bytes yields exactly 52 chars; the slice+guard is belt-and-suspenders
  return `sk-cap-${result.slice(0, 52)}`
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
export function hashKey(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex")
}

/** Validate allowedModels: non-empty array of valid model identifiers or "*" */
function validateAllowedModels(models: Array<string> | undefined): void {
  if (models === undefined) return
  if (models.length === 0) {
    throw new Error(
      'allowedModels must not be empty; use ["*"] for unrestricted access',
    )
  }
  for (const m of models) {
    if (m !== "*" && !MODEL_RE.test(m)) {
      throw new Error(
        `Invalid model name in allowedModels: "${m}". Must match /^\\w[\\w.:-]*$/ or be "*"`,
      )
    }
  }
}

/**
 * Compute the rate-limit integer to store: null means "inherit global".
 * Positive values are capped at 10× globalDefault.
 */
function resolveRateLimit(
  override: number | undefined,
  globalDefault: number,
): number | null {
  if (override === undefined || override === 0) return null
  if (!Number.isInteger(override) || override < 0) {
    throw new Error("rateLimitOverride must be a non-negative integer")
  }
  const cap = globalDefault * 10
  if (override > cap) {
    throw new Error(
      `rate_limit_override ${override} exceeds cap ${cap} (10× global default ${globalDefault})`,
    )
  }
  return override
}

export function createKey(options: {
  tier: "admin" | "client"
  label?: string
  allowedModels?: Array<string>
  rateLimitOverride?: number
  debugEnabled?: boolean
  globalRateLimit?: number // for cap enforcement; defaults to 60 if not provided
}): { plain: string; row: KeyRow } {
  validateAllowedModels(options.allowedModels)

  const db = getDb()
  const plain = generateKey()
  const hash = hashKey(plain)
  const id = crypto.randomUUID()
  const now = Date.now()

  const rateLimit = resolveRateLimit(
    options.rateLimitOverride,
    options.globalRateLimit ?? 60,
  )

  const allowedModels = JSON.stringify(options.allowedModels ?? ["*"])
  const debugEnabled = options.debugEnabled ? 1 : 0
  const debugExpiresAt = debugEnabled ? now + DEBUG_TTL_MS : null

  db.run(
    `INSERT INTO keys (id, hash, tier, label, allowed_models, rate_limit_override, debug_enabled, debug_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      hash,
      options.tier,
      options.label ?? null,
      allowedModels,
      rateLimit,
      debugEnabled,
      debugExpiresAt,
      now,
    ],
  )

  const row: KeyRow = {
    id,
    hash,
    tier: options.tier,
    label: options.label ?? null,
    allowed_models: allowedModels,
    rate_limit_override: rateLimit,
    debug_enabled: debugEnabled,
    debug_expires_at: debugExpiresAt,
    created_at: now,
    revoked_at: null,
  }

  return { plain, row }
}

/**
 * Revoke a key by ID.
 * Idempotent: only sets revoked_at if the key is currently active.
 * Returns true if the key was revoked, false if not found or already revoked.
 */
export function revokeKey(id: string): boolean {
  const result = getDb().run(
    `UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    [Date.now(), id],
  )
  return result.changes === 1
}

export function listKeys(
  limit = 50,
  offset = 0,
): { rows: Array<KeyRow>; total: number } {
  const db = getDb()
  const countRow = db
    .query<{ n: number }, []>("SELECT COUNT(*) as n FROM keys")
    .get()
  const total = countRow?.n ?? 0
  const rows = db
    .query<
      KeyRow,
      [number, number]
    >("SELECT * FROM keys ORDER BY created_at DESC, id LIMIT ? OFFSET ?")
    .all(limit, offset)
  return { rows, total }
}

export function findKeyById(id: string): KeyRow | null {
  return (
    getDb().query<KeyRow, [string]>("SELECT * FROM keys WHERE id = ?").get(id)
    ?? null
  )
}

export function findKeyByHash(hash: string): KeyRow | null {
  return (
    getDb()
      .query<KeyRow, [string]>("SELECT * FROM keys WHERE hash = ?")
      .get(hash) ?? null
  )
}

export function countActiveAdminKeys(): number {
  const row = getDb()
    .query<
      { n: number },
      []
    >("SELECT COUNT(*) as n FROM keys WHERE tier = 'admin' AND revoked_at IS NULL")
    .get()
  return row?.n ?? 0
}

/** Count keys that currently have debug_enabled=1 and are not revoked. */
export function countActiveDebugKeys(): number {
  const row = getDb()
    .query<
      { n: number },
      []
    >("SELECT COUNT(*) as n FROM keys WHERE debug_enabled = 1 AND revoked_at IS NULL")
    .get()
  return row?.n ?? 0
}

/**
 * Set debug mode on a key with a 24h TTL.
 * Returns true if the key was found and updated, false otherwise.
 */
export function setDebugEnabled(id: string, enabled: boolean): boolean {
  const debugExpiresAt = enabled ? Date.now() + DEBUG_TTL_MS : null
  const result = getDb().run(
    `UPDATE keys SET debug_enabled = ?, debug_expires_at = ? WHERE id = ?`,
    [enabled ? 1 : 0, debugExpiresAt, id],
  )
  return result.changes === 1
}

/**
 * Update a key's scope (allowed_models, rate_limit_override).
 * Tier is immutable post-create.
 */
export function updateKeyScope(
  id: string,
  allowedModels: Array<string>,
  rateLimitOverride: number | null,
): boolean {
  validateAllowedModels(allowedModels)
  const result = getDb().run(
    `UPDATE keys SET allowed_models = ?, rate_limit_override = ? WHERE id = ? AND revoked_at IS NULL`,
    [JSON.stringify(allowedModels), rateLimitOverride, id],
  )
  return result.changes === 1
}
