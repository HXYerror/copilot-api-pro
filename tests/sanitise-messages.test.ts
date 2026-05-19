/**
 * Regression tests for the sanitiseMessages pass in buildUpstreamPayload.
 *
 * Background: Copilot routes some `/v1/messages` requests through Google
 * Vertex AI's Claude backend (request_id starts with `req_vrtx_`). Vertex
 * enforces a stricter rule than Anthropic-direct: any text content block
 * whose `text` field is the empty string causes the upstream to return 400
 * "messages: text content blocks must be non-empty". We scrub empty blocks
 * before forwarding so the request succeeds regardless of which backend
 * Copilot picks.
 */

import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { buildUpstreamPayload } from "~/services/copilot/create-messages-native"

function payloadWith(
  messages: AnthropicMessagesPayload["messages"],
): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-4-5",
    messages,
    max_tokens: 1024,
  }
}

describe("buildUpstreamPayload — sanitiseMessages (Vertex compatibility)", () => {
  test("drops empty text block when message has other non-empty blocks", () => {
    const result = buildUpstreamPayload(
      payloadWith([
        {
          role: "user",
          content: [
            { type: "text", text: "" },
            { type: "text", text: "Hello" },
          ],
        },
      ]),
    )
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "Hello" },
    ])
  })

  test("coerces empty content array to a placeholder text block", () => {
    const result = buildUpstreamPayload(
      payloadWith([
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
        },
      ]),
    )
    // Must not return empty content (Anthropic spec) — placeholder text.
    const content = result.messages[0].content
    expect(Array.isArray(content)).toBe(true)
    expect(Array.isArray(content) ? content.length : 0).toBeGreaterThan(0)
    if (Array.isArray(content)) {
      const first = content[0]
      expect(first.type).toBe("text")
      if (first.type === "text") {
        expect(first.text.length).toBeGreaterThan(0)
      }
    }
  })

  test("preserves tool_use blocks untouched alongside scrubbed empty text", () => {
    const result = buildUpstreamPayload(
      payloadWith([
        {
          role: "assistant",
          content: [
            { type: "text", text: "" },
            {
              type: "tool_use",
              id: "tu_1",
              name: "read",
              input: { path: "/x" },
            },
          ],
        },
      ]),
    )
    const content = result.messages[0].content
    expect(Array.isArray(content) ? content.length : 0).toBe(1)
    if (Array.isArray(content)) {
      expect(content[0]).toEqual({
        type: "tool_use",
        id: "tu_1",
        name: "read",
        input: { path: "/x" },
      })
    }
  })

  test("coerces empty tool_result string content to placeholder, NOT drops the block", () => {
    const result = buildUpstreamPayload(
      payloadWith([
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "" },
          ],
        },
      ]),
    )
    // tool_result must stay (drops would orphan the tool_use it pairs with).
    const content = result.messages[0].content
    expect(Array.isArray(content) ? content.length : 0).toBe(1)
    if (Array.isArray(content)) {
      expect(content[0].type).toBe("tool_result")
      if (content[0].type === "tool_result") {
        // Coerced to a non-empty placeholder string.
        expect(typeof content[0].content).toBe("string")
        if (typeof content[0].content === "string") {
          expect(content[0].content.length).toBeGreaterThan(0)
        }
      }
    }
  })

  test("scrubs empty text inside tool_result array content", () => {
    const result = buildUpstreamPayload(
      payloadWith([
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_2",
              content: [
                { type: "text", text: "" },
                { type: "text", text: "ok" },
              ],
            },
          ],
        },
      ]),
    )
    const content = result.messages[0].content
    if (Array.isArray(content) && content[0].type === "tool_result") {
      const inner = content[0].content
      expect(Array.isArray(inner) ? inner.length : 0).toBe(1)
      if (Array.isArray(inner) && inner[0].type === "text") {
        expect(inner[0].text).toBe("ok")
      }
    }
  })

  test("coerces fully-empty tool_result array content to placeholder string", () => {
    const result = buildUpstreamPayload(
      payloadWith([
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_3",
              content: [{ type: "text", text: "" }],
            },
          ],
        },
      ]),
    )
    const content = result.messages[0].content
    if (Array.isArray(content) && content[0].type === "tool_result") {
      // Coerced to non-empty string placeholder rather than dropped.
      expect(typeof content[0].content).toBe("string")
      if (typeof content[0].content === "string") {
        expect(content[0].content.length).toBeGreaterThan(0)
      }
    }
  })

  test("coerces all-whitespace string content to non-empty placeholder", () => {
    const result = buildUpstreamPayload(
      payloadWith([{ role: "user", content: "   " }]),
    )
    expect(typeof result.messages[0].content).toBe("string")
    if (typeof result.messages[0].content === "string") {
      // Vertex's check is on .length === 0, so a single space passes;
      // we don't need to insert real content (and shouldn't — that would
      // change the meaning of the request).
      expect(result.messages[0].content.length).toBeGreaterThan(0)
    }
  })

  test("non-empty messages pass through unchanged (structurally equivalent)", () => {
    const input = payloadWith([
      { role: "user", content: "real prompt" },
      { role: "assistant", content: [{ type: "text", text: "real reply" }] },
    ])
    const result = buildUpstreamPayload(input)
    expect(result.messages).toEqual(input.messages)
  })
})
