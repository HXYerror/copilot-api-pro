/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx"

import type { KeyRow } from "~/services/keys"

import type {
  ErrorRateRow,
  LatencyPoint,
  RpmPoint,
  TimeRange,
  TokensPoint,
  TopKey,
  TopModel,
} from "./queries"

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

export interface UsageFilterValues {
  range: TimeRange
  since: number
  until: number
  keyIds: Array<string>
  models: Array<string>
}

export interface UsageStats {
  totalRequests: number
  totalTokens: number
  errorRate: number
}

export interface UsagePageProps {
  csrfToken: string
  filter: UsageFilterValues
  /** All non-revoked keys, for the multiselect */
  allKeys: Array<KeyRow>
  /** Distinct model names from the events table */
  allModels: Array<string>
  stats: UsageStats
  rpm: Array<RpmPoint>
  tokens: Array<TokensPoint>
  latency: Array<LatencyPoint>
  topKeys: Array<TopKey>
  topModels: Array<TopModel>
  errorRates: Array<ErrorRateRow>
  /** Same query string the page was rendered with — used for the CSV link */
  exportQuery: string
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const RANGE_OPTIONS: Array<{ value: TimeRange; label: string }> = [
  { value: "1h", label: "Last 1 hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "custom", label: "Custom" },
]

function fmtIsoLocal(ms: number): string {
  // `<input type=datetime-local>` expects YYYY-MM-DDTHH:mm — use UTC-style
  // formatting so the value is unambiguous when re-submitted.
  return new Date(ms).toISOString().slice(0, 16)
}

const FilterForm: FC<{
  filter: UsageFilterValues
  allKeys: Array<KeyRow>
  allModels: Array<string>
}> = ({ filter, allKeys, allModels }) => (
  <form method="get" action="/admin/usage" class="usage-filter">
    <div class="form-field">
      <label for="range">Range</label>
      <select id="range" name="range">
        {RANGE_OPTIONS.map((opt) => (
          <option
            key={opt.value}
            value={opt.value}
            selected={filter.range === opt.value}
          >
            {opt.label}
          </option>
        ))}
      </select>
    </div>
    <div class="form-field">
      <label for="since">Since (UTC)</label>
      <input
        id="since"
        type="datetime-local"
        name="since"
        value={fmtIsoLocal(filter.since)}
      />
    </div>
    <div class="form-field">
      <label for="until">Until (UTC)</label>
      <input
        id="until"
        type="datetime-local"
        name="until"
        value={fmtIsoLocal(filter.until)}
      />
    </div>
    <div class="form-field">
      <label for="keys">Keys</label>
      <select id="keys" name="key_id" multiple size="4">
        {allKeys.map((k) => (
          <option
            key={k.id}
            value={k.id}
            selected={filter.keyIds.includes(k.id)}
          >
            {k.label ?? k.id.slice(-8)}
          </option>
        ))}
      </select>
    </div>
    <div class="form-field">
      <label for="models">Models</label>
      <select id="models" name="model" multiple size="4">
        {allModels.map((m) => (
          <option key={m} value={m} selected={filter.models.includes(m)}>
            {m}
          </option>
        ))}
      </select>
    </div>
    <div class="form-actions">
      <button type="submit" class="btn btn-primary">
        Apply
      </button>
    </div>
  </form>
)

const StatsRow: FC<{ stats: UsageStats }> = ({ stats }) => (
  <div class="status-grid">
    <div class="status-card">
      <dt>Total Requests</dt>
      <dd>{stats.totalRequests.toLocaleString()}</dd>
    </div>
    <div class="status-card">
      <dt>Total Tokens</dt>
      <dd>{stats.totalTokens.toLocaleString()}</dd>
    </div>
    <div class="status-card">
      <dt>Error Rate</dt>
      <dd>{(stats.errorRate * 100).toFixed(2)}%</dd>
    </div>
  </div>
)

const ChartContainers: FC = () => (
  <div class="usage-charts">
    <section class="usage-chart">
      <h2>Requests per minute</h2>
      <div id="chart-rpm" class="chart-box" />
    </section>
    <section class="usage-chart">
      <h2>Tokens per hour</h2>
      <div id="chart-tph" class="chart-box" />
    </section>
    <section class="usage-chart">
      <h2>p95 latency per hour (ms)</h2>
      <div id="chart-p95" class="chart-box" />
    </section>
  </div>
)

const TopKeysTable: FC<{ rows: Array<TopKey> }> = ({ rows }) => (
  <section class="usage-table-section">
    <h2>Top keys by tokens</h2>
    {rows.length === 0 ?
      <p class="muted">No data.</p>
    : <table class="keys-table">
        <thead>
          <tr>
            <th>Key (last 8)</th>
            <th>Tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key_id}>
              <td class="mono">{r.key_id.slice(-8)}</td>
              <td>{r.tokens.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    }
  </section>
)

const TopModelsTable: FC<{ rows: Array<TopModel> }> = ({ rows }) => (
  <section class="usage-table-section">
    <h2>Top models by requests</h2>
    {rows.length === 0 ?
      <p class="muted">No data.</p>
    : <table class="keys-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Requests</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.model}>
              <td>{r.model}</td>
              <td>{r.count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    }
  </section>
)

const ErrorRateTable: FC<{ rows: Array<ErrorRateRow> }> = ({ rows }) => (
  <section class="usage-table-section">
    <h2>Error rate by key</h2>
    {rows.length === 0 ?
      <p class="muted">No data.</p>
    : <table class="keys-table">
        <thead>
          <tr>
            <th>Key (last 8)</th>
            <th>Total</th>
            <th>Errors</th>
            <th>Rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key_id}>
              <td class="mono">{r.key_id.slice(-8)}</td>
              <td>{r.total.toLocaleString()}</td>
              <td>{r.errors.toLocaleString()}</td>
              <td>{(r.rate * 100).toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    }
  </section>
)

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export const UsagePage: FC<UsagePageProps> = (props) => {
  const {
    filter,
    allKeys,
    allModels,
    stats,
    rpm,
    tokens,
    latency,
    topKeys,
    topModels,
    errorRates,
    exportQuery,
  } = props

  // Serialize chart data into a single <script type="application/json"> tag.
  // This is the CSP-safe alternative to inline JS: usage.js reads the payload
  // via document.getElementById("usage-data").textContent and feeds uPlot.
  //
  // Defence in depth: an attacker-controlled string value (e.g. a model name)
  // must not be able to break out of the <script> data state or trip the HTML
  // parser into a script-data-double-escaped state. Escape every HTML special
  // character to its \uXXXX form before embedding — JSON.parse decodes the
  // escapes transparently, but the HTML tokenizer sees an opaque payload.
  // (Original guard only escaped "</"; this guard also blocks "<!--<script>"
  // double-escape and the U+2028 / U+2029 line-separator JS-parser killers.)
  const payload = JSON.stringify({ rpm, tokens, latency, filter })
    .replaceAll("<", String.raw`\u003c`)
    .replaceAll(">", String.raw`\u003e`)
    .replaceAll("&", String.raw`\u0026`)
    .replaceAll("\u2028", String.raw`\u2028`)
    .replaceAll("\u2029", String.raw`\u2029`)

  return (
    <div class="usage-page">
      <link rel="stylesheet" href="/admin/assets/uplot.min.css" />
      <div class="usage-header">
        <h1>Usage</h1>
        <a
          href={`/admin/usage/export.csv${exportQuery ? `?${exportQuery}` : ""}`}
          class="btn btn-primary"
          download
        >
          Download CSV
        </a>
      </div>
      <FilterForm filter={filter} allKeys={allKeys} allModels={allModels} />
      <StatsRow stats={stats} />
      {stats.totalRequests === 0 ?
        <p class="muted usage-empty">
          No events in the selected window. Generate some traffic and refresh.
        </p>
      : <>
          <ChartContainers />
          <TopKeysTable rows={topKeys} />
          <TopModelsTable rows={topModels} />
          <ErrorRateTable rows={errorRates} />
        </>
      }
      {/* CSP-safe data island. usage.js reads this. */}
      <script
        type="application/json"
        id="usage-data"
        dangerouslySetInnerHTML={{ __html: payload }}
      />
      <script src="/admin/assets/uplot.min.js" />
      <script src="/admin/assets/usage.js" />
    </div>
  )
}
