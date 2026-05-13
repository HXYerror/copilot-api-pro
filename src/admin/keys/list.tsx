/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx"

import type { KeyRow } from "~/services/keys"

import { isDebugActive } from "~/services/keys"

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function fmtDate(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC"
}

export function fmtModels(jsonStr: string): string {
  try {
    const arr = JSON.parse(jsonStr) as Array<string>
    return arr.join(", ")
  } catch {
    return jsonStr
  }
}

// ---------------------------------------------------------------------------
// Key list component
// ---------------------------------------------------------------------------

interface KeyListProps {
  keys: Array<KeyRow>
  total: number
  page: number
  pageSize: number
  csrfToken: string
}

export const KeyList: FC<KeyListProps> = ({
  keys,
  total,
  page,
  pageSize,
  csrfToken,
}) => {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const prevPage = page > 1 ? page - 1 : null
  const nextPage = page < totalPages ? page + 1 : null

  return (
    <div class="keys-list">
      <div class="keys-list__header">
        <h1>API Keys</h1>
        <a href="/admin/keys/new" class="btn btn-primary">
          + New Key
        </a>
      </div>
      <p class="keys-list__count">
        {total} key{total !== 1 ? "s" : ""} total
      </p>
      <div class="table-wrap">
        <table class="keys-table">
          <thead>
            <tr>
              <th>ID (last 8)</th>
              <th>Label</th>
              <th>Tier</th>
              <th>Models</th>
              <th>Rate Limit</th>
              <th>Debug</th>
              <th>Created</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <KeyRow key={k.id} row={k} csrfToken={csrfToken} />
            ))}
          </tbody>
        </table>
      </div>
      <div class="pagination">
        {prevPage !== null && (
          <a href={`/admin/keys?page=${prevPage}`} class="btn btn-sm">
            ← Prev
          </a>
        )}
        <span class="pagination__info">
          Page {page} of {totalPages}
        </span>
        {nextPage !== null && (
          <a href={`/admin/keys?page=${nextPage}`} class="btn btn-sm">
            Next →
          </a>
        )}
      </div>
      <script src="/admin/assets/keys.js" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Single row component
// ---------------------------------------------------------------------------

interface KeyRowProps {
  row: KeyRow
  csrfToken: string
}

const KeyRow: FC<KeyRowProps> = ({ row, csrfToken }) => {
  const isRevoked = row.revoked_at !== null
  const debugOn = isDebugActive(row)
  const idSuffix = row.id.slice(-8)
  const expiresStr =
    row.debug_expires_at ? ` (exp ${fmtDate(row.debug_expires_at)})` : ""

  return (
    <tr class={isRevoked ? "row-revoked" : ""}>
      <td class="mono" title={row.id}>
        {idSuffix}
      </td>
      <td>{row.label ?? <span class="muted">—</span>}</td>
      <td>
        <span class={`badge badge-${row.tier}`}>{row.tier}</span>
      </td>
      <td class="models-cell">{fmtModels(row.allowed_models)}</td>
      <td>
        {row.rate_limit_override !== null ?
          `${row.rate_limit_override}s`
        : "default"}
      </td>
      <td>
        {debugOn ?
          <span class="badge badge-debug" title={`Debug on${expiresStr}`}>
            ON{expiresStr}
          </span>
        : <span class="muted">off</span>}
      </td>
      <td>{fmtDate(row.created_at)}</td>
      <td>
        {isRevoked ?
          <span class="badge badge-revoked">revoked</span>
        : <span class="badge badge-active">active</span>}
      </td>
      <td class="actions-cell">
        <a href={`/admin/keys/${row.id}`} class="btn btn-sm">
          Edit
        </a>
        {!isRevoked && (
          <form
            method="post"
            action={`/admin/keys/${row.id}/revoke`}
            class="inline-form"
            data-confirm="Revoke this key? This cannot be undone."
          >
            <input type="hidden" name="csrf_token" value={csrfToken} />
            <button type="submit" class="btn btn-sm btn-danger">
              Revoke
            </button>
          </form>
        )}
      </td>
    </tr>
  )
}
