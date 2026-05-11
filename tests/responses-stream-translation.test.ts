import { describe, expect, test } from "bun:test"

import {
  makeResponsesStreamState,
  translateResponsesEventToAnthropic,
  type ResponsesStreamState,
} from "../src/routes/messages/responses-stream-translation"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(): ResponsesStreamState {
  return makeResponsesStreamState()
}

function translate(
  eventType: string,
  data: unknown,
  state: ResponsesStreamState,
) {
  return translateResponsesEventToAnthropic(eventType, data, state)
}

// ---------------------------------------------------------------------------
// message_start — response.created
// ---------------------------------------------------------------------------

describe("response.created → message_start", () => {
  test("emits message_start with id and model", () => {
    const state = makeState()
    const events = translate(
      "response.created",
      {
        type: "response.created",
        response: { id: "resp_abc", model: "gpt-5-codex" },
      },
      state,
    )
    const start = events.find((e) => e.type === "message_start")
    expect(start).toBeDefined()
    if (start?.type === "message_start") {
      expect(start.message.id).toBe("resp_abc")
      expect(start.message.model).toBe("gpt-5-codex")
      expect(start.message.role).toBe("assistant")
      expect(start.message.content).toEqual([])
      expect(start.message.stop_reason).toBeNull()
      expect(start.message.usage.input_tokens).toBe(0)
      expect(start.message.usage.output_tokens).toBe(0)
    }
  })

  test("only emits message_start once even if response.created fires twice", () => {
    const state = makeState()
    const data = {
      type: "response.created",
      response: { id: "resp_abc", model: "gpt-5-codex" },
    }
    translate("response.created", data, state)
    const secondEvents = translate("response.created", data, state)
    expect(secondEvents.filter((e) => e.type === "message_start")).toHaveLength(
      0,
    )
  })

  test("response.in_progress also emits message_start if not yet sent", () => {
    const state = makeState()
    const events = translate(
      "response.in_progress",
      {
        type: "response.in_progress",
        response: { id: "resp_xyz", model: "o-pro" },
      },
      state,
    )
    expect(events.some((e) => e.type === "message_start")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// content_block_start — response.output_item.added
// ---------------------------------------------------------------------------

describe("response.output_item.added", () => {
  test("reasoning item → content_block_start with type thinking", () => {
    const state = makeState()
    const events = translate(
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      state,
    )
    const blockStart = events.find((e) => e.type === "content_block_start")
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.index).toBe(0)
      expect(blockStart.content_block.type).toBe("thinking")
      if (blockStart.content_block.type === "thinking") {
        expect(blockStart.content_block.thinking).toBe("")
      }
    }
  })

  test("message item → content_block_start with type text", () => {
    const state = makeState()
    const events = translate(
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1", role: "assistant" },
      },
      state,
    )
    const blockStart = events.find((e) => e.type === "content_block_start")
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block.type).toBe("text")
    }
  })

  test("function_call item → content_block_start with type tool_use", () => {
    const state = makeState()
    const events = translate(
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "get_weather",
        },
      },
      state,
    )
    const blockStart = events.find((e) => e.type === "content_block_start")
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block.type).toBe("tool_use")
      if (blockStart.content_block.type === "tool_use") {
        expect(blockStart.content_block.id).toBe("call_abc")
        expect(blockStart.content_block.name).toBe("get_weather")
        expect(blockStart.content_block.input).toEqual({})
      }
    }
  })

  test("block indexes are allocated sequentially per output_index", () => {
    const state = makeState()
    translate(
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      state,
    )
    const events2 = translate(
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id: "msg_1", role: "assistant" },
      },
      state,
    )
    const blockStart = events2.find((e) => e.type === "content_block_start")
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.index).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// content_block_delta — deltas
// ---------------------------------------------------------------------------

describe("response.reasoning_summary_text.delta → thinking_delta", () => {
  test("emits content_block_delta with thinking_delta", () => {
    const state = makeState()
    // First add the reasoning item
    translate(
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      state,
    )

    const events = translate(
      "response.reasoning_summary_text.delta",
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "I think therefore",
      },
      state,
    )
    const delta = events.find((e) => e.type === "content_block_delta")
    expect(delta).toBeDefined()
    if (delta?.type === "content_block_delta") {
      expect(delta.index).toBe(0)
      expect(delta.delta.type).toBe("thinking_delta")
      if (delta.delta.type === "thinking_delta") {
        expect(delta.delta.thinking).toBe("I think therefore")
      }
    }
  })

  test("unknown output_index → no events", () => {
    const state = makeState()
    const events = translate(
      "response.reasoning_summary_text.delta",
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 99,
        summary_index: 0,
        delta: "orphan delta",
      },
      state,
    )
    expect(events.filter((e) => e.type === "content_block_delta")).toHaveLength(
      0,
    )
  })
})

