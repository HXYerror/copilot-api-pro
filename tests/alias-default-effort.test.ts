/**
 * Tests for the per-alias `default_effort` injection in
 * `buildUpstreamPayload`. Verifies:
 *   - injected when client sent no thinking
 *   - never overrides what the client sent
 *   - clamped to the model's supported reasoning_effort list
 *   - empty / undefined default = no-op
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import { state } from "../src/lib/state"
import { buildUpstreamPayload } from "../src/services/copilot/create-messages-native"

const basePayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload =>
  ({
    model: "claude-opus-4.7-1m-internal",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 100,
    ...overrides,
  }) as AnthropicMessagesPayload

beforeEach(() => {
  // Stub state.models so clampEffortForModel can look up the supported list.
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-opus-4.7-1m-internal",
        name: "Opus 4.7",
        vendor: "Anthropic",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        object: "model",
        capabilities: {
          family: "claude",
          object: "model_capabilities",
          tokenizer: "claude",
          type: "chat",
          limits: { max_output_tokens: 30_000 },
          supports: { reasoning_effort: ["low", "medium", "high", "xhigh"] },
        },
      },
      {
        id: "claude-opus-4.7-high",
        name: "Opus 4.7 (high only)",
        vendor: "Anthropic",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        object: "model",
        capabilities: {
          family: "claude",
          object: "model_capabilities",
          tokenizer: "claude",
          type: "chat",
          limits: { max_output_tokens: 30_000 },
          supports: { reasoning_effort: ["high"] },
        },
      },
    ],
  }
})

afterEach(() => {
  state.models = undefined
})

describe("buildUpstreamPayload — alias default_effort injection", () => {
  test("client sent nothing + alias default=high → inject adaptive + high", () => {
    const result = buildUpstreamPayload(basePayload(), "high")
    expect(result.thinking).toEqual({ type: "adaptive" })
    expect(result.output_config).toEqual({ effort: "high" })
  })

  test("client sent thinking → default_effort is ignored", () => {
    const result = buildUpstreamPayload(
      basePayload({
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
      } as Partial<AnthropicMessagesPayload>),
      "high",
    )
    expect(result.thinking).toEqual({ type: "adaptive" })
    expect(result.output_config).toEqual({ effort: "low" })
  })

  test("empty string default = no injection", () => {
    const result = buildUpstreamPayload(basePayload(), "")
    expect(result.thinking).toBeUndefined()
    expect(result.output_config).toBeUndefined()
  })

  test("undefined default = no injection", () => {
    const result = buildUpstreamPayload(basePayload(), undefined)
    expect(result.thinking).toBeUndefined()
    expect(result.output_config).toBeUndefined()
  })

  test("injected effort is clamped to supported list (xhigh → high on -high variant)", () => {
    const result = buildUpstreamPayload(
      basePayload({ model: "claude-opus-4.7-high" }),
      "xhigh",
    )
    expect(result.thinking).toEqual({ type: "adaptive" })
    // -high variant only supports "high", so xhigh gets clamped down
    expect(result.output_config).toEqual({ effort: "high" })
  })

  test("default low on -high variant clamps up to high", () => {
    const result = buildUpstreamPayload(
      basePayload({ model: "claude-opus-4.7-high" }),
      "low",
    )
    expect(result.output_config).toEqual({ effort: "high" })
  })

  test("legacy enabled+budget client → default_effort still does not override", () => {
    // Client explicitly set legacy {type:enabled, budget_tokens}; we honour
    // that even if the alias has a default.
    const result = buildUpstreamPayload(
      basePayload({
        thinking: { type: "enabled", budget_tokens: 1024 },
      } as Partial<AnthropicMessagesPayload>),
      "xhigh",
    )
    expect(result.thinking).toEqual({ type: "adaptive" })
    // budget 1024 maps to "low" via budgetToEffort, NOT xhigh from alias default
    expect(result.output_config).toEqual({ effort: "low" })
  })
})
