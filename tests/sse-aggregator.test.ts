/**
 * SSE aggregator tests — run against captured fixtures that mirror the real
 * Anthropic / OpenAI streaming wire format we proxy through.
 *
 * These tests are JS-only (no React, no DOM), so they live alongside the
 * server bun:test suite and run in the same harness.
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion,
   @typescript-eslint/no-unsafe-member-access -- tests assert shape after
   aggregateSse returns; null-checks + as-narrowing would just add noise. */

import { describe, expect, test } from "bun:test"

import { aggregateSse } from "../ui/src/components/sse-aggregator"

// ---------------------------------------------------------------------------
// Anthropic — full happy path
// ---------------------------------------------------------------------------

describe("aggregateSse — Anthropic text-only response", () => {
  const fixture = `event: message_start
data: {"message":{"content":[],"id":"msg_01","model":"claude-opus-4-7","role":"assistant","type":"message","usage":{"input_tokens":6,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":36609}},"type":"message_start"}

event: content_block_start
data: {"content_block":{"text":"","type":"text"},"index":0,"type":"content_block_start"}

event: content_block_delta
data: {"delta":{"text":"Hello, ","type":"text_delta"},"index":0,"type":"content_block_delta"}

event: content_block_delta
data: {"delta":{"text":"world!","type":"text_delta"},"index":0,"type":"content_block_delta"}

event: content_block_stop
data: {"index":0,"type":"content_block_stop"}

event: message_delta
data: {"delta":{"stop_reason":"end_turn","stop_sequence":null},"type":"message_delta","usage":{"input_tokens":6,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":36609}}

event: message_stop
data: {"type":"message_stop"}

data: [DONE]`

  const agg = aggregateSse(fixture)

  test("recognises Anthropic shape", () => {
    expect(agg).not.toBeNull()
    expect(agg!.type ?? agg!.object).toBe("message")
  })

  test("reconstructs the assistant text content", () => {
    expect(agg!.content?.[0]).toEqual({
      type: "text",
      text: "Hello, world!",
    })
  })

  test("captures stop_reason", () => {
    expect(agg!.stop_reason).toBe("end_turn")
  })

  test("merges usage from message_start AND message_delta", () => {
    expect(agg!.usage).toMatchObject({
      input_tokens: 6,
      output_tokens: 2, // overwritten by the more recent message_delta
      cache_creation_input_tokens: 36609,
    })
  })

  test("propagates model + id", () => {
    expect(agg!.id).toBe("msg_01")
    expect(agg!.model).toBe("claude-opus-4-7")
  })
})

// ---------------------------------------------------------------------------
// Anthropic — thinking + tool_use blocks
// ---------------------------------------------------------------------------

