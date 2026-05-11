/**
 * Integration and regression tests for the Responses API → Anthropic SSE
 * streaming translation.  Split from responses-stream-translation.test.ts
 * to stay within the max-lines-per-file lint limit.
 */

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

function translateSequence(
  events: Array<[string, unknown]>,
  state = makeState(),
) {
  return events.flatMap(([type, data]) => translate(type, data, state))
}

// ---------------------------------------------------------------------------
// Full streaming sequence integration
// ---------------------------------------------------------------------------

describe("full streaming sequence integration", () => {
  test("reasoning → text sequence produces correct block ordering", () => {
    const state = makeState()

    const allEvents = translateSequence(
      [
        [
          "response.created",
          { response: { id: "resp_int_1", model: "gpt-5-codex" } },
        ],
        [
          "response.output_item.added",
          { output_index: 0, item: { type: "reasoning", id: "rs_1" } },
        ],
        [
          "response.reasoning_summary_text.delta",
          { output_index: 0, summary_index: 0, delta: "thinking..." },
        ],
        [
          "response.output_item.done",
          {
            output_index: 0,
            item: {
              type: "reasoning",
              id: "rs_1",
              encrypted_content: "sig123",
            },
          },
        ],
        [
          "response.output_item.added",
          {
            output_index: 1,
            item: { type: "message", id: "msg_1", role: "assistant" },
          },
        ],
        [
          "response.output_text.delta",
          { output_index: 1, content_index: 0, delta: "Hello" },
        ],
        ["response.content_part.done", { output_index: 1, content_index: 0 }],
        [
          "response.completed",
          {
            response: {
              status: "completed",
              usage: { input_tokens: 100, output_tokens: 30 },
            },
          },
        ],
      ],
      state,
    )

    const types = allEvents.map((e) => e.type)

    // Protocol ordering checks
    const msgStartIdx = types.indexOf("message_start")
    const thinkStartIdx = types.indexOf("content_block_start")
    const thinkDeltaIdx = types.indexOf("content_block_delta")
    const msgDeltaIdx = types.lastIndexOf("message_delta")
    const msgStopIdx = types.lastIndexOf("message_stop")

    expect(msgStartIdx).toBeLessThan(thinkStartIdx)
    expect(thinkStartIdx).toBeLessThan(thinkDeltaIdx)
    expect(msgDeltaIdx).toBeLessThan(msgStopIdx)

    // signature_delta before first content_block_stop
    const sigDeltaIdx = types.findIndex(
      (t, i) =>
        t === "content_block_delta"
        && (allEvents[i] as { delta?: { type?: string } }).delta?.type
          === "signature_delta",
    )
    const firstStopIdx = types.indexOf("content_block_stop")
    expect(sigDeltaIdx).toBeLessThan(firstStopIdx)

    // Two content_block_stop events (one for reasoning, one for text)
    expect(types.filter((t) => t === "content_block_stop")).toHaveLength(2)
  })

  test("function_call sequence produces correct tool_use block", () => {
    const state = makeState()

    const allEvents = translateSequence(
      [
        [
          "response.created",
          { response: { id: "resp_int_2", model: "gpt-5-codex" } },
        ],
        [
          "response.output_item.added",
          {
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_1",
              call_id: "call_xyz",
              name: "search",
            },
          },
        ],
        [
          "response.function_call_arguments.delta",
          { output_index: 0, delta: '{"query":' },
        ],
        [
          "response.function_call_arguments.delta",
          { output_index: 0, delta: '"hello"}' },
        ],
        [
          "response.output_item.done",
          {
            output_index: 0,
            item: { type: "function_call", id: "fc_1" },
          },
        ],
        [
          "response.completed",
          {
            response: {
              status: "completed",
              usage: { input_tokens: 50, output_tokens: 10 },
            },
          },
        ],
      ],
      state,
    )

    const types = allEvents.map((e) => e.type)
    expect(types).toContain("message_start")
    expect(types).toContain("content_block_start")
    expect(types).toContain("content_block_delta")
    expect(types).toContain("content_block_stop")
    expect(types).toContain("message_delta")
    expect(types).toContain("message_stop")

    const toolStart = allEvents.find(
      (e) =>
        e.type === "content_block_start" && e.content_block.type === "tool_use",
    )
    if (
      toolStart?.type === "content_block_start"
      && toolStart.content_block.type === "tool_use"
    ) {
      expect(toolStart.content_block.id).toBe("call_xyz")
      expect(toolStart.content_block.name).toBe("search")
    }
  })
})

