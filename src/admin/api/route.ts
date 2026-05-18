/**
 * JSON API subtree mounted at /admin/api. Consumed by the React SPA shipped
 * from /admin (dist/ui/index.html).
 *
 * Auth model: shares the session-cookie + CSRF middleware with the legacy
 * HTML pages — sessionMiddleware runs in front of every /admin/* route via
 * the parent server.ts mount. For requests under /admin/api/*, the
 * middleware returns 401 JSON instead of redirecting to /admin/login so the
 * SPA's fetch wrapper can react cleanly. See sessionMiddleware in
 * ../session-middleware.ts for the explicit /admin/api/ branch.
 */

import { Hono } from "hono"

import type { SessionVar } from "../session-middleware"

import { auditApiRoute } from "./audit"
import { keysRoute } from "./keys"
import { logsRoute } from "./logs"
import { meRoute } from "./me"
import { logoutRoute } from "./logout"
import { modelsRoute } from "./models"
import { overviewRoute } from "./overview"
import { settingsApiRoute } from "./settings"
import { usageRoute } from "./usage"

export const apiApp = new Hono<{ Variables: SessionVar }>()

apiApp.route("/me", meRoute)
apiApp.route("/logout", logoutRoute)
apiApp.route("/overview", overviewRoute)
apiApp.route("/keys", keysRoute)
apiApp.route("/usage", usageRoute)
apiApp.route("/logs", logsRoute)
apiApp.route("/models", modelsRoute)
apiApp.route("/audit", auditApiRoute)
apiApp.route("/settings", settingsApiRoute)
