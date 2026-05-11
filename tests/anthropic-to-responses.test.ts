import { describe, test, expect } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type {
  ResponsesFunctionCallOutput,
  ResponsesInputFunctionCall,
  ResponsesInputMessage,
  ResponsesReasoningItem,
} from "~/routes/responses/types"

import { translateAnthropicToResponses } from "../src/routes/messages/anthropic-to-responses"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBasePayload(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "gpt-5-codex",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 1024,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Basic message translation
// ---------------------------------------------------------------------------

describe("translateAnthropicToResponses — basic messages", () => {
  test("simple user string message → input_text message item", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        messages: [{ role: "user", content: "Hello world" }],
      }),
    )
    expect(Array.isArray(result.input)).toBe(true)
    const items = result.input as Array<unknown>
    expect(items).toHaveLength(1)
    const item = items[0] as ResponsesInputMessage
    expect(item.type).toBe("message")
    expect(item.role).toBe("user")
    expect(item.content).toBe("Hello world")
  })

  test("user message with text block array → input_text content part", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hi there" }],
          },
        ],
      }),
    )
    const items = result.input as Array<unknown>
    expect(items).toHaveLength(1)
    const item = items[0] as ResponsesInputMessage
    expect(item.type).toBe("message")
    expect(item.role).toBe("user")
    expect(Array.isArray(item.content)).toBe(true)
    const parts = item.content as Array<{ type: string; text?: string }>
    expect(parts[0].type).toBe("input_text")
    expect(parts[0].text).toBe("Hi there")
  })

  test("user message with image block → input_image content part", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "abc123",
                },
              },
            ],
          },
        ],
      }),
    )
    const items = result.input as Array<unknown>
    const msg = items[0] as ResponsesInputMessage
    const parts = msg.content as Array<{ type: string; image_url?: string }>
    expect(parts[0].type).toBe("input_image")
    expect(parts[0].image_url).toBe("data:image/png;base64,abc123")
  })

  test("user message with tool_result → function_call_output item", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_abc",
                content: "sunny, 72°F",
              },
            ],
          },
        ],
      }),
    )
    const items = result.input as Array<unknown>
    expect(items).toHaveLength(1)
    const item = items[0] as ResponsesFunctionCallOutput
    expect(item.type).toBe("function_call_output")
    expect(item.call_id).toBe("call_abc")
    expect(item.output).toBe("sunny, 72°F")
  })

  test("tool_result with array content → text parts joined with newline", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_multi",
                content: [
                  { type: "text", text: "Part A" },
                  { type: "text", text: "Part B" },
                ],
              },
            ],
          },
        ],
      }),
    )
    const items = result.input as Array<unknown>
    const item = items[0] as ResponsesFunctionCallOutput
    expect(item.type).toBe("function_call_output")
    expect(item.call_id).toBe("call_multi")
    expect(item.output).toBe("Part A\nPart B")
  })

  test("empty messages array → input: []", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({ messages: [] }),
    )
    expect(Array.isArray(result.input)).toBe(true)
    expect(result.input as Array<unknown>).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Assistant message translation
// ---------------------------------------------------------------------------

describe("translateAnthropicToResponses — assistant messages", () => {
  test("assistant string message → message item with output_text", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello back" },
        ],
      }),
    )
    const items = result.input as Array<unknown>
    const assistantItem = items[1] as ResponsesInputMessage
    expect(assistantItem.type).toBe("message")
    expect(assistantItem.role).toBe("assistant")
    const parts = assistantItem.content as Array<{
      type: string
      text?: string
    }>
    expect(parts[0].type).toBe("output_text")
    expect(parts[0].text).toBe("Hello back")
  })

  test("assistant message with tool_use block → function_call item", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        messages: [
          { role: "user", content: "What's the weather?" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_xyz",
                name: "get_weather",
                input: { city: "London" },
              },
            ],
          },
        ],
      }),
    )
    const items = result.input as Array<unknown>
    const fcItem = items[1] as ResponsesInputFunctionCall
    expect(fcItem.type).toBe("function_call")
    expect(fcItem.call_id).toBe("call_xyz")
    expect(fcItem.name).toBe("get_weather")
    expect(JSON.parse(fcItem.arguments)).toEqual({ city: "London" })
  })

  test("assistant message with thinking block → reasoning item with encrypted_content from signature", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        messages: [
          { role: "user", content: "Think" },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "I am reasoning...",
                signature: "sig-opaque-blob",
              },
            ],
          },
        ],
      }),
    )
    const items = result.input as Array<unknown>
    const rsItem = items[1] as ResponsesReasoningItem
    expect(rsItem.type).toBe("reasoning")
    expect(rsItem.encrypted_content).toBe("sig-opaque-blob")
    expect(rsItem.summary?.[0].text).toBe("I am reasoning...")
  })

  test("assistant thinking block without signature → no encrypted_content field", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        messages: [
          { role: "user", content: "Think" },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "Thinking without sig",
              },
            ],
          },
        ],
      }),
    )
    const items = result.input as Array<unknown>
    const rsItem = items[1] as ResponsesReasoningItem
    expect(rsItem.type).toBe("reasoning")
    expect("encrypted_content" in rsItem).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// System prompt → instructions
// ---------------------------------------------------------------------------

