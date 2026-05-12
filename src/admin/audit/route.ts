import { Hono } from "hono"
import fs from "node:fs"

import type { KeyVar } from "~/middleware/auth"
import type { AuditEvent } from "~/services/audit"

import { requireAdminMiddleware } from "~/middleware/auth"
import { auditFilePath, todayDateStr } from "~/services/audit"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDateParam(dateParam: string | undefined): string {
  if (dateParam !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return dateParam
  }
  return todayDateStr()
}

function parseIntParam(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

function isValidEvent(parsed: unknown): parsed is AuditEvent {
  return (
    parsed !== null
    && typeof parsed === "object"
    && "ts" in parsed
    && "actor_key_id" in parsed
    && "action" in parsed
  )
}

function readAuditEvents(
  dateStr: string,
  actionFilter: string | undefined,
): Array<AuditEvent> {
  const filePath = auditFilePath(dateStr)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf8")
  } catch {
    return []
  }

  const events: Array<AuditEvent> = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (
      isValidEvent(parsed)
      && (actionFilter === undefined || parsed.action === actionFilter)
    ) {
      events.push(parsed)
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const auditAdminRoute = new Hono<{ Variables: KeyVar }>()

auditAdminRoute.use("*", requireAdminMiddleware)

auditAdminRoute.get("/", (c) => {
  const dateStr = parseDateParam(c.req.query("date"))
  const actionFilter = c.req.query("action")
  const limit = Math.max(1, parseIntParam(c.req.query("limit"), 100))
  const offset = Math.max(0, parseIntParam(c.req.query("offset"), 0))

  const events = readAuditEvents(dateStr, actionFilter)
  const total = events.length
  const page = events.slice(offset, offset + limit)
  const has_more = offset + limit < total

  return c.json({ events: page, total, has_more })
})

export { auditAdminRoute }
