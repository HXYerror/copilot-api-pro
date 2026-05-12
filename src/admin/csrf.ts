/**
 * CSRF double-submit protection utilities.
 *
 * Pattern: a `csrf` cookie (HMAC-bound to the session id) is sent on every
 * mutating request alongside an `X-CSRF-Token` header (or a hidden form
 * field). The server verifies both the Sec-Fetch-Site header and the token.
 *
 * The token is: base64url(HMAC-SHA256(sessionId, secret))
 * The secret is derived once per process from crypto.randomBytes(32).
 */

import crypto from "node:crypto"

// ---------------------------------------------------------------------------
// Process-lifetime CSRF secret
// ---------------------------------------------------------------------------

const CSRF_SECRET = crypto.randomBytes(32)

// ---------------------------------------------------------------------------
// Token generation and verification
// ---------------------------------------------------------------------------

export function generateCsrfToken(sessionId: string): string {
  return crypto
    .createHmac("sha256", CSRF_SECRET)
    .update(sessionId)
    .digest("base64url")
}

export function verifyCsrfToken(sessionId: string, token: string): boolean {
  const expected = generateCsrfToken(sessionId)
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== token.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token))
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

export const CSRF_COOKIE = "csrf"
export const CSRF_HEADER = "x-csrf-token"

/** Build Set-Cookie value for the CSRF token cookie */
export function csrfCookieValue(token: string): string {
  // SameSite=Strict prevents cross-origin form submissions.
  // NOT HttpOnly — JS/forms must be able to read it for the double-submit pattern.
  // Secure — must only be transmitted over HTTPS (consistent with the session cookie).
  return `${CSRF_COOKIE}=${token}; SameSite=Strict; Secure; Path=/admin`
}

/** Extract CSRF token from cookie string */
export function extractCsrfCookie(
  cookieHeader: string | undefined,
): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name.trim() === CSRF_COOKIE) return rest.join("=").trim()
  }
  return undefined
}
