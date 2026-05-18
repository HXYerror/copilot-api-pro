-- Add debug_expires_at column to keys.
-- When debug_enabled is set to 1, this is set to now + 24 hours.
-- A sweeper process checks this column and auto-disables expired debug mode.
-- NULL means no expiry scheduled (debug_enabled is 0 or no TTL set).
ALTER TABLE keys ADD COLUMN debug_expires_at INTEGER;
