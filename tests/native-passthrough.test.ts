import { describe, test, expect, beforeEach, afterEach } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { state } from "~/lib/state"
import { buildUpstreamPayload } from "~/services/copilot/create-messages-native"
import { isNativeAnthropicModel } from "~/services/copilot/native-models"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid payload base — only the fields required by the type. */
function basePayload(
  overrides: Partial<AnthropicMessagesPayload>,
): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1024,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// buildUpstreamPayload tests
// ---------------------------------------------------------------------------

describe("buildUpstreamPayload", () => {
  // T1 — output_config present but thinking absent → output_config stripped
  test("T1: strips output_config when thinking is absent", () => {
    const payload = basePayload({
      output_config: { effort: "high" },
    })
    const result = buildUpstreamPayload(payload)
    expect(result).not.toHaveProperty("output_config")
    expect(result).not.toHaveProperty("thinking")
  })

  // T2 — adaptive upgrade preserves explicit output_config: { effort: "high" }
  test("T2: adaptive upgrade preserves explicit output_config effort", () => {
    const payload = basePayload({
      model: "claude-opus-4.7",
      thinking: { type: "enabled" },
      output_config: { effort: "high" },
    } as Partial<AnthropicMessagesPayload>)
    const result = buildUpstreamPayload(payload)
    expect(result.thinking).toEqual({ type: "adaptive" })
    // Should keep caller's "high", not override to "medium"
    expect(result.output_config).toEqual({ effort: "high" })
  })

  // T3 — already adaptive → forwarded as-is
  test("T3: already-adaptive thinking forwarded as-is", () => {
    const payload = basePayload({
      model: "claude-opus-4.7",
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    } as Partial<AnthropicMessagesPayload>)
    const result = buildUpstreamPayload(payload)
    expect(result.thinking).toEqual({ type: "adaptive" })
    expect(result.output_config).toEqual({ effort: "low" })
  })

  // T4 — legacy model with enabled thinking → kept as-is, no adaptive upgrade
  test("T4: legacy model with enabled thinking kept as-is", () => {
    const payload = basePayload({
      model: "claude-sonnet-4-5",
      thinking: { type: "enabled", budget_tokens: 1024 },
    } as Partial<AnthropicMessagesPayload>)
    const result = buildUpstreamPayload(payload)
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
    expect(result).not.toHaveProperty("output_config")
  })

  // T5 — adaptive upgrade with no output_config → effort is derived from
  //       budget_tokens. budget=1024 falls into the "low" bucket (<5K).
  test("T5: small budget upgrades to effort=low", () => {
    const payload = basePayload({
      model: "claude-opus-4.7",
      thinking: { type: "enabled", budget_tokens: 1024 },
      // output_config intentionally absent
    } as Partial<AnthropicMessagesPayload>)
    const result = buildUpstreamPayload(payload)
    expect(result.thinking).toEqual({ type: "adaptive" })
    expect(result.output_config).toEqual({ effort: "low" })
  })

  // T6 — empty output_config + missing budget → falls back to "medium".
  test("T6: empty output_config + no budget → medium default", () => {
    const payload = basePayload({
      model: "claude-opus-4.7",
      thinking: { type: "enabled" },
      output_config: {},
    } as Partial<AnthropicMessagesPayload>)
    const result = buildUpstreamPayload(payload)
    expect(result.thinking).toEqual({ type: "adaptive" })
    expect(result.output_config).toEqual({ effort: "medium" })
  })

  // T7 — budget 10K → medium (5K-25K bucket)
  test("T7: budget 10000 → effort=medium", () => {
    const result = buildUpstreamPayload(
      basePayload({
        model: "claude-opus-4.7",
        thinking: { type: "enabled", budget_tokens: 10_000 },
      } as Partial<AnthropicMessagesPayload>),
    )
    expect(result.output_config).toEqual({ effort: "medium" })
  })

  // T8 — budget 32K → high
  test("T8: budget 32000 → effort=high", () => {
    const result = buildUpstreamPayload(
      basePayload({
        model: "claude-opus-4.7",
        thinking: { type: "enabled", budget_tokens: 32_000 },
      } as Partial<AnthropicMessagesPayload>),
    )
    expect(result.output_config).toEqual({ effort: "high" })
  })

  // T9 — budget 64K → xhigh (Ultrathink-equivalent)
  test("T9: budget 64000 → effort=xhigh", () => {
    const result = buildUpstreamPayload(
      basePayload({
        model: "claude-opus-4.7",
        thinking: { type: "enabled", budget_tokens: 64_000 },
      } as Partial<AnthropicMessagesPayload>),
    )
    expect(result.output_config).toEqual({ effort: "xhigh" })
  })
})

// ---------------------------------------------------------------------------
// isNativeAnthropicModel tests
// ---------------------------------------------------------------------------

// Per-test state isolation
let savedModels: typeof state.models

beforeEach(() => {
  savedModels = state.models
})

afterEach(() => {
  state.models = savedModels
})

