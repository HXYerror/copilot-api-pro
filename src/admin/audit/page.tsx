/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx"

import type { AuditEvent } from "~/services/audit"

import { Layout } from "../layout"

interface AuditPageProps {
  csrfToken: string
  date: string // YYYY-MM-DD
  actionFilter: string
  events: Array<AuditEvent>
  total: number
  limit: number
  offset: number
  hasMore: boolean
  availableActions: ReadonlyArray<string>
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} `
    + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`
  )
}

function shortKeyId(id: string): string {
  if (id.startsWith("__")) return id // sentinel like __system__, __noauth__
  if (id.length <= 8) return id
  return `…${id.slice(-8)}`
}

function describeChange(ev: AuditEvent): string {
  // Compact summary for the table — full payload is in the details row.
  if (ev.target) return ev.target
  return ""
}

const Pager: FC<{
  date: string
  action: string
  limit: number
  offset: number
  total: number
  hasMore: boolean
}> = ({ date, action, limit, offset, total, hasMore }) => {
  const qs = (off: number): string => {
    const params = new URLSearchParams()
    params.set("date", date)
    if (action) params.set("action", action)
    params.set("limit", String(limit))
    params.set("offset", String(off))
    return `?${params.toString()}`
  }
  const prevOff = Math.max(0, offset - limit)
  const nextOff = offset + limit
  const showingFrom = total === 0 ? 0 : offset + 1
  const showingTo = Math.min(offset + limit, total)
  return (
    <div class="audit-pager">
      <span class="muted">
        Showing {showingFrom}–{showingTo} of {total}
      </span>
      <div class="audit-pager__buttons">
        {offset > 0 && (
          <a class="btn" href={qs(prevOff)}>
            ← Prev
          </a>
        )}
        {hasMore && (
          <a class="btn" href={qs(nextOff)}>
            Next →
          </a>
        )}
      </div>
    </div>
  )
}

export const AuditPage: FC<AuditPageProps> = ({
  csrfToken,
  date,
  actionFilter,
  events,
  total,
  limit,
  offset,
  hasMore,
  availableActions,
}) => (
  <Layout title="Audit" active="audit" csrfToken={csrfToken}>
    <div class="audit-page">
      <h1>Audit log</h1>
      <p class="muted">
        Append-only JSONL at{" "}
        <code>~/.local/share/copilot-api/audit-YYYY-MM-DD.jsonl</code>. Records
        admin actions (key CRUD, debug toggle, config edits) and security events
        (auth rejections, no-auth boot).
      </p>

      <form method="get" action="/admin/audit" class="audit-filter">
        <label>
          <span>Date</span>
          <input type="date" name="date" value={date} required />
        </label>
        <label>
          <span>Action</span>
          <select name="action">
            <option value="">(all)</option>
            {availableActions.map((a) => (
              <option key={a} value={a} selected={a === actionFilter}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <input type="hidden" name="limit" value={String(limit)} />
        <button type="submit" class="btn btn-primary">
          Apply
        </button>
        <a class="btn" href="/admin/audit">
          Reset
        </a>
      </form>

      {events.length === 0 ?
        <p class="muted">
          No audit events for <code>{date}</code>
          {actionFilter ?
            <>
              {" "}
              with action <code>{actionFilter}</code>
            </>
          : ""}
          .
        </p>
      : <table class="audit-table">
          <thead>
            <tr>
              <th>Time (UTC)</th>
              <th>Actor</th>
              <th>Tier</th>
              <th>Action</th>
              <th>Target</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev, i) => (
              <tr key={`${ev.ts}-${i}`}>
                <td class="mono">{formatTs(ev.ts)}</td>
                <td class="mono">{shortKeyId(ev.actor_key_id)}</td>
                <td>
                  <span class={`badge badge-${ev.actor_tier}`}>
                    {ev.actor_tier}
                  </span>
                </td>
                <td class="mono">{ev.action}</td>
                <td class="mono">{describeChange(ev)}</td>
                <td class="mono">{ev.ip ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }

      <Pager
        date={date}
        action={actionFilter}
        limit={limit}
        offset={offset}
        total={total}
        hasMore={hasMore}
      />
    </div>
  </Layout>
)
