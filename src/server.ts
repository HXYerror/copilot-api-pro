import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import fs from "node:fs"
import path from "node:path"

import { auditAdminRoute } from "./admin/audit/route"
import { indexApp } from "./admin/index"
import { loginApp } from "./admin/login"
import { sessionApp, sessionMiddleware } from "./admin/session-middleware"
import { getDb } from "./lib/db"
import { state } from "./lib/state"
import { authMiddleware } from "./middleware/auth"
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

// Static assets — served before session check
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
// The session-based admin WebUI paths (/admin, /admin/session) bypass this
// because they do their own session-cookie auth inside sessionProtected.
server.use("*", (c, next) => {
  // Skip API-key auth for session-based admin WebUI paths
  const path = c.req.path
  if (
    path === "/admin"
    || (path.startsWith("/admin/") && !path.startsWith("/admin/audit"))
  ) {
    return next()
  }
  return authMiddleware(c, next)
})

// Admin API routes (API-key auth, protected by authMiddleware above)
server.route("/admin/audit", auditAdminRoute)

// Session routes (logout — session middleware verifies)
// Note: these also run through authMiddleware, but sessionMiddleware takes
// priority because it checks the session cookie first. The NO_AUTH_SENTINEL
// is set by authMiddleware in no-auth mode, which is fine here too.
const sessionProtected = new Hono()
sessionProtected.use("*", sessionMiddleware)
sessionProtected.route("/session", sessionApp)
sessionProtected.route("/", indexApp)
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
