/** @jsxImportSource hono/jsx */
import { Hono } from "hono"
import fs from "node:fs"

import type { SessionVar } from "~/admin/session-middleware"
import type { AuditEvent } from "~/services/audit"

import { ADMIN_SECURITY_HEADERS } from "~/admin/layout"
import { auditFilePath, todayDateStr } from "~/services/audit"

import { AuditPage } from "./page"

// ---------------------------------------------------------------------------
// Param parsing
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
  // Newest first — matches every other admin page.
  return events.reverse()
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const auditAdminRoute = new Hono<{ Variables: SessionVar }>()

auditAdminRoute.get("/", (c) => {
  const dateStr = parseDateParam(c.req.query("date"))
  const actionFilterRaw = c.req.query("action")
  const actionFilter =
    actionFilterRaw && actionFilterRaw.length > 0 ? actionFilterRaw : undefined
  const limit = Math.max(
    1,
    Math.min(500, parseIntParam(c.req.query("limit"), 100)),
  )
  const offset = Math.max(0, parseIntParam(c.req.query("offset"), 0))

  const events = readAuditEvents(dateStr, actionFilter)
  const total = events.length
  const page = events.slice(offset, offset + limit)
  const hasMore = offset + limit < total

  // Distinct action list for the filter dropdown — built from the loaded
  // (already date-filtered) events so it always reflects what's on disk for
  // the chosen day. Sorted for stable rendering.
  const availableActions = [...new Set(events.map((e) => e.action))].sort()

  // Accept-aware: keep a JSON shape for scripted callers (jq, dashboards).
  const accept = c.req.header("accept") ?? ""
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return c.json({ events: page, total, has_more: hasMore })
  }

  const session = c.get("session")
  return c.html(
    <AuditPage
      csrfToken={session.csrf_token}
      date={dateStr}
      actionFilter={actionFilter ?? ""}
      events={page}
      total={total}
      limit={limit}
      offset={offset}
      hasMore={hasMore}
      availableActions={availableActions}
    />,
    200,
    ADMIN_SECURITY_HEADERS,
  )
})