// ---------------------------------------------------------------------------
// Bug regression tests (from crew review round 1)
// ---------------------------------------------------------------------------

describe("regression — Bug 1: double content_block_stop for function_call", () => {
  test("response.content_part.done for function_call output_index emits no stop (already emitted by output_item.done)", () => {
    const state = makeState()

    // Register the function_call item
    translate(
      "response.output_item.added",
      {
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
    // output_item.done emits the stop
    translate(
      "response.output_item.done",
      {
        output_index: 0,
        item: { type: "function_call", id: "fc_1" },
      },
      state,
    )
    // content_part.done for the same output_index must NOT emit another stop
    const partDoneEvents = translate(
      "response.content_part.done",
      { output_index: 0 },
      state,
    )

    const stopEvents = partDoneEvents.filter(
      (e) => e.type === "content_block_stop",
    )
    expect(stopEvents).toHaveLength(0)
  })
})

describe("regression — Bug 2: unknown item type must not orphan content_block_stop", () => {
  test("unknown item type: no block index allocated, content_part.done produces no stop", () => {
    const state = makeState()

    // Unknown item type — should NOT allocate a block index
    translate(
      "response.output_item.added",
      {
        output_index: 0,
        item: { type: "some_future_item_type" },
      },
      state,
    )

    // Block index should still be 0 (nothing was allocated)
    expect(state.blockIndex).toBe(0)
    expect(state.outputIndexToBlockIndex.has(0)).toBe(false)

    // content_part.done for this output_index should produce nothing
    const events = translate(
      "response.content_part.done",
      { output_index: 0 },
      state,
    )
    const stopEvents = events.filter((e) => e.type === "content_block_stop")
    expect(stopEvents).toHaveLength(0)
  })

  test("unknown item followed by known item: block indexes are contiguous", () => {
    const state = makeState()

    // Unknown item at output_index 0 — skipped
    translate(
      "response.output_item.added",
      { output_index: 0, item: { type: "unknown_type" } },
      state,
    )

    // Known message item at output_index 1
    const events = translate(
      "response.output_item.added",
      {
        output_index: 1,
        item: { type: "message", role: "assistant" },
      },
      state,
    )

    // Block 0 should be assigned to output_index 1 (unknown skipped, no gap)
    expect(state.blockIndex).toBe(1)
    expect(state.outputIndexToBlockIndex.get(1)).toBe(0)

    const start = events.find((e) => e.type === "content_block_start")
    if (start?.type === "content_block_start") {
      expect(start.index).toBe(0)
    }
  })
})

describe("regression — Bug 3: message_start emitted even when response.id absent", () => {
  test("response.created with no response.id still emits message_start with fallback id", () => {
    const state = makeState()
    // No response.id in the payload
    const events = translate(
      "response.created",
      { response: { model: "gpt-5-codex" } },
      state,
    )

    const start = events.find((e) => e.type === "message_start")
    expect(start).toBeDefined()
    if (start?.type === "message_start") {
      expect(start.message.id).toBeTruthy() // fallback id generated
      expect(start.message.model).toBe("gpt-5-codex")
    }
    expect(state.messageStartSent).toBe(true)
  })

  test("response.created with completely empty data still emits message_start", () => {
    const state = makeState()
    const events = translate("response.created", {}, state)

    const start = events.find((e) => e.type === "message_start")
    expect(start).toBeDefined()
    expect(state.messageStartSent).toBe(true)
  })
})

describe("regression — Issue 4: stop_reason in message_delta never null", () => {
  test("unknown status → end_turn (not null)", () => {
    const state = makeState()
    const events = translate(
      "response.completed",
      {
        response: {
          status: "cancelled",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      state,
    )
    const delta = events.find((e) => e.type === "message_delta")
    if (delta?.type === "message_delta") {
      expect(delta.delta.stop_reason).toBe("end_turn")
      expect(delta.delta.stop_reason).not.toBeNull()
    }
  })
})
