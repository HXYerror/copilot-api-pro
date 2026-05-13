/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx"

import { getConfig } from "~/lib/config-store"

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const DebugConfirmModal: FC<{ tracesDays: number }> = ({ tracesDays }) => (
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
      <p>This can expose sensitive information. Only enable for debugging.</p>
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
)

const NewKeyFormFields: FC<{ modelAliases: Array<string> }> = ({
  modelAliases,
}) => (
  <>
    <div class="form-field">
      <label for="label">Label *</label>
      <input
        id="label"
        type="text"
        name="label"
        placeholder="e.g. claude-code-laptop"
        required
        maxlength="200"
      />
    </div>

    <div class="form-field">
      <label for="tier">Tier</label>
      <select id="tier" name="tier">
        <option value="client">client</option>
        <option value="admin">admin</option>
      </select>
    </div>

    <div class="form-field">
      <label>Allowed Models</label>
      <div class="checkbox-group">
        <label class="checkbox-item">
          <input type="checkbox" name="allowed_models" value="*" checked />
          <span>* (all models)</span>
        </label>
        {modelAliases.map((alias) => (
          <label key={alias} class="checkbox-item">
            <input type="checkbox" name="allowed_models" value={alias} />
            <span>{alias}</span>
          </label>
        ))}
      </div>
      {/* Sentinel: a present-but-empty value means "the form intentionally
          submitted models" so an unchecked-everything submission can be rejected
          server-side rather than silently widened to "*". */}
      <input type="hidden" name="allowed_models_present" value="1" />
    </div>

    <div class="form-field">
      <label for="rate_limit">Rate Limit (seconds between requests)</label>
      <input
        id="rate_limit"
        type="number"
        name="rate_limit_override"
        placeholder="blank = use server default"
        min="0"
      />
    </div>

    <div class="form-field">
      <label class="checkbox-item" id="debug-label">
        <input
          type="checkbox"
          name="debug_enabled"
          id="debug-checkbox"
          value="1"
        />
        <span>Enable debug mode (persists traces for 24h)</span>
      </label>
      {/* Populated by keys.js to "yes" after the modal is acknowledged.
          The server REJECTS debug_enabled=1 without debug_confirm=yes — this
          is the actual gate, not just UX. */}
      <input
        type="hidden"
        id="debug-confirm-field"
        name="debug_confirm"
        value=""
      />
    </div>
  </>
)

// ---------------------------------------------------------------------------
// New key form
// ---------------------------------------------------------------------------

interface NewKeyFormProps {
  csrfToken: string
  error?: string
  /** Retention days from config, for the debug warning modal text */
  tracesDays: number
}

export const NewKeyForm: FC<NewKeyFormProps> = ({
  csrfToken,
  error,
  tracesDays,
}) => {
  const config = getConfig()
  const modelAliases = Object.keys(config.models)

  return (
    <div class="new-key-form">
      <h1>Create New API Key</h1>
      {error && <p class="form-error">{error}</p>}
      <DebugConfirmModal tracesDays={tracesDays} />
      <form method="post" action="/admin/keys/new" id="new-key-form">
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <NewKeyFormFields modelAliases={modelAliases} />
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">
            Create Key
          </button>
          <a href="/admin/keys" class="btn">
            Cancel
          </a>
        </div>
      </form>
      <script src="/admin/assets/keys.js" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Flash banner: one-time key display
// ---------------------------------------------------------------------------

interface KeyCreatedBannerProps {
  plain: string
  keyId: string
}

export const KeyCreatedBanner: FC<KeyCreatedBannerProps> = ({
  plain,
  keyId,
}) => (
  <div class="key-created-banner">
    <h2>✅ Key Created</h2>
    <p>
      <strong>Copy this key now.</strong> It will never be shown again after you
      leave this page.
    </p>
    <div class="key-value-row">
      <code id="plain-key" class="key-value">
        {plain}
      </code>
      <button type="button" id="copy-btn" class="btn btn-sm">
        Copy
      </button>
    </div>
    <div class="key-gate">
      <label class="checkbox-item">
        <input type="checkbox" id="copied-gate" />
        <span>I have copied this key and stored it safely</span>
      </label>
      <a
        href={`/admin/keys/${keyId}`}
        id="continue-link"
        class="btn btn-primary"
        style="pointer-events:none;opacity:0.5"
      >
        Continue to key details →
      </a>
    </div>
    <script src="/admin/assets/keys.js" />
  </div>
)
