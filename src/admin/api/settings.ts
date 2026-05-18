/**
 * /admin/api/settings — JSON config.json reader / writer for the SPA.
 *
 * GET  returns the current config exactly as `getConfig()` exposes it.
 * PUT  validates the body with ConfigSchema, forces `features.auth` to the
 *      pre-edit value (defense-in-depth — same rule the legacy SSR enforces),
 *      writes via `saveConfig`, and audit-logs config.update.
 */

import { Hono } from "hono"

import { ConfigSchema, getConfig, saveConfig } from "~/lib/config-store"
import { audit } from "~/services/audit"

import type { SessionVar } from "../session-middleware"

export const settingsApiRoute = new Hono<{ Variables: SessionVar }>()

settingsApiRoute.get("/", (c) => {
  return c.json({ config: getConfig() })
})

settingsApiRoute.put("/", async (c) => {
  const session = c.get("session")
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }
  const before = getConfig()
  const parsed = ConfigSchema.safeParse(body)
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")
    return c.json({ error: `Validation failed: ${msg}` }, 400)
  }
  // Defense in depth: never let the API change the auth flag.
  parsed.data.features.auth = before.features.auth

  try {
    saveConfig(parsed.data)
  } catch (err) {
    return c.json({ error: `Save failed: ${String(err)}` }, 400)
  }

  try {
    audit({
      actor_key_id: session.key_id,
      actor_tier: "admin",
      action: "config.update",
      before: { ...before },
      after: { ...parsed.data },
    })
  } catch {
    /* audit is observability, not durability */
  }

  return c.json({ ok: true, config: parsed.data })
})
