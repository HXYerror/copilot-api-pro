/**
 * Trace redaction — pure functions, no IO.
 *
 * The debug capture feature persists full request/response pairs to disk.
 * Anything resembling a secret MUST be replaced before it crosses the
 * persistence boundary. We err on the side of over-redaction: false
 * positives (a legitimate token-shaped string redacted) are recoverable;
 * a single leaked secret is not.
 *
 * Two-pass defence-in-depth:
 *   1. `redactBody()` runs BODY_PATTERNS — the issuer-shaped redactions.
 *   2. `assertRedacted()` runs BODY_PATTERNS again AND a stricter
 *      generic-shape pass (POST_REDACT_HEURISTICS) over the already-redacted
 *      output. The second pass catches:
 *        - bugs in the substitution loop (replace-and-leave-something-behind)
 *        - secret shapes that exist in real traffic but aren't in
 *          BODY_PATTERNS (e.g., a leading `Authorization: Bearer <opaque>`).
 *      Per the crew review of #36, the second pass MUST be a separate
 *      pattern set so it actually adds defence — running BODY_PATTERNS
 *      against its own output only catches substitution bugs.
 *
 * If `assertRedacted` throws, the writer drops the line entirely.
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
// Body redaction — issuer-shaped patterns
//
// Patterns intentionally match the secret SHAPE, not a specific issuer. The
// order matters only for performance (cheapest match first).
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
 * - `Iv[0-9]+\.[A-Fa-f0-9]{16,}` — GitHub OAuth client id family. The
 *   classic `Iv1.b507a08c87ecfe98` is shipped in src/lib/api-config.ts;
 *   newer GitHub Apps use `Iv23.…`. These are public-by-design but we
 *   still redact them so captured traces don't bake in the proxy build id.
 * - `sk-cap-[A-Z2-7]{52}` — THIS proxy's own admin/client bearer tokens.
 *   They're not GitHub tokens, so the other patterns miss them. Without
 *   this entry a developer pasting their own key into a chat prompt
 *   ("hey, what's wrong with this key?") would leak it to disk verbatim.
 *   Cited in the crew review of #36 as R1.
 * - `sk-ant-[A-Za-z0-9_-]{40,}` — Anthropic API keys (real users routinely
 *   accidentally paste these into prompts).
 * - `sk-[A-Za-z0-9_-]{40,}` — OpenAI-style sk- keys (sk-proj-*, sk-*).
 *   Order matters: more specific sk-cap and sk-ant patterns run first.
 * - `AKIA[A-Z0-9]{16}` — AWS access key id.
 * - Basic-auth URL `://user:pass@host` — common credential-in-URL.
 */
export const BODY_PATTERNS: ReadonlyArray<RegExp> = [
  /gh[oprsu]_[A-Za-z0-9]{20,}/g,
  /github_pat_\w{20,}/g,
  // JWT: three base64url segments separated by dots; first two start with
  // "eyJ" (the base64url encoding of the JSON header/payload prelude `{"`).
  // Lazy quantifiers keep us from greedily eating adjacent text.
  /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g,
  /Iv\d+\.[A-Fa-f0-9]{16,}/g,
  /sk-cap-[A-Z2-7]{52}/g,
  /sk-ant-[\w-]{40,}/g,
  /sk-[\w-]{40,}/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  // Basic-auth credential embedded in a URL — captures user:pass@host
  /(?<=:\/\/)[^:/@\s]+:[^@\s]{1,200}(?=@)/g,
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
// Sanity check — independent post-redaction heuristics
//
// These regexes look for the SHAPE of "credential adjacent to a marker" —
// `bearer foo`, `token=foo`, `api_key=foo`, `secret=foo`, etc. They will
// false-positive on legitimate URLs, hashes, and any long opaque string,
// which is exactly what we want: redaction errs on the side of "throw and
// drop the trace" rather than persist anything suspicious.
//
// Run AFTER `redactBody`. If any of these match, the redactor missed an
// issuer pattern and the writer must NOT persist this line.
// ---------------------------------------------------------------------------

const POST_REDACT_HEURISTICS: ReadonlyArray<RegExp> = [
  // bearer <opaque-40+-char>
  /\bbearer\s+[\w+./~=-]{32,}/gi,
  // api_key=<opaque>, api-key=<opaque>, apikey=<opaque>, token=<opaque>,
  // secret=<opaque>, password=<opaque>.  The `api[_-]?key` branch already
  // covers "apikey" (the `?` makes the separator optional).
  /\b(?:api[_-]?key|token|secret|password)["':=]+\s*["']?[\w+./~=-]{32,}/gi,
]

/**
 * Throw if `line` still matches a known issuer pattern OR a generic
 * "credential adjacent to a marker" heuristic.
 *
 * The writer calls this AFTER its own redaction pass. A throw indicates
 * either a defect in the redactor (substitution bug) OR an unforeseen
 * secret shape that slipped past BODY_PATTERNS. The writer drops the
 * trace rather than persist it.
 */
export function assertRedacted(line: string): void {
  // Pass 1: did our own substitution leave any of the issuer patterns?
  for (const pattern of BODY_PATTERNS) {
    // Fresh RE each iteration so global lastIndex is always 0.
    const re = new RegExp(pattern.source, pattern.flags)
    if (re.test(line)) {
      throw new Error(
        `[trace-redact] assertRedacted: output still matches /${pattern.source}/`,
      )
    }
  }
  // Pass 2: independent shape heuristics — catches secret families we
  // haven't enumerated.  The redaction placeholder itself is short and
  // doesn't match these patterns.
  for (const pattern of POST_REDACT_HEURISTICS) {
    const re = new RegExp(pattern.source, pattern.flags)
    if (re.test(line)) {
      throw new Error(
        `[trace-redact] assertRedacted: line contains an unredacted credential marker (/${pattern.source}/) — refusing to persist`,
      )
    }
  }
}