describe("response.output_text.delta → text_delta", () => {
  test("emits content_block_delta with text_delta", () => {
    const state = makeState()
    translate(
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1", role: "assistant" },
      },
      state,
    )

    const events = translate(
      "response.output_text.delta",
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "Hello world",
      },
      state,
    )
    const delta = events.find((e) => e.type === "content_block_delta")
    expect(delta).toBeDefined()
    if (delta?.type === "content_block_delta") {
      expect(delta.delta.type).toBe("text_delta")
      if (delta.delta.type === "text_delta") {
        expect(delta.delta.text).toBe("Hello world")
      }
    }
  })
})

describe("response.function_call_arguments.delta → input_json_delta", () => {
  test("emits content_block_delta with input_json_delta", () => {
    const state = makeState()
    translate(
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "get_weather",
        },
      },
      state,
    )

    const events = translate(
      "response.function_call_arguments.delta",
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"city":',
      },
      state,
    )
    const delta = events.find((e) => e.type === "content_block_delta")
    expect(delta).toBeDefined()
    if (delta?.type === "content_block_delta") {
      expect(delta.delta.type).toBe("input_json_delta")
      if (delta.delta.type === "input_json_delta") {
        expect(delta.delta.partial_json).toBe('{"city":')
      }
    }
  })
})

// ---------------------------------------------------------------------------
// content_block_stop
// ---------------------------------------------------------------------------

describe("response.output_item.done — reasoning → signature_delta + content_block_stop", () => {
  test("emits signature_delta then content_block_stop when encrypted_content present", () => {
    const state = makeState()
    translate(
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      state,
    )

    const events = translate(
      "response.output_item.done",
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1", encrypted_content: "sig-blob" },
      },
      state,
    )

    const sigDelta = events.find(
      (e) =>
        e.type === "content_block_delta" && e.delta.type === "signature_delta",
    )
    expect(sigDelta).toBeDefined()
    if (
      sigDelta?.type === "content_block_delta"
      && sigDelta.delta.type === "signature_delta"
    ) {
      expect(sigDelta.delta.signature).toBe("sig-blob")
    }

    const stop = events.find((e) => e.type === "content_block_stop")
    expect(stop).toBeDefined()

    // signature_delta must come BEFORE content_block_stop
    const sigDeltaIndex = sigDelta ? events.indexOf(sigDelta) : -1
    const stopIndex = stop ? events.indexOf(stop) : -1
    expect(sigDeltaIndex).toBeGreaterThanOrEqual(0)
    expect(sigDeltaIndex).toBeLessThan(stopIndex)
  })

  test("reasoning without encrypted_content → no signature_delta, but content_block_stop", () => {
    const state = makeState()
    translate(
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      state,
    )

    const events = translate(
      "response.output_item.done",
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      state,
    )

    const sigDelta = events.find(
      (e) =>
        e.type === "content_block_delta" && e.delta.type === "signature_delta",
    )
    expect(sigDelta).toBeUndefined()

    const stop = events.find((e) => e.type === "content_block_stop")
    expect(stop).toBeDefined()
  })
})

describe("response.content_part.done → content_block_stop for text", () => {
  test("emits content_block_stop for message items", () => {
    const state = makeState()
    translate(
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1", role: "assistant" },
      },
      state,
    )

    const events = translate(
      "response.content_part.done",
      {
        type: "response.content_part.done",
        output_index: 0,
        content_index: 0,
      },
      state,
    )

    const stop = events.find((e) => e.type === "content_block_stop")
    expect(stop).toBeDefined()
    if (stop?.type === "content_block_stop") {
      expect(stop.index).toBe(0)
    }
  })

  test("does NOT emit content_block_stop for reasoning items (handled by output_item.done)", () => {
    const state = makeState()
    translate(
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      state,
    )

    const events = translate(
      "response.content_part.done",
      {
        type: "response.content_part.done",
        output_index: 0,
        content_index: 0,
      },
      state,
    )

    const stop = events.find((e) => e.type === "content_block_stop")
    expect(stop).toBeUndefined()
  })
})

