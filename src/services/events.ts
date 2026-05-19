/**
 * Telemetry events data layer (issue #34).
 *
 * Pure data access for the `events` table created by migration 005.  All
 * mutators are best-effort: insert failures are logged with consola.error
 * but never thrown to callers, so a broken telemetry path never breaks the
 * proxied request.
 */

import consola from "consola"

import { getDb } from "~/lib/db"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventRow {
  id: number
  ts: number
  key_id: string
  model: string
  upstream_model: string
  prompt_tokens: number | null
  completion_tokens: number | null
  status: number
  latency_ms: number
  error: string | null
  usage_unknown: number
  /**
   * Anthropic thinking level extracted from the request body, normalised
   * client-side to a short string ("auto" / "think-hard" / "think-harder" /
   * "ultrathink" / "custom:NNN"). NULL when the request didn't include a
   * `thinking` field (the common case for non-Claude calls).
   */
  thinking_level: string | null
  /**
   * Copilot cache_read tokens (prompt-cache hits).  Sourced from
   * copilot_usage.token_details[token_type=cache_read].  NULL when the
   * upstream didn't report it.
   */
  cache_read_tokens: number | null
  /** Copilot cache_write tokens (prompt-cache creations). */
  cache_creation_tokens: number | null
  /** Reasoning/thinking tokens (output_tokens_details.reasoning_tokens).
   *  Only OpenAI /responses exposes this; Anthropic stays NULL. */
  reasoning_tokens: number | null
}

/** Insert-shape: callers don't supply `id` (auto-increment). */
export interface NewEvent {
  ts: number
  key_id: string
  model: string
  upstream_model: string
  prompt_tokens: number | null
  completion_tokens: number | null
  status: number
  latency_ms: number
  error: string | null
  usage_unknown: number
  thinking_level: string | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
  reasoning_tokens: number | null
}

// ---------------------------------------------------------------------------
// recordEvent — best-effort insert
// ---------------------------------------------------------------------------

/**
 * Insert one event row. Best-effort: any error is logged and swallowed so a
 * broken DB write cannot fail the proxied request the middleware just served.
 */
export function recordEvent(row: NewEvent): void {
  try {
    getDb().run(
      `INSERT INTO events
         (ts, key_id, model, upstream_model,
          prompt_tokens, completion_tokens,
          status, latency_ms, error, usage_unknown,
          thinking_level, cache_read_tokens, cache_creation_tokens,
          reasoning_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.ts,
        row.key_id,
        row.model,
        row.upstream_model,
        row.prompt_tokens,
        row.completion_tokens,
        row.status,
        row.latency_ms,
        row.error,
        row.usage_unknown,
        row.thinking_level,
        row.cache_read_tokens,
        row.cache_creation_tokens,
        row.reasoning_tokens,
      ],
    )
  } catch (err) {
    consola.error(`[telemetry] recordEvent failed (continuing): ${String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Counts + retention
// ---------------------------------------------------------------------------

/** Total number of events stored. */
export function countEvents(): number {
  const row = getDb()
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events")
    .get()
  return row?.n ?? 0
}

/**
 * Delete rows older than `cutoffMs`.  Chunked into batches of 1000 to avoid
 * holding the write lock too long; yields to the event loop between batches
 * so an unrelated request handler can interleave.
 *
 * Returns the total number of rows deleted.
 */
export async function purgeEventsOlderThan(cutoffMs: number): Promise<number> {
  const db = getDb()
  let totalDeleted = 0

  // bun:sqlite supports `DELETE … LIMIT` only when compiled with the optional
  // limit flag, but the bundled build does. Use a subselect for portability.
  const stmt = db.prepare(
    `DELETE FROM events
     WHERE id IN (
       SELECT id FROM events WHERE ts < ? ORDER BY ts LIMIT 1000
     )`,
  )

  while (true) {
    const result = stmt.run(cutoffMs)
    const deleted = result.changes
    totalDeleted += deleted
    if (deleted < 1000) break
    // Yield between batches so the event loop can service requests
    await new Promise((resolve) => {
      setImmediate(resolve)
    })
  }

  return totalDeleted
}
