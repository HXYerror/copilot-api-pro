-- Add reasoning_tokens column. Sourced from
-- usage.output_tokens_details.reasoning_tokens on /responses-style
-- replies. Anthropic /v1/messages doesn't expose this — those rows stay
-- NULL, which is the honest signal that we don't know.
ALTER TABLE events ADD COLUMN reasoning_tokens INTEGER;
