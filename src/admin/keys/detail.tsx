/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx"

import type { KeyUsageSummary, RecentCallRow } from "~/admin/usage/queries"
import type { KeyRow } from "~/services/keys"

import { isDebugActive } from "~/services/keys"

import { fmtDate, fmtModels } from "./list"

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const KeyMeta: FC<{ row: KeyRow; expiresStr: string }> = ({
  row,
  expiresStr,
}) => {
  const debugOn = isDebugActive(row)
  return (
    <div class="key-meta">
      <dl>
        <dt>Full ID</dt>
        <dd class="mono">{row.id}</dd>
        <dt>Tier</dt>
        <dd>
          <span class={`badge badge-${row.tier}`}>{row.tier}</span>
        </dd>
        <dt>Created</dt>
        <dd>{fmtDate(row.created_at)}</dd>
        <dt>Models</dt>
        <dd>{fmtModels(row.allowed_models)}</dd>
        <dt>Rate Limit</dt>
        <dd>
          {row.rate_limit_override !== null ?
            `${row.rate_limit_override}s`
          : "default"}
        </dd>
        <dt>Debug Mode</dt>
        <dd>
          {debugOn ?
            <span class="badge badge-debug">ON{expiresStr}</span>
          : "off"}
        </dd>
      </dl>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Usage summary — three windows (24h / 7d / 30d) + recent calls table.
// Data is fetched in the route handler via usageForKey() + recentCallsForKey().
// ---------------------------------------------------------------------------

interface UsageSectionProps {
  usage24h: KeyUsageSummary
  usage7d: KeyUsageSummary
  usage30d: KeyUsageSummary
  recent: Array<RecentCallRow>
  keyId: string
}

function fmtRelativeTs(ts: number | null): string {
  if (ts === null) return "Never used"
  const ageMs = Date.now() - ts
  if (ageMs < 60_000) return "just now"
  if (ageMs < 3600_000) return `${Math.floor(ageMs / 60_000)}m ago`
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3600_000)}h ago`
  return `${Math.floor(ageMs / 86_400_000)}d ago`
}

const UsageStatRow: FC<{ label: string; usage: KeyUsageSummary }> = ({
  label,
  usage,
}) => (
  <tr>
    <th>{label}</th>
    <td>{usage.total_requests}</td>
    <td>{usage.total_prompt_tokens}</td>
    <td>{usage.total_completion_tokens}</td>
    <td>
      {(usage.error_rate * 100).toFixed(1)}% ({usage.errors})
    </td>
    <td>
      {usage.p95_latency_ms !== null ? `${usage.p95_latency_ms} ms` : "—"}
    </td>
  </tr>
)

const UsageSection: FC<UsageSectionProps> = ({
  usage24h,
  usage7d,
  usage30d,
  recent,
  keyId,
}) => (
  <section class="key-section">
    <h2>Usage</h2>
    <p class="muted">
      Last used: <strong>{fmtRelativeTs(usage30d.last_used_ts)}</strong>{" "}
      &nbsp;·&nbsp;{" "}
      <a href={`/admin/usage?range=24h&key_id=${keyId}`}>
        Open full dashboard →
      </a>
    </p>
    <table class="usage-stats">
      <thead>
        <tr>
          <th>Window</th>
          <th>Requests</th>
          <th>Prompt tokens</th>
          <th>Completion tokens</th>
          <th>Error rate</th>
          <th>p95 latency</th>
        </tr>
      </thead>
      <tbody>
        <UsageStatRow label="24h" usage={usage24h} />
        <UsageStatRow label="7d" usage={usage7d} />
        <UsageStatRow label="30d" usage={usage30d} />
      </tbody>
    </table>
    {recent.length > 0 && (
      <>
        <h3>Recent calls (newest 20)</h3>
        <table class="usage-recent">
          <thead>
            <tr>
              <th>Time</th>
              <th>Model</th>
              <th>Status</th>
              <th>Latency</th>
              <th>Tokens (p/c)</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r, i) => (
              <tr key={i}>
                <td>{fmtDate(r.ts)}</td>
                <td>{r.model}</td>
                <td>{r.status}</td>
                <td>{r.latency_ms} ms</td>
                <td>
                  {r.prompt_tokens ?? "?"} / {r.completion_tokens ?? "?"}
                </td>
                <td>{r.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    )}
    {recent.length === 0 && (
      <p class="muted">
        <em>No calls recorded for this key yet.</em>
      </p>
    )}
  </section>
)

const EditScopeForm: FC<{
  row: KeyRow
  csrfToken: string
  allowedModels: Array<string>
  availableAliases: Array<string>
}> = ({ row, csrfToken, allowedModels, availableAliases }) => {
  // Surface any aliases the key still references but that no longer exist
  // in config — operators can untick them to clean up. (Aliases removed
  // from config silently stop matching, but stay in the JSON until edited.)
  const orphans = allowedModels.filter(
    (m) => m !== "*" && !availableAliases.includes(m),
  )
  return (
    <section class="key-section">
      <h2>Edit Scope</h2>
      <form method="post" action={`/admin/keys/${row.id}/scope`}>
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <div class="form-field">
          <label>Allowed Models</label>
          <div class="checkbox-group">
            <label class="checkbox-item">
              <input
                type="checkbox"
                name="allowed_models"
                value="*"
                checked={allowedModels.includes("*")}
              />
              <span>* (all models)</span>
            </label>
            {availableAliases.map((alias) => (
              <label key={alias} class="checkbox-item">
                <input
                  type="checkbox"
                  name="allowed_models"
                  value={alias}
                  checked={allowedModels.includes(alias)}
                />
                <span>{alias}</span>
              </label>
            ))}
            {orphans.map((alias) => (
              <label key={alias} class="checkbox-item">
                <input
                  type="checkbox"
                  name="allowed_models"
                  value={alias}
                  checked
                />
                <span>
                  {alias}{" "}
                  <em class="muted">(not in config — untick to remove)</em>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div class="form-field">
          <label for="rate_limit_edit">Rate Limit (s, blank = default)</label>
          <input
            id="rate_limit_edit"
            type="number"
            name="rate_limit_override"
            value={row.rate_limit_override?.toString() ?? ""}
            min="0"
            placeholder="blank = use server default"
          />
        </div>
        <button type="submit" class="btn btn-primary">
          Save Scope
        </button>
      </form>
    </section>
  )
}

const DebugEnabledControls: FC<{
  row: KeyRow
  csrfToken: string
  tracesDays: number
  expiresStr: string
}> = ({ row, csrfToken, tracesDays, expiresStr }) => (
  <>
    <p class="debug-warning">
      Debug is <strong>ON</strong>. Traces persist in plaintext. Retention:{" "}
      {tracesDays} days.{expiresStr}
    </p>
    {/* Disable form */}
    <form
      method="post"
      action={`/admin/keys/${row.id}/debug`}
      style="display:inline"
    >
      <input type="hidden" name="csrf_token" value={csrfToken} />
      <input type="hidden" name="debug_enabled" value="0" />
      <button type="submit" class="btn btn-sm">
        Disable Debug
      </button>
    </form>
    {/* Renew form: separate POST with action=renew so the handler bumps TTL
        instead of clearing it (the previous shared form silently disabled). */}
    <form
      method="post"
      action={`/admin/keys/${row.id}/debug`}
      style="display:inline"
    >
      <input type="hidden" name="csrf_token" value={csrfToken} />
      <input type="hidden" name="action" value="renew" />
      <input type="hidden" name="debug_confirm" value="yes" />
      <button type="submit" class="btn btn-sm btn-warning">
        Renew 24h TTL
      </button>
    </form>
  </>
)

const DebugDisabledControls: FC<{
  row: KeyRow
  csrfToken: string
  tracesDays: number
}> = ({ row, csrfToken, tracesDays }) => (
  <>
    <div id="debug-modal" class="modal" style="display:none">
      <div class="modal-backdrop" />
      <div class="modal-box">
        <h2>⚠️ Enable Debug Mode?</h2>
        <p>
          Prompts and responses for this key will be persisted in plaintext at{" "}
          <code>~/.local/share/copilot-api/traces/</code>.
        </p>
        <p>
          <strong>Retention:</strong> {tracesDays} days.{" "}
          <strong>Auto-disables in 24 hours</strong> unless renewed.
        </p>
        <div class="modal-actions">
          <button type="button" id="debug-confirm" class="btn btn-danger">
            I understand — enable debug
          </button>
          <button type="button" id="debug-cancel" class="btn">
            Cancel
          </button>
        </div>
      </div>
    </div>
    <form method="post" action={`/admin/keys/${row.id}/debug`} id="debug-form">
      <input type="hidden" name="csrf_token" value={csrfToken} />
      <input type="hidden" name="debug_enabled" value="1" />
      {/* keys.js sets this to "yes" after the modal is acknowledged.
          The server REJECTS debug_enabled=1 without it. */}
      <input
        type="hidden"
        id="debug-confirm-field"
        name="debug_confirm"
        value=""
      />
      <button type="submit" id="debug-btn" class="btn btn-warning">
        Enable Debug (24h)
      </button>
    </form>
  </>
)

const RevokeSection: FC<{ row: KeyRow; csrfToken: string }> = ({
  row,
  csrfToken,
}) => (
  <section class="key-section key-section--danger">
    <h2>Danger Zone</h2>
    <form
      method="post"
      action={`/admin/keys/${row.id}/revoke`}
      data-confirm="Revoke this key? This cannot be undone."
    >
      <input type="hidden" name="csrf_token" value={csrfToken} />
      <button type="submit" class="btn btn-danger">
        Revoke Key
      </button>
    </form>
  </section>
)

// ---------------------------------------------------------------------------
// Key detail / edit page
// ---------------------------------------------------------------------------

interface KeyDetailProps {
  row: KeyRow
  csrfToken: string
  tracesDays: number
  /** All alias names from config — feeds the Allowed Models checkbox list. */
  availableAliases: Array<string>
  error?: string
  success?: string
  /** Per-key usage stats (added in task #26). */
  usage24h: KeyUsageSummary
  usage7d: KeyUsageSummary
  usage30d: KeyUsageSummary
  recent: Array<RecentCallRow>
}

export const KeyDetail: FC<KeyDetailProps> = ({
  row,
  csrfToken,
  tracesDays,
  availableAliases,
  error,
  success,
  usage24h,
  usage7d,
  usage30d,
  recent,
}) => {
  const isRevoked = row.revoked_at !== null
  const debugOn = isDebugActive(row)
  const idSuffix = row.id.slice(-8)
  const expiresStr =
    row.debug_expires_at ?
      ` — auto-disables ${fmtDate(row.debug_expires_at)}`
    : ""

  let allowedModels: Array<string> = ["*"]
  try {
    allowedModels = JSON.parse(row.allowed_models) as Array<string>
  } catch {
    // keep default
  }

  return (
    <div class="key-detail">
      <div class="key-detail__header">
        <h1>
          Key <span class="mono">…{idSuffix}</span>
        </h1>
        {row.label && <p class="key-label">{row.label}</p>}
        {isRevoked && (
          <p class="badge badge-revoked badge-lg">
            Revoked {fmtDate(row.revoked_at ?? 0)}
          </p>
        )}
      </div>
      {error && <p class="form-error">{error}</p>}
      {success && <p class="form-success">{success}</p>}
      <KeyMeta row={row} expiresStr={expiresStr} />
      <UsageSection
        usage24h={usage24h}
        usage7d={usage7d}
        usage30d={usage30d}
        recent={recent}
        keyId={row.id}
      />
      {!isRevoked && (
        <>
          <EditScopeForm
            row={row}
            csrfToken={csrfToken}
            allowedModels={allowedModels}
            availableAliases={availableAliases}
          />
          <section class="key-section">
            <h2>Debug Mode</h2>
            {debugOn ?
              <DebugEnabledControls
                row={row}
                csrfToken={csrfToken}
                tracesDays={tracesDays}
                expiresStr={expiresStr}
              />
            : <DebugDisabledControls
                row={row}
                csrfToken={csrfToken}
                tracesDays={tracesDays}
              />
            }
          </section>
          <RevokeSection row={row} csrfToken={csrfToken} />
        </>
      )}
      <script src="/admin/assets/keys.js" />
    </div>
  )
}
