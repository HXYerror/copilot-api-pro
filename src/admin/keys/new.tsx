/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx"

import { getConfig } from "~/lib/config-store"

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const DEBUG_MODAL_SCRIPT = `
(function() {
  var cb = document.getElementById('debug-checkbox');
  var modal = document.getElementById('debug-modal');
  var confirmBtn = document.getElementById('debug-confirm');
  var cancelBtn = document.getElementById('debug-cancel');
  var confirmed = false;

  cb.addEventListener('change', function() {
    if (cb.checked && !confirmed) {
      cb.checked = false;
      modal.style.display = 'flex';
    } else if (!cb.checked) {
      confirmed = false;
    }
  });

  confirmBtn.addEventListener('click', function() {
    confirmed = true;
    cb.checked = true;
    modal.style.display = 'none';
  });

  cancelBtn.addEventListener('click', function() {
    confirmed = false;
    cb.checked = false;
    modal.style.display = 'none';
  });
})();
`.trim()

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
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: intentional inline script for admin-only page
        dangerouslySetInnerHTML={{ __html: DEBUG_MODAL_SCRIPT }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Flash banner: one-time key display
// ---------------------------------------------------------------------------

const KEY_GATE_SCRIPT = `
(function(){
  var gate = document.getElementById('copied-gate');
  var link = document.getElementById('continue-link');
  gate.addEventListener('change', function() {
    link.style.pointerEvents = gate.checked ? '' : 'none';
    link.style.opacity = gate.checked ? '1' : '0.5';
  });
  window.addEventListener('beforeunload', function(e) {
    if (!gate.checked) {
      e.preventDefault();
      e.returnValue = 'Have you copied your API key?';
    }
  });
})();
`.trim()

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
      <button
        type="button"
        class="btn btn-sm"
        onclick={`navigator.clipboard.writeText(document.getElementById('plain-key').textContent).then(function(){this.textContent='Copied!'}.bind(this),function(){})`}
      >
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
    <script
      // biome-ignore lint/security/noDangerouslySetInnerHtml: intentional inline script for admin-only page
      dangerouslySetInnerHTML={{ __html: KEY_GATE_SCRIPT }}
    />
  </div>
)