describe("isNativeAnthropicModel", () => {
  // T5 — model in loaded list with vendor "Anthropic" → true
  test("T5: model with vendor Anthropic in loaded list → true", () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "claude-sonnet-4-5",
          vendor: "Anthropic",
          name: "Claude Sonnet 4.5",
          object: "model",
          version: "1",
          preview: false,
          model_picker_enabled: true,
          capabilities: {
            family: "claude",
            limits: {},
            object: "model_capabilities",
            supports: {},
            tokenizer: "cl100k_base",
            type: "chat",
          },
        },
      ],
    }
    expect(isNativeAnthropicModel("claude-sonnet-4-5")).toBe(true)
  })

  // T6 — model in loaded list with vendor "OpenAI" → false
  test("T6: model with vendor OpenAI in loaded list → false", () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-4o",
          vendor: "OpenAI",
          name: "GPT-4o",
          object: "model",
          version: "1",
          preview: false,
          model_picker_enabled: true,
          capabilities: {
            family: "gpt",
            limits: {},
            object: "model_capabilities",
            supports: {},
            tokenizer: "cl100k_base",
            type: "chat",
          },
        },
      ],
    }
    expect(isNativeAnthropicModel("gpt-4o")).toBe(false)
  })

  // T7 — model NOT in loaded list, starts with "claude-" → true (heuristic)
  test("T7: model not in loaded list but starts with claude- → true", () => {
    state.models = { object: "list", data: [] }
    expect(isNativeAnthropicModel("claude-future-1")).toBe(true)
  })

  // T8 — model NOT in loaded list, starts with "gpt-" → false
  test("T8: model not in loaded list and starts with gpt- → false", () => {
    state.models = { object: "list", data: [] }
    expect(isNativeAnthropicModel("gpt-5")).toBe(false)
  })

  // T9 — state.models undefined → heuristic
  test("T9: state.models undefined → heuristic (claude- prefix → true)", () => {
    state.models = undefined
    expect(isNativeAnthropicModel("claude-something")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isAdaptiveThinkingModel boundary tests (via buildUpstreamPayload)
// ---------------------------------------------------------------------------

describe("isAdaptiveThinkingModel boundaries (via buildUpstreamPayload)", () => {
  // B1 — claude-opus-4.6 is NOT upgraded (one below threshold)
  test("B1: claude-opus-4.6 does NOT get adaptive upgrade", () => {
    const payload = basePayload({
      model: "claude-opus-4.6",
      thinking: { type: "enabled", budget_tokens: 2048 },
    } as Partial<AnthropicMessagesPayload>)
    const result = buildUpstreamPayload(payload)
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 2048 })
    expect(result).not.toHaveProperty("output_config")
  })

  // B2 — claude-opus-4.7 IS upgraded (exact threshold)
  test("B2: claude-opus-4.7 (dot separator) IS upgraded to adaptive", () => {
    const payload = basePayload({
      model: "claude-opus-4.7",
      thinking: { type: "enabled" },
    } as Partial<AnthropicMessagesPayload>)
    const result = buildUpstreamPayload(payload)
    expect(result.thinking).toEqual({ type: "adaptive" })
  })

  // B3 — claude-opus-4-7 (dash separator) IS upgraded
  test("B3: claude-opus-4-7 (dash separator) IS upgraded to adaptive", () => {
    const payload = basePayload({
      model: "claude-opus-4-7",
      thinking: { type: "enabled" },
    } as Partial<AnthropicMessagesPayload>)
    const result = buildUpstreamPayload(payload)
    expect(result.thinking).toEqual({ type: "adaptive" })
  })

  // B4 — claude-opus-4-6 (dash separator) is NOT upgraded
  test("B4: claude-opus-4-6 (dash separator) NOT upgraded", () => {
    const payload = basePayload({
      model: "claude-opus-4-6",
      thinking: { type: "enabled", budget_tokens: 512 },
    } as Partial<AnthropicMessagesPayload>)
    const result = buildUpstreamPayload(payload)
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 512 })
    expect(result).not.toHaveProperty("output_config")
  })

  // B5 — claude-opus-4.8 (one above threshold) IS upgraded
  test("B5: claude-opus-4.8 (one above threshold) IS upgraded", () => {
    const payload = basePayload({
      model: "claude-opus-4.8",
      thinking: { type: "enabled" },
    } as Partial<AnthropicMessagesPayload>)
    const result = buildUpstreamPayload(payload)
    expect(result.thinking).toEqual({ type: "adaptive" })
  })

  // B6 — claude-sonnet-4.7 (non-opus) is NOT upgraded
  test("B6: claude-sonnet-4.7 (non-opus) NOT upgraded to adaptive", () => {
    const payload = basePayload({
      model: "claude-sonnet-4.7",
      thinking: { type: "enabled", budget_tokens: 1024 },
    } as Partial<AnthropicMessagesPayload>)
    const result = buildUpstreamPayload(payload)
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
    expect(result).not.toHaveProperty("output_config")
  })
})
