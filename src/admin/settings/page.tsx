/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx"

import type { Config } from "~/lib/config-store"

// ---------------------------------------------------------------------------
// Settings page — server-rendered form for editing config.json
//
// Sections:
//   1. Models — alias table (add/edit/remove)
//   2. Retention — events_days / traces_days / traces_max_bytes / audit_days
//   3. Features — telemetry / debug (auth toggle deliberately omitted; see D-004)
// ---------------------------------------------------------------------------

interface SettingsPageProps {
  config: Config
  csrfToken: string
  /** Optional banners */
  error?: string
  success?: string
}

export const SettingsPage: FC<SettingsPageProps> = ({
  config,
  csrfToken,
  error,
  success,
}) => (
  <div class="settings-page">
    <h1>Settings</h1>
    {error && <p class="form-error">{error}</p>}
    {success && <p class="form-success">{success}</p>}
    <p class="muted">
      Edits are written atomically to{" "}
      <code>~/.local/share/copilot-api/config.json</code> and hot-reloaded on
      the next request. Authentication state is intentionally not editable from
      this page — change it via CLI flags or by editing the file directly.
    </p>
    <form
      method="post"
      action="/admin/settings"
      id="settings-form"
      class="settings-form"
    >
      <input type="hidden" name="csrf_token" value={csrfToken} />
      <ModelsSection models={config.models} />
      <RetentionSection retention={config.retention} />
      <FeaturesSection features={config.features} />
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          Save Settings
        </button>
        <a href="/admin" class="btn">
          Cancel
        </a>
      </div>
    </form>
  </div>
)

// ---------------------------------------------------------------------------

const ModelsSection: FC<{ models: Config["models"] }> = ({ models }) => (
  <section class="settings-section">
    <h2>Model Aliases</h2>
    <p class="muted">
      Map a user-facing alias to an upstream Copilot model id. Set
      <code> enabled=false</code> to hide an alias from <code>/v1/models</code>.
    </p>
    <table class="settings-table">
      <thead>
        <tr>
          <th>Alias</th>
          <th>Upstream</th>
          <th>Enabled</th>
          <th />
        </tr>
      </thead>
      <tbody id="models-tbody">
        {Object.entries(models).map(([alias, entry], i) => (
          <ModelRow key={alias} index={i} alias={alias} entry={entry} />
        ))}
        {/* Empty trailing row for adding new aliases */}
        <ModelRow
          index={Object.keys(models).length}
          alias=""
          entry={{ upstream: "", enabled: true, allowed_keys: ["*"] }}
        />
      </tbody>
    </table>
    <p class="muted">
      <em>
        Tip: leave alias blank to delete that row when you save. Add a new row
        by filling the empty trailing row.
      </em>
    </p>
  </section>
)

const RetentionSection: FC<{ retention: Config["retention"] }> = ({
  retention,
}) => (
  <section class="settings-section">
    <h2>Retention</h2>
    <div class="form-grid">
      <label>
        <span>events_days</span>
        <input
          type="number"
          name="retention_events_days"
          min="0"
          value={String(retention.events_days)}
        />
        <small class="muted">
          Telemetry rows older than this are deleted hourly.
        </small>
      </label>
      <label>
        <span>traces_days</span>
        <input
          type="number"
          name="retention_traces_days"
          min="0"
          value={String(retention.traces_days)}
        />
        <small class="muted">
          <strong>0 = in-memory only</strong> (live tail works, nothing on
          disk). Set &gt; 0 to opt into on-disk persistence.
        </small>
      </label>
      <label>
        <span>traces_max_bytes</span>
        <input
          type="number"
          name="retention_traces_max_bytes"
          min="0"
          value={String(retention.traces_max_bytes)}
        />
        <small class="muted">
          Hard cap on total bytes of trace JSONL files. Oldest day evicted when
          exceeded.
        </small>
      </label>
      <label>
        <span>audit_days</span>
        <input
          type="number"
          name="retention_audit_days"
          min="0"
          value={String(retention.audit_days)}
        />
        <small class="muted">Audit JSONL retention.</small>
      </label>
    </div>
  </section>
)

const FeaturesSection: FC<{ features: Config["features"] }> = ({
  features,
}) => (
  <section class="settings-section">
    <h2>Features</h2>
    <div class="form-grid">
      <label class="checkbox-item">
        <input
          type="checkbox"
          name="features_telemetry"
          value="1"
          checked={features.telemetry}
        />
        <span>Telemetry (placeholder, currently unused)</span>
      </label>
      <label class="checkbox-item">
        <input
          type="checkbox"
          name="features_debug"
          value="1"
          checked={features.debug}
        />
        <span>Debug (placeholder, currently unused)</span>
      </label>
    </div>
    <p class="muted">
      Auth (<code>features.auth</code>) is intentionally not editable here. To
      disable authentication, restart with <code>--no-auth</code> (loopback
      only) or set <code>features.auth=false</code> in config.json directly. See{" "}
      <code>--i-accept-account-suspension-risk</code> for non-loopback exposure.
    </p>
  </section>
)

interface ModelRowProps {
  index: number
  alias: string
  entry: { upstream: string; enabled?: boolean; allowed_keys?: Array<string> }
}

const ModelRow: FC<ModelRowProps> = ({ index, alias, entry }) => (
  <tr>
    <td>
      <input
        type="text"
        name={`model_${index}_alias`}
        value={alias}
        placeholder="(leave blank to skip)"
        maxlength="100"
      />
    </td>
    <td>
      <input
        type="text"
        name={`model_${index}_upstream`}
        value={entry.upstream}
        placeholder="claude-sonnet-4.5"
        maxlength="200"
      />
    </td>
    <td>
      <input
        type="checkbox"
        name={`model_${index}_enabled`}
        value="1"
        checked={entry.enabled !== false}
      />
    </td>
    <td>
      {/* Allowed_keys editing not exposed here — defaults to ["*"]. Use
          /admin/keys for fine-grained per-key model scoping. */}
    </td>
  </tr>
)
