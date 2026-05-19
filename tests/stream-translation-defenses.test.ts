/**
 * Regression tests for the chat-completion → Anthropic streaming
 * translator's defensive paths. These cover scenarios where Copilot's
 * upstream is permitted to be a little weird (per OpenAI spec, even) and
 * the proxy must not crash or drop telemetry.
 */

import { describe, expect, test } from "bun:test"

import type {
  AnthropicStreamEventData,
  AnthropicStreamState,
} from "../src/routes/messages/anthropic-types"
import type { ChatCompletionChunk } from "../src/services/copilot/create-chat-completions"

import {
  stashAnthropicUsage,
  translateChunkToAnthropicEvents,
} from "../src/routes/messages/stream-translation"

function newState(): AnthropicStreamState {
  return {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }
}

describe("translateChunkToAnthropicEvents — defensive paths", () => {
  test("choices=[] with usage (include_usage tail) → emits message_delta carrying usage", () => {
    const state = newState()
    // First a normal chunk to set messageStartSent
    translateChunkToAnthropicEvents(
      {
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: { content: "hi" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } satisfies ChatCompletionChunk,
      state,
    )
    expect(state.messageStartSent).toBe(true)

    // Now the tail chunk that include_usage produces
    const tailChunk: ChatCompletionChunk = {
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
      choices: [],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 12,
        total_tokens: 62,
      },
    }
    const events = translateChunkToAnthropicEvents(tailChunk, state)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("message_delta")
    const delta = events[0] as {
      type: "message_delta"
      usage: { output_tokens: number; input_tokens: number }
    }
    expect(delta.usage.output_tokens).toBe(12)
    expect(delta.usage.input_tokens).toBe(50)
  })

  test("choices=[] without usage → no events", () => {
    const state = newState()
    state.messageStartSent = true
    const events = translateChunkToAnthropicEvents(
      {
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o",
        choices: [],
      } as ChatCompletionChunk,
      state,
    )
    expect(events).toHaveLength(0)
  })

  test("choice with missing delta does NOT throw", () => {
    const state = newState()
    expect(() =>
      translateChunkToAnthropicEvents(
        {
          id: "c2",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o",
          // Deliberately drop `delta` — observed in the wild on gpt-4o
          // when only finish_reason changes for a chunk.
          choices: [{ index: 0, finish_reason: null, logprobs: null } as never],
        } as ChatCompletionChunk,
        state,
      ),
    ).not.toThrow()
  })
})

describe("stashAnthropicUsage — defensive paths", () => {
  test("message_start without usage field does NOT throw", () => {
    const set: Array<unknown> = []
    const c = {
      set: (_: "usage", v: unknown) => set.push(v),
    }
    const parsed = {
      type: "message_start",
      message: {
        id: "m1",
        // intentionally drop usage to simulate malformed upstream
      },
    } as unknown as AnthropicStreamEventData
    expect(() =>
      stashAnthropicUsage(c, parsed, [undefined, undefined]),
    ).not.toThrow()
  })

  test("message_delta without usage object does NOT throw", () => {
    const c = { set: (_: "usage", __: unknown) => undefined }
    const parsed = {
      type: "message_delta",
      delta: {},
    } as unknown as AnthropicStreamEventData
    expect(() =>
      stashAnthropicUsage(c, parsed, [undefined, undefined]),
    ).not.toThrow()
  })
})
