/**
 * Auth-mode safety guard for the `start` command.
 *
 * Per security S2 review the legacy single-tenant "no auth" pattern is
 * dangerous when the listener is exposed beyond loopback: any unauthenticated
 * client can burn the operator's Copilot quota, and in the worst case trigger
 * GitHub abuse detection on the underlying account.
 *
 * Policy (v0.8+):
 *   - Default: auth ON (bootstrap admin key on first run).
 *   - `--no-auth` on loopback host: allowed with a yellow warning.
 *   - `--no-auth` on non-loopback host: REFUSED unless the operator passes
 *     `--i-accept-account-suspension-risk` explicitly.
 */

import consola from "consola"

// ---------------------------------------------------------------------------
// Loopback detection
// ---------------------------------------------------------------------------

// Strict per-octet check for 127.0.0.0/8 plus IPv6 ::1 and the localhost name.
const IPV4_LOOPBACK_RE = /^127(?:\.\d{1,3}){3}$/
const LOOPBACK_LITERALS = new Set(["::1", "[::1]", "localhost"])

export function isLoopbackHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase()
  if (LOOPBACK_LITERALS.has(trimmed)) return true
  // Strip IPv6 brackets if present
  const bare = trimmed.replaceAll(/^\[|\]$/g, "")
  if (bare === "::1") return true
  if (IPV4_LOOPBACK_RE.test(bare)) {
    // Also reject e.g. 127.999.999.999 (regex allows 1-3 digits per octet)
    return bare.split(".").every((octet) => {
      const n = Number.parseInt(octet, 10)
      return n >= 0 && n <= 255
    })
  }
  return false
}

// ---------------------------------------------------------------------------
// Auth mode resolution
// ---------------------------------------------------------------------------

export type AuthModeLabel = "on" | "off (loopback)" | "off (acknowledged risk)"

export interface AuthModeResult {
  authEnabled: boolean
  label: AuthModeLabel
  bindAddress: string
}

export interface AuthModeOptions {
  /** `--no-auth` flag. If false, auth is on regardless. */
  noAuth: boolean
  /** `--i-accept-account-suspension-risk` flag. */
  acceptRisk: boolean
  /** Bind hostname (e.g. "127.0.0.1", "0.0.0.0", "::"). */
  host: string
  /** Bind port — only included in error/log messages. */
  port: number
}

/**
 * Decide the runtime auth mode, or throw if the combination is unsafe.
 *
 * Throws a descriptive Error (NOT process.exit) so callers can format it for
 * tests as well as the CLI. The CLI catches and prints a red message.
 */
export function resolveAuthMode(options: AuthModeOptions): AuthModeResult {
  const bindAddress = `${options.host}:${options.port}`

  if (!options.noAuth) {
    return { authEnabled: true, label: "on", bindAddress }
  }

  // --no-auth was passed.
  if (isLoopbackHost(options.host)) {
    return { authEnabled: false, label: "off (loopback)", bindAddress }
  }

  // Non-loopback + --no-auth → require explicit ack.
  if (!options.acceptRisk) {
    throw new Error(
      "REFUSING TO START: --no-auth on a non-loopback host "
        + `(${bindAddress}) is unsafe.\n\n`
        + "Anyone who can reach this port will burn your GitHub Copilot quota\n"
        + "and may trigger GitHub abuse-detection (account suspension).\n\n"
        + "Either:\n"
        + "  1. Bind to loopback only:   --host 127.0.0.1\n"
        + "  2. Enable auth (recommended): drop --no-auth\n"
        + "  3. Explicitly accept the risk:\n"
        + "       --no-auth --i-accept-account-suspension-risk\n\n"
        + "See README → Admin Plane / Authentication.",
    )
  }

  return { authEnabled: false, label: "off (acknowledged risk)", bindAddress }
}

// ---------------------------------------------------------------------------
// Startup logging
// ---------------------------------------------------------------------------

export function logAuthModeBanner(result: AuthModeResult): void {
  if (result.label === "on") {
    consola.info(`[auth] mode=on  bind=${result.bindAddress}`)
    return
  }

  if (result.label === "off (loopback)") {
    consola.warn(
      `\x1B[33m[auth] mode=${result.label}  bind=${result.bindAddress}\n`
        + "       Authentication is DISABLED. Only loopback is allowed in this mode.\x1B[0m",
    )
    return
  }

  // acknowledged-risk path: print red
  consola.warn(
    `\x1B[31m[auth] mode=${result.label}  bind=${result.bindAddress}\n`
      + "       Authentication is DISABLED on a non-loopback bind. The operator has\n"
      + "       acknowledged the GitHub abuse-detection / Copilot-quota risk.\x1B[0m",
  )
}
