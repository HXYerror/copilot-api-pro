CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  hash TEXT UNIQUE NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('admin','client')),
  label TEXT,
  allowed_models TEXT NOT NULL DEFAULT '["*"]' CHECK(json_valid(allowed_models)),
  rate_limit_override INTEGER,
  debug_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
-- Note: UNIQUE on hash automatically creates an index; no explicit CREATE INDEX needed.
