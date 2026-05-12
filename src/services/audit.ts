import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { getConfig } from "~/lib/config-store"
import { PATHS } from "~/lib/paths"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEvent {
  ts: number // Date.now() ms
  actor_key_id: string // key.id or "__noauth__" or "__system__"
  actor_tier: string // "admin" | "client" | "system"
  action: string // e.g. "key.create", "auth.reject", etc.
  target?: string // e.g. key id, config field name
  before?: unknown // previous value (for changes)
  after?: unknown // new value (for changes)
  ip?: string // x-forwarded-for or remote addr
  user_agent?: string // user-agent header
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Returns the audit JSONL file path for a given date string (YYYY-MM-DD). */
export function auditFilePath(dateStr: string): string {
  return path.join(PATHS.APP_DIR, `audit-${dateStr}.jsonl`)
}

/** Returns today's date string in YYYY-MM-DD format (local time). */
export function todayDateStr(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

// ---------------------------------------------------------------------------
// appendAudit — synchronous, atomic O_APPEND write
// ---------------------------------------------------------------------------

/**
 * Append a single AuditEvent as a JSONL line.
 * Opens the file with O_APPEND | O_CREAT, mode 0600 — atomically appends on
 * POSIX systems (write(2) on O_APPEND is atomic for writes ≤ PIPE_BUF).
 * Creates parent directory (0700) if needed.
 */
export function appendAudit(event: AuditEvent): void {
  const filePath = auditFilePath(todayDateStr())
  const dir = path.dirname(filePath)
  // Ensure directory exists with restrictive permissions
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  const line = JSON.stringify(event) + os.EOL
  // O_APPEND ensures kernel-level atomic appends on POSIX
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
    0o600,
  )
  try {
    fs.writeSync(fd, line)
  } finally {
    fs.closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// audit — convenience wrapper that fills in ts
// ---------------------------------------------------------------------------

/** Append an audit event, automatically setting ts = Date.now(). */
export function audit(event: Omit<AuditEvent, "ts">): void {
  appendAudit({ ts: Date.now(), ...event })
}

// ---------------------------------------------------------------------------
// initAudit — called on startup to prune old audit files
// ---------------------------------------------------------------------------

/**
 * Delete audit JSONL files older than retention.audit_days.
 * Files matching the pattern audit-YYYY-MM-DD.jsonl in APP_DIR are examined;
 * any whose date is strictly older than (today − audit_days) are removed.
 * Files that do not match the pattern are left untouched.
 */
export function initAudit(): void {
  const retentionDays = getConfig().retention.audit_days
  // 0 means keep forever
  if (retentionDays === 0) return

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const dir = PATHS.APP_DIR

  let entries: Array<string>
  try {
    entries = fs.readdirSync(dir)
  } catch {
    // Directory doesn't exist yet — nothing to prune
    return
  }

  for (const entry of entries) {
    const match = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry)
    if (!match) continue
    const dateStr = match[1]
    const fileDate = new Date(`${dateStr}T00:00:00`)
    if (fileDate.getTime() < cutoffMs) {
      try {
        fs.unlinkSync(path.join(dir, entry))
      } catch {
        // Best-effort: ignore if already gone
      }
    }
  }
}
