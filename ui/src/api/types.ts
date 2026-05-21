/**
 * Shared API response shapes — kept hand-written rather than auto-generated
 * because (a) the server is in this repo so we can refactor both sides
 * together, and (b) the surface is small enough.
 */

export interface MeResponse {
  authenticated: true
  key_id: string
  label: string | null
  tier: "admin"
  csrf_token: string
  auth_mode_label: string
  bind_address: string
}

export interface OverviewKpis {
  total_requests_24h: number
  total_prompt_tokens_24h: number
  total_completion_tokens_24h: number
  errors_24h: number
  error_rate_24h: number
  p95_latency_ms_24h: number | null
  active_keys: number
  debug_keys: number
  total_keys: number
}

export interface OverviewSeriesPoint {
  ts: number
  model: string
  count: number
}

export interface OverviewTopKey {
  key_id: string
  label: string | null
  prompt_tokens: number
  completion_tokens: number
  requests: number
}

export interface OverviewTopModel {
  model: string
  requests: number
}

export interface OverviewRecentCall {
  id: number
  ts: number
  key_id: string
  key_label: string | null
  model: string
  status: number
  latency_ms: number
  prompt_tokens: number | null
  completion_tokens: number | null
}

export interface OverviewSystemStatus {
  auth_mode_label: string
  bind_address: string
  config_version: string
  vscode_version: string | null
  copilot_chat_version: string | null
}

