/**
 * GET /admin/api/me — current session metadata for the SPA shell.
 *
 * The SPA reads this once on startup to:
 *   - confirm the user is authenticated (otherwise the api client redirects)
 *   - obtain the csrf token (sent on every mutating request; also persisted
 *     to the `csrf` cookie at login, but the server prefers the cookie
 *     anyway for verification — we return both so the UI can render the
 *     last-4 of the key and the auth mode badge)
 *   - render the auth mode badge / bind address in the top bar
 */

import { Hono } from "hono"

import { getBuildIdentity } from "~/lib/build-identity"
import { state } from "~/lib/state"
import { findKeyById } from "~/services/keys"

import type { SessionVar } from "../session-middleware"

export const meRoute = new Hono<{ Variables: SessionVar }>()

meRoute.get("/", async (c) => {
  const session = c.get("session")
  // requireAdminSession guarantees this exists and is admin-tier.
  const key = findKeyById(session.key_id)
  const build = await getBuildIdentity()
  return c.json({
    authenticated: true,
    key_id: session.key_id,
    label: key?.label ?? null,
    tier: "admin",
    csrf_token: session.csrf_token,
    auth_mode_label: state.authModeLabel ?? "on",
    bind_address: state.bindAddress ?? "unknown",
    build,
  })
})
