-- Telemetry events table (issue #34, F3.A).
-- One row per proxied API request — best-effort insert from the telemetry
-- middleware. Indexed for the common admin/UI access patterns: time range,
-- per-key time range, per-model time range.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key_id TEXT NOT NULL,             -- '__noauth__' sentinel for --no-auth
  model TEXT NOT NULL,              -- user-facing alias name
  upstream_model TEXT NOT NULL,     -- post-alias-resolution name
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  status INTEGER NOT NULL,          -- HTTP status code
  latency_ms INTEGER NOT NULL,
  error TEXT,                       -- short error tag, NOT body
  usage_unknown INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_key_ts ON events(key_id, ts);
CREATE INDEX idx_events_model_ts ON events(model, ts);