describe("aggregateSse — Anthropic thinking + tool_use", () => {
  const fixture = `event: message_start
data: {"message":{"id":"msg_02","model":"claude-opus-4-7","role":"assistant","type":"message","usage":{"input_tokens":100,"output_tokens":1}},"type":"message_start"}

event: content_block_start
data: {"content_block":{"type":"thinking","thinking":""},"index":0,"type":"content_block_start"}

event: content_block_delta
data: {"delta":{"thinking":"Let me ","type":"thinking_delta"},"index":0,"type":"content_block_delta"}

event: content_block_delta
data: {"delta":{"thinking":"plan this out.","type":"thinking_delta"},"index":0,"type":"content_block_delta"}

event: content_block_delta
data: {"delta":{"signature":"sig_abc123","type":"signature_delta"},"index":0,"type":"content_block_delta"}

event: content_block_stop
data: {"index":0,"type":"content_block_stop"}

event: content_block_start
data: {"content_block":{"id":"toolu_01","input":{},"name":"task","type":"tool_use"},"index":1,"type":"content_block_start"}

event: content_block_delta
data: {"delta":{"partial_json":"{\\"description\\":\\"Test task\\"","type":"input_json_delta"},"index":1,"type":"content_block_delta"}

event: content_block_delta
data: {"delta":{"partial_json":",\\"priority\\":1}","type":"input_json_delta"},"index":1,"type":"content_block_delta"}

event: content_block_stop
data: {"index":1,"type":"content_block_stop"}

event: message_delta
data: {"delta":{"stop_reason":"tool_use","stop_sequence":null},"type":"message_delta","usage":{"input_tokens":100,"output_tokens":50}}

event: message_stop
data: {"type":"message_stop"}`

  const agg = aggregateSse(fixture)

  test("reconstructs concatenated thinking", () => {
    expect(agg!.content![0]).toMatchObject({
      type: "thinking",
      thinking: "Let me plan this out.",
      signature: "sig_abc123",
    })
  })

  test("reconstructs tool_use with parsed JSON input", () => {
    expect(agg!.content![1]).toMatchObject({
      type: "tool_use",
      id: "toolu_01",
      name: "task",
      input: { description: "Test task", priority: 1 },
    })
  })

  test("drops the internal _input_json accumulator after finalisation", () => {
    expect("_input_json" in agg!.content![1]).toBe(false)
  })

  test("captures tool_use stop_reason", () => {
    expect(agg!.stop_reason).toBe("tool_use")
  })
})

// ---------------------------------------------------------------------------
// Anthropic — malformed tool_use JSON falls back to string
// ---------------------------------------------------------------------------

describe("aggregateSse — Anthropic tool_use with malformed JSON", () => {
  const fixture = `event: message_start
data: {"message":{"role":"assistant","type":"message"},"type":"message_start"}

event: content_block_start
data: {"content_block":{"id":"toolu_x","input":{},"name":"f","type":"tool_use"},"index":0,"type":"content_block_start"}

event: content_block_delta
data: {"delta":{"partial_json":"{not valid json","type":"input_json_delta"},"index":0,"type":"content_block_delta"}

event: content_block_stop
data: {"index":0,"type":"content_block_stop"}

event: message_stop
data: {"type":"message_stop"}`

  test("falls back to raw string instead of throwing", () => {
    const agg = aggregateSse(fixture)
    expect(agg!.content![0].input).toBe("{not valid json")
  })
})

// ---------------------------------------------------------------------------
// OpenAI chat completion
// ---------------------------------------------------------------------------

describe("aggregateSse — OpenAI chat completion stream", () => {
  const fixture = `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}

data: [DONE]`

  const agg = aggregateSse(fixture)

  test("recognises OpenAI shape", () => {
    expect(agg).not.toBeNull()
    expect((agg as { object?: string }).object).toBe("chat.completion")
  })

  test("concatenates content from delta chunks", () => {
    expect(
      (agg as { choices: Array<{ message: { content: string } }> }).choices[0]
        .message.content,
    ).toBe("Hi there")
  })

  test("captures finish_reason and usage", () => {
    const a = agg as {
      choices: Array<{ finish_reason: string }>
      usage?: Record<string, unknown>
    }
    expect(a.choices[0].finish_reason).toBe("stop")
    expect(a.usage).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    })
  })
})

// ---------------------------------------------------------------------------
// Edge cases — should NOT throw, should return null gracefully
// ---------------------------------------------------------------------------

describe("aggregateSse — error paths return null, never throw", () => {
  test("empty string", () => {
    expect(aggregateSse("")).toBeNull()
  })

  test("plain JSON (not SSE)", () => {
    expect(aggregateSse('{"foo":"bar"}')).toBeNull()
  })

  test("garbage", () => {
    expect(aggregateSse("not an sse stream")).toBeNull()
  })

  test("SSE-looking text but no recognised event grammar", () => {
    const fixture = `event: unknown_event
data: {"foo":"bar"}

data: [DONE]`
    // Not Anthropic (no message_start) and not OpenAI shape — returns null.
    expect(aggregateSse(fixture)).toBeNull()
  })
})
