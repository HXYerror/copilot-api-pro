import type { Context } from "hono"

import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import fs from "node:fs"
import path from "node:path"

import { auditAdminRoute } from "./admin/audit/route"
import { apiApp } from "./admin/api/route"
import { indexApp } from "./admin/index"
import { keysApp } from "./admin/keys/route"
import { loginApp } from "./admin/login"
import {
  requireAdminSession,
  sessionApp,
  sessionMiddleware,
} from "./admin/session-middleware"
import { settingsApp } from "./admin/settings/route"
import { tracesApp } from "./admin/traces/route"
import { usageApp } from "./admin/usage/route"
import { getDb } from "./lib/db"
import { state } from "./lib/state"
import { authMiddleware } from "./middleware/auth"
import { telemetryMiddleware } from "./middleware/telemetry"
import { traceMiddleware } from "./middleware/trace"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import responses from "./routes/responses/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(logger())
server.use(cors())

// ---------------------------------------------------------------------------
// Public routes — no auth required
// ---------------------------------------------------------------------------

// Root health check
server.get("/", (c) => c.text("Server running"))

// Liveness probe — always 200, no auth
server.get("/healthz", (c) => c.json({ status: "ok" }))

// Readiness probe — verifies DB is up and Copilot token is present
server.get("/readyz", (c) => {
  try {
    getDb().query("SELECT 1").get()
  } catch {
    return c.json({ status: "error", reason: "db_unavailable" }, 503)
  }
  if (!state.copilotToken) {
    return c.json({ status: "error", reason: "copilot_token_missing" }, 503)
  }
  return c.json({ status: "ok" })
})

// ---------------------------------------------------------------------------
// Admin WebUI (session-based, NOT behind API-key auth middleware)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Admin SPA (React + Tremor)
//
// The new admin UI is a Vite-built React SPA that lives under /admin. The
// flow is:
//   /admin/_app/*          → static files (JS, CSS, sourcemaps) from dist/ui
//   /admin/api/*           → JSON endpoints (session-protected)
//   /admin/login           → unauthenticated HTML login (legacy, still used)
//   /admin/legacy/*        → legacy SSR pages (Keys / Usage / Audit / etc.),
//                            preserved while we migrate page-by-page
//   /admin/*               → fall back to dist/ui/index.html (React Router)
//
// `dist/ui/` is produced by `bun --cwd ui run build`. We probe two candidate
// paths so this works whether we're running `bun run src/main.ts` (dev) or
// `bun dist/main.js` (prod):
//
//   import.meta.dirname  candidate path
//   ───────────────────  ──────────────────────────────
//   <repo>/src           <repo>/dist/ui  (../dist/ui)
//   <repo>/dist          <repo>/dist/ui  (./ui)
// ---------------------------------------------------------------------------

const SPA_DIR = (() => {
  const here = import.meta.dirname
  for (const candidate of [
    path.resolve(here, "../dist/ui"),
    path.resolve(here, "ui"),
  ]) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate
  }
  return path.resolve(here, "../dist/ui")
})()

const SPA_INDEX = path.join(SPA_DIR, "index.html")

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}

function mimeFor(p: string): string {
  const ext = path.extname(p).toLowerCase()
  return MIME[ext] ?? "application/octet-stream"
}