export interface OverviewResponse {
  kpis: OverviewKpis
  series_requests_24h: Array<OverviewSeriesPoint>
  top_models_24h: Array<OverviewTopModel>
  top_keys_24h: Array<OverviewTopKey>
  recent_calls: Array<OverviewRecentCall>
  system: OverviewSystemStatus
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export interface KeySummary {
  id: string
  tier: "admin" | "client"
  label: string | null
  allowed_models: Array<string>
  rate_limit_override: number | null
  debug_enabled: boolean
  debug_active: boolean
  debug_expires_at: number | null
  created_at: number
  revoked_at: number | null
}

export interface KeysListResponse {
  items: Array<KeySummary>
  pagination: {
    page: number
    page_size: number
    total: number
    total_pages: number
  }
  summary: {
    total_keys: number
    active_on_page: number
    debug_active: number
  }
}

export interface KeyUsageWindow {
  total_requests: number
  total_prompt_tokens: number
  total_completion_tokens: number
  errors: number
  error_rate: number
  p95_latency_ms: number | null
  last_used_ts: number | null
}

export interface KeyRecentCall {
  id: number
  ts: number
  model: string
  upstream_model: string
  status: number
  latency_ms: number
  prompt_tokens: number | null
  completion_tokens: number | null
  error: string | null
}

export interface KeyDetailResponse {
  key: KeySummary
  usage: {
    "24h": KeyUsageWindow
    "7d": KeyUsageWindow
    "30d": KeyUsageWindow
  }
  recent_calls: Array<KeyRecentCall>
  available_aliases: Array<string>
  retention_traces_days: number
}

export interface KeyCreateResponse {
  key: KeySummary
  plain: string
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export type UsageRange = "1h" | "24h" | "7d" | "30d" | "custom"

export interface UsageFilterState {
  range: UsageRange
  since: number
  until: number
  key_ids: Array<string>
  models: Array<string>
}

export interface UsageStats {
  total_requests: number
  total_tokens: number
  error_rate: number
  errors: number
  p95_latency_ms: number | null
}

export interface UsageRpmPoint {
  ts: number
  model: string
  count: number
}

export interface UsageTokensPoint {
  ts: number
  prompt_tokens: number
  completion_tokens: number
}

export interface UsageLatencyPoint {
  ts: number
  p50: number
  p95: number
  p99: number
}

export interface UsageTopModel {
  model: string
  count: number
}

export interface UsageTopKey {
  key_id: string
  label: string | null
  tokens: number
  requests: number
}

export interface UsageErrorByStatus {
  status: number
  count: number
  sample_error: string | null
}

export interface UsageResponse {
  filter: UsageFilterState
  stats: UsageStats
  activity: {
    rpm: Array<UsageRpmPoint>
    tokens: Array<UsageTokensPoint>
    latency: Array<UsageLatencyPoint>
    /** Bucket size in ms — server-chosen based on filter span. */
    bucket_ms?: number
    /** Human-readable label, e.g. "per minute" / "per hour" / "per 6 hours". */
    bucket_label?: string
  }
  top_models: Array<UsageTopModel>
  top_keys: Array<UsageTopKey>
  errors_by_status: Array<UsageErrorByStatus>
  all_keys: Array<{ id: string; label: string | null }>
  all_models: Array<string>
}

// ---------------------------------------------------------------------------
// Logs (events table browser)
// ---------------------------------------------------------------------------

export interface LogEntry {
  id: number
  ts: number
  key_id: string
  key_label: string | null
  model: string
  upstream_model: string
  prompt_tokens: number | null
  completion_tokens: number | null
  status: number
  latency_ms: number
  error: string | null
  usage_unknown: number
  /**
   * Anthropic thinking level extracted from the request body. Short enum-
   * like string: "auto" / "think-hard" / "think-harder" / "ultrathink" /
   * "custom:NNN". null when the request didn't include a `thinking` field.
   */
  thinking_level: string | null
  /** Copilot cache_read tokens (prompt-cache hits), from copilot_usage. */
  cache_read_tokens: number | null
  /** Copilot cache_write tokens (prompt-cache creations). */
  cache_creation_tokens: number | null
  /**
   * Reasoning/thinking tokens. ONLY exposed on OpenAI /responses replies
   * via `usage.output_tokens_details.reasoning_tokens`. Anthropic
   * /v1/messages doesn't break this out — those rows stay null.
   */
  reasoning_tokens: number | null
}

export interface LogsListResponse {
  items: Array<LogEntry>
  total: number
  limit: number
  offset: number
  all_models: Array<string>
  /**
   * Counts per request kind for the current filter set, ignoring the
   * `kind` filter itself so the tabs can render badges showing how many
   * events would land in each tab.
   */
  kind_counts: {
    messages: number
    other: number
  }
}

export interface TraceFileEntry {
  name: string
  size: number
  mtime: number
}

export interface TraceFilesResponse {
  items: Array<TraceFileEntry>
  dir: string
}

export interface TraceLeg {
  method?: string
  url?: string
  status?: number
  headers?: Record<string, string>
  body?: unknown
}

export interface FullTraceResponse {
  event: {
    id: number
    ts: number
    key_id: string
    model: string
  }
  trace: {
    trace_id?: string
    ts?: number
    key_id?: string
    route?: string
    req?: TraceLeg
    upstream_req?: TraceLeg
    upstream_res?: TraceLeg
    res?: TraceLeg
    latency_ms?: number
  }
  file: string
}

export interface NoCaptureResponse {
  error: "no_capture"
  reason: string
  event: { id: number; ts: number; key_id: string; model: string }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * The full upstream model record, faithfully reflecting whatever the Copilot
 * API returned. Fields are open-ended on purpose — Copilot adds capabilities
 * over time, and rendering layers should walk the records dynamically rather
 * than hard-code which keys to show.
 */
export interface UpstreamModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_non_streaming_output_tokens?: number
  max_inputs?: number
  vision?: {
    max_prompt_image_size?: number
    max_prompt_images?: number
    supported_media_types?: Array<string>
  }
  // Forward-compat: Copilot regularly adds new limit dimensions.
  [extra: string]: unknown
}

export interface UpstreamModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  streaming?: boolean
  vision?: boolean
  structured_outputs?: boolean
  dimensions?: boolean
  adaptive_thinking?: boolean
  max_thinking_budget?: number
  min_thinking_budget?: number
  reasoning_effort?: Array<string>
  // Forward-compat
  [extra: string]: unknown
}

export interface UpstreamModelCapabilities {
  family: string
  type: string
  tokenizer: string
  limits?: UpstreamModelLimits
  supports?: UpstreamModelSupports
  [extra: string]: unknown
}

export interface UpstreamModel {
  id: string
  name: string
  vendor: string
  version: string
  preview: boolean
  model_picker_enabled: boolean
  /** "powerful" | "versatile" | ... — Copilot's UI categorisation. */
  model_picker_category?: string
  /** Authoritative endpoint list, e.g. ["/responses", "ws:/responses"]. */
  supported_endpoints?: Array<string>
  policy?: {
    state: string
    terms: string
  }
  object?: string
  capabilities: UpstreamModelCapabilities
  [extra: string]: unknown
}

export interface UpstreamCatalogResponse {
  items: Array<UpstreamModel>
  count: number
}

export interface ModelEntry {
  alias: string
  upstream: string
  enabled: boolean
  allowed_keys: Array<string>
  detected_upstream: string | null
  requests_24h: number
  errors_24h: number
  error_rate_24h: number
  last_used: number | null
  capabilities:
    | (UpstreamModelCapabilities & {
        vendor: string
        preview: boolean
        model_picker_enabled: boolean
      })
    | null
}

export interface ModelsListResponse {
  items: Array<ModelEntry>
  summary: {
    total_aliases: number
    aliases_in_use: number
    aliases_with_errors: number
    catalog_size: number
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEvent {
  ts: number
  actor_key_id: string
  actor_tier: "admin" | "client"
  action: string
  target?: string
  before?: unknown
  after?: unknown
}

export interface AuditResponse {
  date: string
  events: Array<AuditEvent>
  total: number
  has_more: boolean
  available_actions: Array<string>
  hourly: Array<Record<string, string | number>>
}

// ---------------------------------------------------------------------------
// Settings (config.json)
// ---------------------------------------------------------------------------

export interface AppConfig {
  version: number
  models: Record<
    string,
    {
      upstream: string
      enabled: boolean
      allowed_keys: Array<string>
      /**
       * Default reasoning effort for this alias. When the client request
       * doesn't carry any thinking/reasoning signal, the proxy injects this
       * value before forwarding upstream. Empty string = no default.
       */
      default_effort?: "" | "low" | "medium" | "high" | "xhigh"
    }
  >
  retention: {
    events_days: number
    traces_days: number
    traces_max_bytes: number
    audit_days: number
  }
  features: {
    auth: boolean
    telemetry: boolean
    debug: boolean
  }
  /**
   * Alias to use when a client requests a model that is not in `models`.
   * Empty string = no default; unconfigured requests return 400.
   * See D-013 / lib/default-model.ts.
   */
  default_model_alias: string
}

export interface SettingsResponse {
  config: AppConfig
}
