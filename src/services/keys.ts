import crypto from "node:crypto"

import { getDb } from "~/lib/db"

// Row type from DB
export interface KeyRow {
  id: string
  hash: string
  tier: "admin" | "client"
  label: string | null
  allowed_models: string // JSON array string e.g. '["*"]'
  rate_limit_override: number | null
  debug_enabled: number // 0 | 1
  created_at: number // unix timestamp ms
  revoked_at: number | null
}

// Base32 alphabet (RFC 4648, no padding)
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/**
 * Generate a new API key: "sk-cap-" + 52 base32 chars = 59 chars total.
 * Uses 32 random bytes = 256 bits entropy.
 */
export function generateKey(): string {
  const bytes = crypto.randomBytes(32)
  // Encode to base32: each 5 bits → one char; 32 bytes = 256 bits = 51.2 → pad to 52 chars
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
  // Pad to exactly 52 chars if needed
  while (result.length < 52) {
    result += BASE32_CHARS[0]
  }
  return `sk-cap-${result.slice(0, 52)}`
}

/**
 * Hash a plain key to sha256 hex for storage.
 * The plain key value must NEVER be written to the DB.
 */
export function hashKey(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex")
}

export function createKey(options: {
  tier: "admin" | "client"
  label?: string
  allowedModels?: Array<string>
  rateLimitOverride?: number
  debugEnabled?: boolean
  globalRateLimit?: number // for cap enforcement
}): { plain: string; row: KeyRow } {
  const db = getDb()
  const plain = generateKey()
  const hash = hashKey(plain)
  const id = crypto.randomUUID()
  const now = Date.now()

  // Rate limit override safety: 0/negative = use default (null).
  // Hard cap at 10× global default; reject above cap.
  let rateLimit: number | null = null
  if (
    options.rateLimitOverride !== undefined
    && options.rateLimitOverride > 0
  ) {
    const globalDefault = options.globalRateLimit ?? 60
    const cap = globalDefault * 10
    if (options.rateLimitOverride > cap) {
      throw new Error(
        `rate_limit_override ${options.rateLimitOverride} exceeds cap ${cap} (10× global default ${globalDefault})`,
      )
    }
    rateLimit = options.rateLimitOverride
  }

  const allowedModels = JSON.stringify(options.allowedModels ?? ["*"])

  db.run(
    `INSERT INTO keys (id, hash, tier, label, allowed_models, rate_limit_override, debug_enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      hash,
      options.tier,
      options.label ?? null,
      allowedModels,
      rateLimit,
      options.debugEnabled ? 1 : 0,
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
    debug_enabled: options.debugEnabled ? 1 : 0,
    created_at: now,
    revoked_at: null,
  }

  return { plain, row }
}

export function revokeKey(id: string): void {
  getDb().run(`UPDATE keys SET revoked_at = ? WHERE id = ?`, [Date.now(), id])
}

export function listKeys(): Array<KeyRow> {
  return getDb()
    .query<KeyRow, []>("SELECT * FROM keys ORDER BY created_at")
    .all()
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

export function setDebugEnabled(id: string, enabled: boolean): void {
  getDb().run(`UPDATE keys SET debug_enabled = ? WHERE id = ?`, [
    enabled ? 1 : 0,
    id,
  ])
}