// Vite-built static assets. Path-traversal guarded; cached aggressively
// because Vite emits hashed filenames.
server.get("/admin/_app/*", (c) => {
  const reqPath = c.req.path.replace(/^\/admin\/_app\//, "")
  const filePath = path.resolve(SPA_DIR, reqPath)
  if (!filePath.startsWith(SPA_DIR + path.sep)) {
    return c.text("Not Found", 404)
  }
  try {
    const body = fs.readFileSync(filePath)
    return c.body(body, 200, {
      "Content-Type": mimeFor(filePath),
      "Cache-Control": "public, max-age=31536000, immutable",
    })
  } catch {
    return c.text("Not Found", 404)
  }
})

// Legacy SSR asset handler (kept while the old pages still ship). The new
// SPA does not load anything from here — but the legacy pages under
// /admin/legacy/* still reference /admin/assets/style.css and friends.
server.get("/admin/assets/*", (c) => {
  const assetsDir = path.join(import.meta.dirname, "admin/assets") + path.sep
  const reqPath = c.req.path.replace("/admin/assets/", "")
  const filePath = path.join(assetsDir, reqPath)

  // Path traversal guard: use path.sep suffix so a sibling directory
  // named "admin/assets_evil" cannot bypass the startsWith check.
  if (!filePath.startsWith(assetsDir)) {
    return c.text("Not Found", 404)
  }

  let content: string
  let contentType: string
  try {
    // Low-traffic admin-only path: synchronous read is acceptable here.
    content = fs.readFileSync(filePath, "utf8")
  } catch {
    return c.text("Not Found", 404)
  }

  if (filePath.endsWith(".css")) {
    contentType = "text/css; charset=utf-8"
  } else if (filePath.endsWith(".js")) {
    contentType = "application/javascript; charset=utf-8"
  } else {
    contentType = "text/plain; charset=utf-8"
  }

  return c.text(content, 200, { "Content-Type": contentType })
})

// Login routes (no session required)
server.route("/admin/login", loginApp)

// ---------------------------------------------------------------------------
// API key auth middleware
// Applies to all routes below this line EXCEPT the session-based WebUI paths
// registered before it (/admin/login, /admin/assets/*).
// ---------------------------------------------------------------------------

// Auth middleware on every other route.
// New routes are protected by default; add explicit exceptions above this line
// for intentionally public paths (health checks, metrics, etc.).
// The session-based admin WebUI paths (/admin/*) bypass this because they do
// their own session-cookie auth inside sessionProtected.
server.use("*", (c, next) => {
  // Skip API-key auth for session-based admin WebUI paths
  const path = c.req.path
  if (path === "/admin" || path.startsWith("/admin/")) {
    return next()
  }
  return authMiddleware(c, next)
})

// ---------------------------------------------------------------------------
// Telemetry middleware (issue #34, F3.A)
// Runs AFTER auth (needs c.var.key) and BEFORE route handlers.  Records one
// row in the `events` table per API-proxy request.
//
// Skipped for:
//   - Root / health probes (/, /healthz, /readyz) — not proxy traffic.
//   - All /admin/* paths — operator queries shouldn't pollute the events
//     table or count toward usage metrics.
// ---------------------------------------------------------------------------
server.use("*", (c, next) => {
  const path = c.req.path
  if (
    path === "/"
    || path === "/healthz"
    || path === "/readyz"
    || path === "/admin"
    || path.startsWith("/admin/")
  ) {
    return next()
  }
  // The telemetry middleware is typed with a Variables shape, but at this
  // outer mount we only need it as a generic MiddlewareHandler.
  const mw = telemetryMiddleware as unknown as (
    c: Context,
    next: Next,
  ) => Promise<void>
  return mw(c, next)
})

// ---------------------------------------------------------------------------
// Trace middleware (issue #36, F4.A)
// Runs AFTER auth (needs c.var.key) and AFTER telemetry (so telemetry sees
// the unwrapped response body and isn't blocked by our capture wrap).
//
// Skipped for the same routes as telemetry: root, health probes, and
// /admin/* paths.  Inside the middleware itself, capture only activates
// when the key has debug_enabled (or admin tier + X-Capi-Debug: 1).
// ---------------------------------------------------------------------------
server.use("*", (c, next) => {
  const path = c.req.path
  if (
    path === "/"
    || path === "/healthz"
    || path === "/readyz"
    || path === "/admin"
    || path.startsWith("/admin/")
  ) {
    return next()
  }
  const mw = traceMiddleware as unknown as (
    c: Context,
    next: Next,
  ) => Promise<void>
  return mw(c, next)
})

// Session routes (logout — session middleware verifies)
// Note: these also run through authMiddleware, but sessionMiddleware takes
// priority because it checks the session cookie first. The NO_AUTH_SENTINEL
// is set by authMiddleware in no-auth mode, which is fine here too.
const sessionProtected = new Hono()
sessionProtected.use("*", sessionMiddleware)
sessionProtected.use("*", requireAdminSession)
sessionProtected.route("/session", sessionApp)
sessionProtected.route("/api", apiApp)

// Legacy SSR pages — preserved while the React SPA pages are still being
// migrated page-by-page. The SPA's <PlaceholderPage> deep-links here.
// We re-mount each legacy route under a `legacy/...` prefix in addition to
// the historic path so both the new SPA and any old bookmarks keep working.
const legacyApp = new Hono()
legacyApp.route("/keys", keysApp)
legacyApp.route("/usage", usageApp)
legacyApp.route("/audit", auditAdminRoute)
legacyApp.route("/traces", tracesApp)
legacyApp.route("/settings", settingsApp)
legacyApp.route("/", indexApp)
sessionProtected.route("/legacy", legacyApp)
// Hono treats `/legacy` and `/legacy/` differently when the inner route is
// `/` — only the former matches the index page. Redirect the trailing-slash
// form to keep both URLs viable for operators typing the path manually.
sessionProtected.get("/legacy/", (c) => c.redirect("/admin/legacy", 302))

// Historic mount points — kept only for paths the SPA still depends on.
// As pages migrate to React their /admin/<page> HTML mount is removed so the
// SPA fallback (catch-all below) serves the React shell instead.
//   - keys:     migrated Phase 2 → removed
//   - usage:    migrated Phase 3 → removed (CSV moved to /admin/api/usage/export.csv)
//   - logs:     migrated Phase 4
//   - audit:    migrated Phase 5 → removed
//   - settings: migrated Phase 5 → removed
//   - models:   net-new Phase 5
//
// `/admin/traces` stays mounted because the SPA Logs page subscribes to
// `/admin/traces/stream` (SSE) and downloads `/admin/traces/<date>.jsonl`
// files. Its index HTML is shadowed by the SPA fallback below — only the
// SSE + file routes survive.
sessionProtected.route("/traces", tracesApp)

// SPA fallback: serve dist/ui/index.html for any GET inside /admin that
// didn't match a more specific route above. POST / PUT / DELETE fall
// through to a 404 (no SSR page accepts them at this path).
sessionProtected.get("*", (c) => {
  try {
    const html = fs.readFileSync(SPA_INDEX, "utf8")
    return c.html(html)
  } catch {
    return c.text(
      "Admin UI not built — run `bun --cwd ui run build` first.",
      503,
    )
  }
})

server.route("/admin", sessionProtected)

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)

// OpenAI Responses API
server.route("/responses", responses)
server.route("/v1/responses", responses)
