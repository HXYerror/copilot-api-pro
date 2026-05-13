# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v0.8

### Breaking changes

- **Authentication is now required by default.** Previously every request was
  served anonymously. v0.8 boots with an auto-bootstrap admin key on first run
  (written to `~/.local/share/copilot-api/admin.key.txt`, mode `0600`).
  Existing tools must send `Authorization: Bearer <sk-cap-…>` on every
  request. See README → "Admin Plane / Authentication" and "Migrating from v0.7".
- **`--no-auth` is now a safety-gated opt-out.** It is allowed on loopback
  hosts (`127.0.0.1`, `::1`, `localhost`) with a yellow warning. On a
  non-loopback bind it refuses to start unless paired with
  `--i-accept-account-suspension-risk`.
- **Default bind host is `127.0.0.1`.** Previously the listener bound to all
  interfaces. Pass `--host 0.0.0.0` (with auth) to expose to the LAN.

### Added

- `--no-auth`, `--i-accept-account-suspension-risk`, and `--host` flags on
  the `start` command.
- Admin WebUI at `/admin/*` (login, keys management, audit viewer).
- `/admin/keys` page for issuing, scoping, revoking, and toggling debug mode
  on individual API keys. Each key carries a tier (`admin` / `client`), an
  `allowed_models` allowlist, a per-key rate-limit override, and an optional
  debug TTL.
- `/healthz` and `/readyz` probes outside the `/admin` prefix.
- Append-only audit log at `~/.local/share/copilot-api/audit-YYYY-MM-DD.jsonl`
  (mode `0600`) with daily rotation and configurable retention.
- Per-key rate limiting with a global cap.
- 24-hour TTL on debug-mode keys, swept every 60 s; banner on every admin
  page when any key is in active debug.

### Security

- Session cookies are `HttpOnly; Secure; SameSite=Strict; Path=/admin` with
  an 8-hour sliding expiry.
- CSRF double-submit (HMAC-SHA256 token + `Sec-Fetch-Site: same-origin`).
- Content-Security-Policy `default-src 'self'; frame-ancestors 'none';
  form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'`
  on all `/admin` responses; `X-Frame-Options: DENY`, `Referrer-Policy:
  no-referrer`, `X-Content-Type-Options: nosniff` always present.
- `auth.reject` audit events record only the first 8 hex chars of the
  SHA-256 hash of the offending bearer token, never the token itself.
- `--no-auth` on non-loopback refused unless explicitly acknowledged.

### Internal

- bun:sqlite with WAL, `PRAGMA user_version` migrations, `BEGIN EXCLUSIVE`
  DDL.
- Best-effort audit policy: a failed JSONL append is logged but does not
  break the mutation that triggered it.

---

## [0.7.x] and earlier

See git history. Pre-v0.8 the proxy had no authentication, no admin plane,
and no audit log. Public-facing deployments of those versions are vulnerable
to Copilot-quota exhaustion by any client that can reach the port.
