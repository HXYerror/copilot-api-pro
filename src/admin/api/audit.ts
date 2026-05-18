/**
 * /admin/api/audit — JSON audit-log browser for the SPA timeline.
 *
 * GET /admin/api/audit
 *   ?date=YYYY-MM-DD     (defaults to today)
 *   ?action=key.create   (optional, exact match)
 *   ?limit=100 ?offset=0
 *
 * The legacy SSR route already returned JSON when Accept was
 * application/json, but this re-mounts it under /api/* so the SPA's
 * fetch client uses a consistent prefix and 401 handling.
 */

import { Hono } from "hono"
import fs from "node:fs"

import { auditFilePath, todayDateStr } from "~/services/audit"
import type { AuditEvent } from "~/services/audit"

import type { SessionVar } from "../session-middleware"

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
  return events.reverse()
}

export const auditApiRoute = new Hono<{ Variables: SessionVar }>()

auditApiRoute.get("/", (c) => {
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
  const availableActions = [...new Set(events.map((e) => e.action))].sort()

  // Hourly bucket counts by action for the timeline chart.
  // Buckets keyed by hour-of-day (0-23) → action → count.
  const buckets: Array<Record<string, number | string>> = []
  for (let h = 0; h < 24; h++) {
    buckets.push({ hour: `${h.toString().padStart(2, "0")}:00` })
  }
  for (const ev of events) {
    const hour = new Date(ev.ts).getHours()
    const bucket = buckets[hour]
    if (!bucket) continue
    bucket[ev.action] = ((bucket[ev.action] as number) ?? 0) + 1
  }

  return c.json({
    date: dateStr,
    events: page,
    total,
    has_more: hasMore,
    available_actions: availableActions,
    hourly: buckets,
  })
})