describe("translateAnthropicToResponses — system prompt", () => {
  test("string system → instructions string", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({ system: "You are a helpful assistant." }),
    )
    expect(result.instructions).toBe("You are a helpful assistant.")
  })

  test("array system blocks → joined instructions string", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        system: [
          { type: "text", text: "Block 1" },
          { type: "text", text: "Block 2" },
        ],
      }),
    )
    expect(result.instructions).toBe("Block 1\n\nBlock 2")
  })

  test("no system → instructions is undefined", () => {
    const result = translateAnthropicToResponses(makeBasePayload())
    expect(result.instructions).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Thinking → reasoning.effort mapping
// ---------------------------------------------------------------------------

describe("translateAnthropicToResponses — thinking budget_tokens tiers", () => {
  test("budget_tokens >= 10000 → effort: high", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        thinking: { type: "enabled", budget_tokens: 10_000 },
      }),
    )
    expect(result.reasoning?.effort).toBe("high")
  })

  test("budget_tokens >= 5000 (< 10000) → effort: medium", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        thinking: { type: "enabled", budget_tokens: 7_500 },
      }),
    )
    expect(result.reasoning?.effort).toBe("medium")
  })

  test("budget_tokens >= 2000 (< 5000) → effort: low", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        thinking: { type: "enabled", budget_tokens: 3_000 },
      }),
    )
    expect(result.reasoning?.effort).toBe("low")
  })

  test("budget_tokens < 2000 → effort: low (no minimal tier)", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        thinking: { type: "enabled", budget_tokens: 500 },
      }),
    )
    expect(result.reasoning?.effort).toBe("low")
  })

  test("budget_tokens exactly 5000 → effort: medium", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        thinking: { type: "enabled", budget_tokens: 5_000 },
      }),
    )
    expect(result.reasoning?.effort).toBe("medium")
  })

  test("budget_tokens exactly 9999 → effort: medium (not high)", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        thinking: { type: "enabled", budget_tokens: 9_999 },
      }),
    )
    expect(result.reasoning?.effort).toBe("medium")
  })

  test("thinking { type: 'enabled' } without budget_tokens → effort: medium", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        thinking: { type: "enabled" },
      }),
    )
    expect(result.reasoning).toEqual({ effort: "medium" })
  })

  test("thinking { type: 'adaptive' } → reasoning { effort: 'medium' }", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        thinking: { type: "adaptive" },
      }),
    )
    expect(result.reasoning).toEqual({ effort: "medium" })
  })

  test("thinking { type: 'adaptive' } + output_config.effort: 'high' → effort: high", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
      }),
    )
    expect(result.reasoning).toEqual({ effort: "high" })
  })

  test("thinking { type: 'adaptive' } + output_config.effort: 'low' → effort: low", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
      }),
    )
    expect(result.reasoning).toEqual({ effort: "low" })
  })

  test("no thinking → reasoning is undefined", () => {
    const result = translateAnthropicToResponses(makeBasePayload())
    expect(result.reasoning).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tool translation
// ---------------------------------------------------------------------------

describe("translateAnthropicToResponses — tools", () => {
  test("tools[] → ResponsesPayload tools[]", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({
        tools: [
          {
            name: "get_weather",
            description: "Gets the weather",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        ],
      }),
    )
    expect(result.tools).toHaveLength(1)
    expect(result.tools?.[0].type).toBe("function")
    expect(result.tools?.[0].name).toBe("get_weather")
    expect(result.tools?.[0].description).toBe("Gets the weather")
    expect(result.tools?.[0].parameters).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
    })
  })

  test("no tools → tools is undefined", () => {
    const result = translateAnthropicToResponses(makeBasePayload())
    expect(result.tools).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tool choice translation
// ---------------------------------------------------------------------------

describe("translateAnthropicToResponses — tool_choice", () => {
  test("auto → 'auto'", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({ tool_choice: { type: "auto" } }),
    )
    expect(result.tool_choice).toBe("auto")
  })

  test("any → 'required'", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({ tool_choice: { type: "any" } }),
    )
    expect(result.tool_choice).toBe("required")
  })

  test("tool with name → { type: 'function', name }", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({ tool_choice: { type: "tool", name: "get_weather" } }),
    )
    expect(result.tool_choice).toEqual({
      type: "function",
      name: "get_weather",
    })
  })

  test("tool without name → falls back to 'auto'", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({ tool_choice: { type: "tool" } }),
    )
    expect(result.tool_choice).toBe("auto")
  })

  test("none → 'none'", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({ tool_choice: { type: "none" } }),
    )
    expect(result.tool_choice).toBe("none")
  })

  test("no tool_choice → undefined", () => {
    const result = translateAnthropicToResponses(makeBasePayload())
    expect(result.tool_choice).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Top-level field mapping
// ---------------------------------------------------------------------------

describe("translateAnthropicToResponses — top-level fields", () => {
  test("model passes through unchanged", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({ model: "gpt-5-codex" }),
    )
    expect(result.model).toBe("gpt-5-codex")
  })

  test("max_tokens → max_output_tokens", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({ max_tokens: 2048 }),
    )
    expect(result.max_output_tokens).toBe(2048)
  })

  test("metadata.user_id → user", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({ metadata: { user_id: "user-999" } }),
    )
    expect(result.user).toBe("user-999")
  })

  test("stream passes through", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({ stream: true }),
    )
    expect(result.stream).toBe(true)
  })

  test("temperature and top_p pass through", () => {
    const result = translateAnthropicToResponses(
      makeBasePayload({ temperature: 0.7, top_p: 0.9 }),
    )
    expect(result.temperature).toBe(0.7)
    expect(result.top_p).toBe(0.9)
  })
})