describe("response.output_item.done — function_call → content_block_stop", () => {
  test("emits content_block_stop for function_call items", () => {
    const state = makeState()
    translate(
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "do_thing",
        },
      },
      state,
    )

    const events = translate(
      "response.output_item.done",
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "do_thing",
        },
      },
      state,
    )

    const stop = events.find((e) => e.type === "content_block_stop")
    expect(stop).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// response.completed → message_delta + message_stop
// ---------------------------------------------------------------------------

describe("response.completed → message_delta + message_stop", () => {
  test("emits message_delta with stop_reason and usage", () => {
    const state = makeState()
    const events = translate(
      "response.completed",
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      state,
    )

    const messageDelta = events.find((e) => e.type === "message_delta")
    expect(messageDelta).toBeDefined()
    if (messageDelta?.type === "message_delta") {
      expect(messageDelta.delta.stop_reason).toBe("end_turn")
      expect(messageDelta.usage?.input_tokens).toBe(100)
      expect(messageDelta.usage?.output_tokens).toBe(50)
    }

    const messageStop = events.find((e) => e.type === "message_stop")
    expect(messageStop).toBeDefined()
  })

  test("status 'incomplete' → stop_reason 'max_tokens'", () => {
    const state = makeState()
    const events = translate(
      "response.completed",
      {
        type: "response.completed",
        response: {
          status: "incomplete",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      state,
    )
    const messageDelta = events.find((e) => e.type === "message_delta")
    if (messageDelta?.type === "message_delta") {
      expect(messageDelta.delta.stop_reason).toBe("max_tokens")
    }
  })

  test("missing usage → defaults to 0", () => {
    const state = makeState()
    const events = translate(
      "response.completed",
      {
        type: "response.completed",
        response: { status: "completed" },
      },
      state,
    )
    const messageDelta = events.find((e) => e.type === "message_delta")
    if (messageDelta?.type === "message_delta") {
      expect(messageDelta.usage?.input_tokens).toBe(0)
      expect(messageDelta.usage?.output_tokens).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// response.failed → error event
// ---------------------------------------------------------------------------

describe("response.failed → error event", () => {
  test("emits error event with message from upstream", () => {
    const state = makeState()
    const events = translate(
      "response.failed",
      {
        type: "response.failed",
        response: {
          status: "failed",
          error: { message: "Model overloaded" },
        },
      },
      state,
    )
    const errorEvent = events.find((e) => e.type === "error")
    expect(errorEvent).toBeDefined()
    if (errorEvent?.type === "error") {
      expect(errorEvent.error.message).toBe("Model overloaded")
      expect(errorEvent.error.type).toBe("api_error")
    }
  })

  test("missing error.message → default error message", () => {
    const state = makeState()
    const events = translate(
      "response.failed",
      {
        type: "response.failed",
        response: { status: "failed" },
      },
      state,
    )
    const errorEvent = events.find((e) => e.type === "error")
    expect(errorEvent).toBeDefined()
    if (errorEvent?.type === "error") {
      expect(typeof errorEvent.error.message).toBe("string")
      expect(errorEvent.error.message.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Ping scheduling
// ---------------------------------------------------------------------------

describe("ping events", () => {
  test("emits ping every 20 events", () => {
    const state = makeState()
    const failedData = {
      type: "response.failed",
      response: { status: "failed" },
    }

    // Send 19 events - no ping yet
    for (let i = 0; i < 19; i++) {
      translate("response.failed", failedData, state)
    }
    expect(state.eventCount).toBe(19)

    // 20th event → ping
    const events = translate("response.failed", failedData, state)
    expect(state.eventCount).toBe(20)
    expect(events.some((e) => e.type === "ping")).toBe(true)
  })

  test("no ping before 20 events", () => {
    const state = makeState()
    const data = { type: "response.failed", response: { status: "failed" } }
    let hasPing = false
    for (let i = 0; i < 19; i++) {
      const events = translate("response.failed", data, state)
      if (events.some((e) => e.type === "ping")) hasPing = true
    }
    expect(hasPing).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unknown / unsupported events — must not throw
// ---------------------------------------------------------------------------

describe("unknown event types", () => {
  test("unknown event type returns empty array without throwing", () => {
    const state = makeState()
    const events = translate(
      "response.some_unknown_event",
      { foo: "bar" },
      state,
    )
    expect(Array.isArray(events)).toBe(true)
  })

  test("null data does not throw", () => {
    const state = makeState()
    expect(() => translate("response.created", null, state)).not.toThrow()
  })

  test("malformed data does not throw", () => {
    const state = makeState()
    expect(() =>
      translate("response.output_item.added", { output_index: 0 }, state),
    ).not.toThrow()
  })
})
