/**
 * Regression tests for protocol-compliance fixes in the Responses → Anthropic
 * SSE translator: ping ordering and orphan-block sweep on terminal events.
 */

import { describe, expect, test } from "bun:test"

import {
  makeResponsesStreamState,
  translateResponsesEventToAnthropic,
} from "../src/routes/messages/responses-stream-translation"

describe("responses-stream-translation — defensive paths", () => {
  test("ping NEVER fires before message_start, even after 20+ ignored events", () => {
    // Pump 25 unknown events. Pre-fix, every PING_INTERVAL=20 events would
    // emit a ping with no message_start fired → strict Anthropic clients
    // reject the whole stream.
    const state = makeResponsesStreamState()
    const allEvents = Array.from({ length: 25 }, (_, i) => i).flatMap(() =>
      translateResponsesEventToAnthropic(
        "response.unknown.event.type",
        {},
        state,
      ),
    )
    // Pre-fix: would contain at least one { type: "ping" }
    expect(allEvents.filter((e) => e.type === "ping")).toHaveLength(0)
  })

  test("response.completed without prior message_start emits synthetic message_start + message_stop", () => {
    const state = makeResponsesStreamState()
    const events = translateResponsesEventToAnthropic(
      "response.completed",
      {
        response: {
          id: "resp_x",
          model: "gpt-x",
          status: "completed",
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      state,
    )
    const types = events.map((e) => e.type)
    // message_start must appear first
    expect(types[0]).toBe("message_start")
    // message_stop must appear last
    expect(types.at(-1)).toBe("message_stop")
    expect(state.messageStartSent).toBe(true)
  })

  test("response.failed without prior message_start still emits valid trailer", () => {
    const state = makeResponsesStreamState()
    const events = translateResponsesEventToAnthropic(
      "response.failed",
      { response: { error: { message: "boom" } } },
      state,
    )
    const types = events.map((e) => e.type)
    expect(types[0]).toBe("message_start")
    expect(types).toContain("error")
    expect(types.at(-1)).toBe("message_stop")
  })

  test("response.completed closes orphaned content blocks", () => {
    const state = makeResponsesStreamState()
    // Open a reasoning block but never close it via output_item.done — then
    // jump straight to response.completed. Pre-fix the reasoning block
    // never got a content_block_stop → Anthropic clients reject the stream.
    translateResponsesEventToAnthropic(
      "response.created",
      { response: { id: "r1", model: "x" } },
      state,
    )
    translateResponsesEventToAnthropic(
      "response.output_item.added",
      { output_index: 0, item: { type: "reasoning", id: "rs" } },
      state,
    )
    const tail = translateResponsesEventToAnthropic(
      "response.completed",
      { response: { id: "r1", status: "completed" } },
      state,
    )
    const stops = tail.filter((e) => e.type === "content_block_stop")
    expect(stops).toHaveLength(1)
    expect(tail.at(-1)?.type).toBe("message_stop")
  })

  test("response.completed does NOT double-stop blocks closed via output_item.done", () => {
    const state = makeResponsesStreamState()
    const sequence: Array<[string, unknown]> = [
      ["response.created", { response: { id: "r1", model: "x" } }],
      [
        "response.output_item.added",
        { output_index: 0, item: { type: "reasoning", id: "rs" } },
      ],
      [
        "response.output_item.done",
        { output_index: 0, item: { type: "reasoning", id: "rs" } },
      ],
      ["response.completed", { response: { id: "r1", status: "completed" } }],
    ]
    const all = sequence.flatMap(([type, data]) =>
      translateResponsesEventToAnthropic(type, data, state),
    )
    const stops = all.filter((e) => e.type === "content_block_stop")
    // Exactly one — the one from output_item.done. response.completed must
    // NOT emit a second one for the same block.
    expect(stops).toHaveLength(1)
  })

  test("response.completed does NOT double-stop text blocks closed via content_part.done", () => {
    const state = makeResponsesStreamState()
    const sequence: Array<[string, unknown]> = [
      ["response.created", { response: { id: "r1", model: "x" } }],
      [
        "response.output_item.added",
        { output_index: 0, item: { type: "message", id: "m1" } },
      ],
      ["response.output_text.delta", { output_index: 0, delta: "Hi" }],
      ["response.content_part.done", { output_index: 0 }],
      ["response.completed", { response: { id: "r1", status: "completed" } }],
    ]
    const all = sequence.flatMap(([type, data]) =>
      translateResponsesEventToAnthropic(type, data, state),
    )
    const stops = all.filter((e) => e.type === "content_block_stop")
    expect(stops).toHaveLength(1)
  })
})
