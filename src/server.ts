import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { auditAdminRoute } from "./admin/audit/route"
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

// Public: health probe — no auth required
server.get("/", (c) => c.text("Server running"))

// Auth middleware on every other route.
// New routes are protected by default; add explicit exceptions above this line
// for intentionally public paths (health checks, metrics, etc.).
server.use("*", authMiddleware)

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

// Admin routes (requireAdminMiddleware is applied inside the route)
server.route("/admin/audit", auditAdminRoute)
