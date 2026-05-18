CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
