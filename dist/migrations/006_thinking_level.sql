-- Add thinking_level column to events for the Logs page "Thinking" column.
-- Stores a small enum-like string: "auto", "think-hard", "think-harder",
-- "ultrathink", "custom:NNN" (raw budget), or NULL when the client didn't
-- request thinking at all.  Telemetry middleware extracts this from the
-- request body before forwarding, mirroring the same logic the Logs detail
-- drawer applies client-side.
ALTER TABLE events ADD COLUMN thinking_level TEXT;
