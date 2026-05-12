/**
 * Server-side session management backed by the SQLite `sessions` table.
 *
 * Sessions have an 8-hour sliding window; each authenticated request extends
 * the expiry. Session IDs are 32 random bytes (256-bit entropy) encoded as
 * hex strings.
 */

import crypto from "node:crypto"

import { getDb } from "~/lib/db"

import { generateCsrfToken } from "./csrf"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string
  key_id: string
  csrf_token: string
  created_at: number
  expires_at: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Session lifetime: 8 hours in milliseconds */
export const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000

export const SESSION_COOKIE = "sid"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newSessionId(): string {
  return crypto.randomBytes(32).toString("hex")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create a new session for the given key and return the session row. */
export function createSession(keyId: string): SessionRow {
  const db = getDb()
  const id = newSessionId()
  const now = Date.now()
  const expiresAt = now + SESSION_LIFETIME_MS
  const csrfToken = generateCsrfToken(id)

  db.run(
    `INSERT INTO sessions (id, key_id, csrf_token, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, keyId, csrfToken, now, expiresAt],
  )

  return {
    id,
    key_id: keyId,
    csrf_token: csrfToken,
    created_at: now,
    expires_at: expiresAt,
  }
}

/** Look up an active session by id, sliding its expiry. Returns null if not found or expired. */
export function getSession(sessionId: string): SessionRow | null {
  const db = getDb()
  const now = Date.now()

  const row = db
    .query<SessionRow, [string, number]>(
      `SELECT id, key_id, csrf_token, created_at, expires_at
       FROM sessions WHERE id = ? AND expires_at > ?`,
    )
    .get(sessionId, now)

  if (!row) return null

  // Slide the expiry window
  const newExpiry = now + SESSION_LIFETIME_MS
  db.run(`UPDATE sessions SET expires_at = ? WHERE id = ?`, [
    newExpiry,
    sessionId,
  ])

  return { ...row, expires_at: newExpiry }
}

/** Destroy a session (logout). */
export function deleteSession(sessionId: string): void {
  getDb().run(`DELETE FROM sessions WHERE id = ?`, [sessionId])
}

/** Sweep expired sessions (called on startup / periodically). */
export function purgeExpiredSessions(): void {
  getDb().run(`DELETE FROM sessions WHERE expires_at <= ?`, [Date.now()])
}

/** Build the Set-Cookie header value for the session cookie. */
export function sessionCookieValue(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=${SESSION_LIFETIME_MS / 1000}`
}

/** Build a Set-Cookie value that clears the session cookie. */
export function clearSessionCookieValue(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0`
}

/** Extract the session id from the Cookie header. */
export function extractSessionId(
  cookieHeader: string | undefined,
): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name.trim() === SESSION_COOKIE) return rest.join("=").trim()
  }
  return undefined
}
