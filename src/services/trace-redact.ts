/**
 * Trace redaction — pure functions, no IO.
 *
 * The debug capture feature persists full request/response pairs to disk.
 * Anything resembling a secret MUST be replaced before it crosses the
 * persistence boundary. We err on the side of over-redaction: false
 * positives (a legitimate token-shaped string redacted) are recoverable;
 * a single leaked secret is not.
 *
 * Defence-in-depth: redactBody() is the primary redaction step, and
 * assertRedacted() is the sanity check run by the writer over the redacted
 * output. If assertRedacted throws, the writer drops the line entirely —
 * we never persist anything that still matches a known secret pattern.
 */

const REDACTION_PLACEHOLDER = "[REDACTED]"

// ---------------------------------------------------------------------------
// Header redaction
// ---------------------------------------------------------------------------

/**
 * Header names whose values are always replaced with REDACTED_PLACEHOLDER.
 * Matching is case-insensitive (Headers normalises to lowercase).
 *
 * Includes everything that can carry credentials in either direction:
 * - Client → proxy: authorization, x-api-key, cookie, proxy-authorization
 * - Proxy → upstream: authorization (Copilot bearer), x-github-token,
 *   x-vscs-token (Copilot Chat extension headers — see api-config.ts)
 * - Upstream → proxy: set-cookie
 */
export const REDACTED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-github-token",
  "x-vscs-token",
  // x-capi-debug is not a secret, but it's an admin-tier signal we don't
  // want to surface in captured traces (operators can see it in the audit
  // log instead).
  "x-capi-debug",
])

/**
 * Return a plain-object clone of `headers` with redacted names replaced by
 * "[REDACTED]". Lowercases all keys so the output is canonical.
 */
export function redactHeaders(
  headers: Headers | Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (headers instanceof Headers) {
    for (const [name, value] of headers.entries()) {
      const lower = name.toLowerCase()
      out[lower] = REDACTED_HEADERS.has(lower) ? REDACTION_PLACEHOLDER : value
    }
    return out
  }
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    out[lower] = REDACTED_HEADERS.has(lower) ? REDACTION_PLACEHOLDER : value
  }
  return out
}

// ---------------------------------------------------------------------------
// Body redaction
//
// Patterns intentionally match the secret SHAPE, not a specific issuer. The
// order matters only for performance (cheapest match first) — the writer
// re-runs the full set as assertRedacted afterwards.
// ---------------------------------------------------------------------------

/**
 * Regexes for substrings that must be scrubbed from captured bodies.
 *
 * - `gh[oprsu]_[A-Za-z0-9]{20,}` — classic + new GitHub PATs:
 *     ghp_  personal access token (classic)
 *     gho_  OAuth user token
 *     ghu_  GitHub user-to-server token
 *     ghs_  server-to-server token
 *     ghr_  refresh token
 * - `github_pat_[A-Za-z0-9_]{20,}` — fine-grained PATs
 * - `eyJ...eyJ...` — JWT shape (covers the upstream Copilot bearer)
 * - `Iv1\.[a-f0-9]{16}` — the GitHub OAuth client id literal we ship in
 *   `src/lib/api-config.ts` (`Iv1.b507a08c87ecfe98`). It's a constant, not
 *   a secret, but operators rotate the proxy build occasionally and we'd
 *   rather not bake the literal into every captured trace.
 */
export const BODY_PATTERNS: ReadonlyArray<RegExp> = [
  /gh[oprsu]_[A-Za-z0-9]{20,}/g,
  /github_pat_\w{20,}/g,
  // JWT: three base64url segments separated by dots; first two start with
  // "eyJ" (the base64url encoding of the JSON header/payload prelude `{"`).
  // Lazy quantifiers keep us from greedily eating adjacent text.
  /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g,
  /Iv1\.[a-f0-9]{16}/g,
]

/**
 * Redact secret-shaped substrings from a body.
 *
 * For objects we JSON.stringify first; we never store a parsed object on
 * disk, only the redacted JSONL text. We also deliberately do NOT
 * pretty-print: pretty-printed JSON spans more bytes per line and the
 * writer is line-buffered, so each captured event must stay on a single
 * line for the readers (`tail -f`, the SSE replay buffer) to work.
 */
export function redactBody(body: string | object | null | undefined): string {
  if (body === null || body === undefined) return ""
  const text = typeof body === "string" ? body : JSON.stringify(body)
  let redacted = text
  for (const pattern of BODY_PATTERNS) {
    // Use a fresh global RE clone to avoid lastIndex state between calls
    redacted = redacted.replace(
      new RegExp(pattern.source, pattern.flags),
      REDACTION_PLACEHOLDER,
    )
  }
  return redacted
}

// ---------------------------------------------------------------------------
// Sanity check
// ---------------------------------------------------------------------------

/**
 * Throw if `line` still matches any BODY_PATTERN.
 *
 * The writer calls this AFTER its own redaction pass; a throw indicates a
 * defect in the redactor (or an unforeseen secret shape) and the writer
 * drops the trace rather than persist it.
 */
export function assertRedacted(line: string): void {
  for (const pattern of BODY_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags)
    const match = re.exec(line)
    if (match) {
      throw new Error(
        `[trace-redact] assertRedacted: output still matches /${pattern.source}/`,
      )
    }
  }
}
