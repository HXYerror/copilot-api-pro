/**
 * Regression for the `max_tokens must be greater than thinking.budget_tokens`
 * 400 we hit on claude-opus-4-6 (events #104/#105/#106 in the runtime DB).
 *
 * Anthropic enforces max_tokens > thinking.budget_tokens. When clients
 * pair a 4096 default max_tokens with a 10000+ budget, we now bump
 * max_tokens to budget + 1024 instead of forwarding the broken pair.
 */

import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { buildUpstreamPayload } from "~/services/copilot/create-messages-native"

function payload(
  overrides: Partial<AnthropicMessagesPayload>,
): AnthropicMessagesPayload {
  return {
    model: "claude-opus-4.6",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 4096,
    ...overrides,
  }
}

describe("buildUpstreamPayload — max_tokens vs thinking.budget_tokens", () => {
  test("event #104 replay: max=4096 budget=10000 → max bumped to budget+1024", () => {
    const result = buildUpstreamPayload(
      payload({
        thinking: { type: "enabled", budget_tokens: 10000 },
      }),
    )
    expect(result.max_tokens).toBe(10000 + 1024)
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 10000 })
  })

  test("event #105 replay: max=4096 budget=31999", () => {
    const result = buildUpstreamPayload(
      payload({
        thinking: { type: "enabled", budget_tokens: 31999 },
      }),
    )
    expect(result.max_tokens).toBe(31999 + 1024)
  })

  test("event #106 replay: max=4096 budget=63999", () => {
    const result = buildUpstreamPayload(
      payload({
        thinking: { type: "enabled", budget_tokens: 63999 },
      }),
    )
    expect(result.max_tokens).toBe(63999 + 1024)
  })

  test("equal max_tokens and budget_tokens also triggers bump (Anthropic requires STRICT >)", () => {
    const result = buildUpstreamPayload(
      payload({
        max_tokens: 5000,
        thinking: { type: "enabled", budget_tokens: 5000 },
      }),
    )
    expect(result.max_tokens).toBe(5000 + 1024)
  })

  test("does NOT shrink max_tokens when caller already provides headroom", () => {
    const result = buildUpstreamPayload(
      payload({
        max_tokens: 64000,
        thinking: { type: "enabled", budget_tokens: 10000 },
      }),
    )
    expect(result.max_tokens).toBe(64000)
  })

  test("ignores adaptive thinking (no budget_tokens in payload)", () => {
    const result = buildUpstreamPayload(
      payload({
        model: "claude-opus-4.7",
        max_tokens: 4096,
        thinking: { type: "adaptive" },
      }),
    )
    // Caller's max_tokens passes through unchanged when there's no budget
    // to conflict with.
    expect(result.max_tokens).toBe(4096)
  })

  test("ignores non-thinking requests", () => {
    const result = buildUpstreamPayload(
      payload({
        max_tokens: 4096,
        // no thinking field
      }),
    )
    expect(result.max_tokens).toBe(4096)
  })

  test("adaptive model with legacy enabled+budget: thinking upgraded, budget gone, no clash", () => {
    // claude-opus-4.7 gets the thinking rewritten to adaptive, so
    // budget_tokens never makes it to upstream — and we should NOT bump
    // max_tokens because the upstream invariant doesn't apply post-rewrite.
    const result = buildUpstreamPayload(
      payload({
        model: "claude-opus-4.7",
        max_tokens: 4096,
        thinking: { type: "enabled", budget_tokens: 31999 },
      }),
    )
    expect(result.max_tokens).toBe(4096)
    expect(result.thinking).toEqual({ type: "adaptive" })
  })
})
