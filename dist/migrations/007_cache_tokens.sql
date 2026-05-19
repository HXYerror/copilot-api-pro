-- Add cache_read_tokens and cache_creation_tokens to events so the Logs
-- page and Usage dashboard can show Copilot's full token breakdown
-- (input / output / cache_read / cache_write) per request.  Sourced from
-- copilot_usage.token_details in each response.
ALTER TABLE events ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE events ADD COLUMN cache_creation_tokens INTEGER;
