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
 *   - "Disable auth" can come from either the `--no-auth` CLI flag or from
 *     `features.auth=false` in config.json — both flow through the same
 *     safety guard so a config-only escape doesn't bypass it.
 *   - Disabled-auth on a loopback host: allowed with a yellow warning.
 *   - Disabled-auth on a non-loopback host: REFUSED unless the operator
 *     passes `--i-accept-account-suspension-risk` explicitly.
 */

import consola from "consola"

// ---------------------------------------------------------------------------
// Loopback detection
// ---------------------------------------------------------------------------

const IPV4_LOOPBACK_RE = /^127(?:\.\d{1,3}){3}$/
const LOOPBACK_LITERALS = new Set(["::1", "[::1]", "localhost"])
// Un-shortened IPv6 loopback forms (RFC 4291 §2.2 long form).
// We don't try to be a full IPv6 parser; we only accept exact-equality with
// the canonical zero-padded variants since that's all an operator could plausibly type.
const IPV6_LOOPBACK_LONG = new Set([
  "0:0:0:0:0:0:0:1",
  "0000:0000:0000:0000:0000:0000:0000:0001",
  // IPv4-mapped IPv6 loopback (RFC 4291 §2.5.5.2)
  "::ffff:127.0.0.1",
])

export function isLoopbackHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase()
  if (LOOPBACK_LITERALS.has(trimmed)) return true

  // Strip IPv6 brackets if present
  const bare = trimmed.replaceAll(/^\[|\]$/g, "")
  if (bare === "::1") return true
  if (IPV6_LOOPBACK_LONG.has(bare)) return true

  if (IPV4_LOOPBACK_RE.test(bare)) {
    // Reject 127.0.0.999 (regex allows 1-3 digits but per-octet bound is 255).
    return bare.split(".").every((octet) => {
      const n = Number.parseInt(octet, 10)
      return n >= 0 && n <= 255
    })
  }
  return false
}

// ---------------------------------------------------------------------------
// Bind-address formatting (IPv6-aware)
// ---------------------------------------------------------------------------

export function formatBindAddress(host: string, port: number): string {
  // IPv6 addresses contain colons, which collide with the port separator.
  // Wrap in brackets per RFC 3986 §3.2.2 unless already bracketed.
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]:${port}`
  }
  return `${host}:${port}`
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
  /** `--no-auth` flag (explicit CLI request to disable auth). */
  noAuth: boolean
  /** `--i-accept-account-suspension-risk` flag. */
  acceptRisk: boolean
  /** Bind hostname (e.g. "127.0.0.1", "0.0.0.0", "::"). */
  host: string
  /** Bind port — included in error/log messages. */
  port: number
  /**
   * Persisted `features.auth` from config.json. When omitted, treated as
   * `true` (auth ON). Either this being false OR `noAuth` being true counts
   * as a request to disable auth — both must clear the safety guard.
   */
  configAuth?: boolean
}

/**
 * Decide the runtime auth mode, or throw if the combination is unsafe.
 *
 * Throws a descriptive Error (NOT process.exit) so callers can format it for
 * tests as well as the CLI. The CLI catches and prints a red message.
 */
export function resolveAuthMode(options: AuthModeOptions): AuthModeResult {
  const bindAddress = formatBindAddress(options.host, options.port)
  const configAuth = options.configAuth ?? true
  const wantsAuthOff = options.noAuth || !configAuth

  if (!wantsAuthOff) {
    return { authEnabled: true, label: "on", bindAddress }
  }

  // Auth is disabled (via flag or config).
  if (isLoopbackHost(options.host)) {
    return { authEnabled: false, label: "off (loopback)", bindAddress }
  }

  // Non-loopback + auth off → require explicit ack.
  if (!options.acceptRisk) {
    const source =
      options.noAuth ?
        "--no-auth on a non-loopback host"
      : "features.auth=false (config.json) with a non-loopback bind"
    throw new Error(
      `REFUSING TO START: ${source} (${bindAddress}) is unsafe.\n\n`
        + "Anyone who can reach this port will burn your GitHub Copilot quota\n"
        + "and may trigger GitHub abuse-detection (account suspension).\n\n"
        + "Either:\n"
        + "  1. Bind to loopback only:   --host 127.0.0.1\n"
        + "  2. Enable auth (recommended): drop --no-auth (and set features.auth=true)\n"
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
