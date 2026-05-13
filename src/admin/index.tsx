/** @jsxImportSource hono/jsx */
import { Hono } from "hono"

import { getConfig } from "~/lib/config-store"
import { getDb } from "~/lib/db"
import { countActiveDebugKeys } from "~/services/keys"

import type { SessionVar } from "./session-middleware"

import { ADMIN_SECURITY_HEADERS, Layout } from "./layout"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDbCounts(): {
  keys: number
  activeSessions: number
} {
  const db = getDb()
  const keyRow = db
    .query<
      { count: number },
      []
    >("SELECT COUNT(*) as count FROM keys WHERE revoked_at IS NULL")
    .get()
  const sessionRow = db
    .query<
      { count: number },
      [number]
    >("SELECT COUNT(*) as count FROM sessions WHERE expires_at > ?")
    .get(Date.now())

  return {
    keys: keyRow?.count ?? 0,
    activeSessions: sessionRow?.count ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Index app
// ---------------------------------------------------------------------------

const indexApp = new Hono<{ Variables: SessionVar }>()

indexApp.use("*", async (c, next) => {
  await next()
  for (const [k, v] of Object.entries(ADMIN_SECURITY_HEADERS)) {
    c.header(k, v)
  }
})

indexApp.get("/", (c) => {
  const session = c.get("session")
  const config = getConfig()
  const counts = getDbCounts()
  const keyIdSuffix = session.key_id.slice(-4)
  const debugKeyCount = countActiveDebugKeys()

  return c.html(
    <Layout
      title="Overview"
      active="index"
      csrfToken={session.csrf_token}
      debugKeyCount={debugKeyCount}
    >
      <h1>Overview</h1>
      <div class="status-grid">
        <div class="status-card">
          <dt>Config Version</dt>
          <dd>{config.version}</dd>
        </div>
        <div class="status-card">
          <dt>Auth Mode</dt>
          <dd>{config.features.auth ? "Enabled" : "Disabled (no-auth)"}</dd>
        </div>
        <div class="status-card">
          <dt>Active Keys</dt>
          <dd>{counts.keys}</dd>
        </div>
        <div class="status-card">
          <dt>Active Sessions</dt>
          <dd>{counts.activeSessions}</dd>
        </div>
        <div class="status-card">
          <dt>Your Key ID (last 4)</dt>
          <dd class="mono">…{keyIdSuffix}</dd>
        </div>
      </div>
    </Layout>,
  )
})

export { indexApp }
