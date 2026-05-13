/**
 * Debug TTL sweeper: auto-disables debug mode on keys whose debug_expires_at
 * has passed. Called on startup and periodically (every 5 minutes).
 *
 * When debug is auto-disabled, an audit event is emitted for each key.
 */

import consola from "consola"

import { getDb } from "~/lib/db"

import { audit } from "./audit"

/** Sweep and disable expired debug keys. Returns the count of keys disabled. */
export function sweepExpiredDebugKeys(): number {
  const db = getDb()
  const now = Date.now()

  // Find keys to disable before updating (for audit logging)
  const expiredKeys = db
    .query<{ id: string }, [number]>(
      `SELECT id FROM keys
       WHERE debug_enabled = 1
         AND debug_expires_at IS NOT NULL
         AND debug_expires_at <= ?`,
    )
    .all(now)

  if (expiredKeys.length === 0) return 0

  // Bulk disable
  db.run(
    `UPDATE keys
     SET debug_enabled = 0, debug_expires_at = NULL
     WHERE debug_enabled = 1
       AND debug_expires_at IS NOT NULL
       AND debug_expires_at <= ?`,
    [now],
  )

  // Audit each disabled key
  for (const { id } of expiredKeys) {
    audit({
      actor_key_id: "__system__",
      actor_tier: "system",
      action: "key.debug_expired",
      target: id,
    })
    consola.info(`[debug-sweeper] Auto-disabled debug mode for key ${id}`)
  }

  return expiredKeys.length
}
