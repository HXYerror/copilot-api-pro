/** @jsxImportSource hono/jsx */
import type { Context } from "hono"

import { Hono } from "hono"

import type { Config } from "~/lib/config-store"

import { ConfigSchema, getConfig, saveConfig } from "~/lib/config-store"
import { audit } from "~/services/audit"

import type { SessionVar } from "../session-middleware"

import { ADMIN_SECURITY_HEADERS, Layout } from "../layout"
import { SettingsPage } from "./page"

// ---------------------------------------------------------------------------
// Settings app — server-rendered config.json editor for admin operators.
//
// Design notes (see docs/decisions-log.zh.md D-004):
// - Auth toggle deliberately NOT exposed (lock-out risk; CLI/file only).
// - Validation: parseForm shape + Zod schema. Auth field always pulled
//   from `before` config, never from the form (defense in depth).
// - Audit event "config.update" emitted on every successful save.
// ---------------------------------------------------------------------------

const settingsApp = new Hono<{ Variables: SessionVar }>()

settingsApp.use("*", async (c, next) => {
  await next()
  for (const [k, v] of Object.entries(ADMIN_SECURITY_HEADERS)) {
    c.header(k, v)
  }
})

// ---------------------------------------------------------------------------
// GET /admin/settings
// ---------------------------------------------------------------------------

settingsApp.get("/", (c) => {
  const session = c.get("session")
  const success = c.req.query("success")
  return c.html(
    <Layout title="Settings" active="settings" csrfToken={session.csrf_token}>
      <SettingsPage
        config={getConfig()}
        csrfToken={session.csrf_token}
        success={success === "1" ? "Settings saved" : undefined}
      />
    </Layout>,
  )
})

// ---------------------------------------------------------------------------
// POST /admin/settings — apply edits
// ---------------------------------------------------------------------------

settingsApp.post("/", async (c) => {
  const session = c.get("session")
  // `{ all: true }` for symmetry with the rest of the admin handlers — see
  // the long-form note in keys/route.tsx. The settings form happens to use
  // unique field names per row (model_0_alias, model_1_alias, …) so the
  // flatten-on-cache bug wouldn't bite here, but keeping the option in sync
  // means a future copy-paste won't accidentally regress.
  const body = await c.req.parseBody({ all: true })
  const before = getConfig()

  // Build the candidate from the form, then validate with full Zod schema.
  const candidate = buildCandidate(body, before)
  const parsed = ConfigSchema.safeParse(candidate)
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")
    return renderSettingsError(c, session, `Validation failed: ${msg}`)
  }

  // Defense in depth: form NEVER changes auth state, no matter what was POSTed.
  parsed.data.features.auth = before.features.auth

  try {
    saveConfig(parsed.data)
  } catch (err) {
    return renderSettingsError(c, session, `Save failed: ${String(err)}`)
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
    // swallow — audit is observability, not durability
  }

  return c.redirect("/admin/settings?success=1", 303)
})

function renderSettingsError(
  c: Context<{ Variables: SessionVar }>,
  session: { csrf_token: string },
  msg: string,
): Response {
  return c.html(
    <Layout title="Settings" active="settings" csrfToken={session.csrf_token}>
      <SettingsPage
        config={getConfig()}
        csrfToken={session.csrf_token}
        error={msg}
      />
    </Layout>,
    400,
  )
}

// ---------------------------------------------------------------------------
// Form → config translation
//
// The form posts a flat key/value structure (model_0_alias, model_0_upstream,
// retention_events_days, …). We reassemble it into a Config shape.
// ---------------------------------------------------------------------------

const MAX_MODEL_ROWS = 100

function buildCandidate(
  body: Record<string, unknown>,
  before: Config,
): unknown {
  const models: Record<
    string,
    { upstream: string; enabled: boolean; allowed_keys: Array<string> }
  > = {}

  for (let i = 0; i < MAX_MODEL_ROWS; i++) {
    const alias = strField(body, `model_${i}_alias`)
    const upstream = strField(body, `model_${i}_upstream`)
    if (alias === undefined && upstream === undefined) continue
    if (!alias || !upstream) continue // blank row = delete
    const enabled = body[`model_${i}_enabled`] === "1"

    // Preserve allowed_keys from current config; settings UI doesn't edit it.
    // Default value if alias is new: ["*"] (matches ModelEntrySchema default).
    const existing = (
      before.models as Record<
        string,
        { allowed_keys?: Array<string> } | undefined
      >
    )[alias]
    const allowed_keys: Array<string> = existing?.allowed_keys ?? ["*"]
    models[alias] = { upstream, enabled, allowed_keys }
  }

  return {
    version: 1,
    models,
    retention: {
      events_days: intField(body, "retention_events_days", 90),
      traces_days: intField(body, "retention_traces_days", 0),
      traces_max_bytes: intField(
        body,
        "retention_traces_max_bytes",
        104_857_600,
      ),
      audit_days: intField(body, "retention_audit_days", 365),
    },
    features: {
      // auth deliberately taken from `before` — UI never changes it.
      auth: before.features.auth,
      telemetry: body["features_telemetry"] === "1",
      debug: body["features_debug"] === "1",
    },
  }
}

function strField(
  body: Record<string, unknown>,
  name: string,
): string | undefined {
  const v = body[name]
  if (typeof v !== "string") return undefined
  return v.trim()
}

function intField(
  body: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const v = body[name]
  if (typeof v !== "string") return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export { settingsApp }
