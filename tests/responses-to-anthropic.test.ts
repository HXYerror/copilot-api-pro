import { describe, test, expect } from "bun:test"

import type { ResponsesResponse } from "~/routes/responses/types"

import { translateResponsesToAnthropic } from "../src/routes/messages/responses-to-anthropic"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(
  overrides: Partial<ResponsesResponse> = {},
): ResponsesResponse {
  return {
    id: "resp_abc123",
    object: "response",
    created_at: 1_700_000_000,
    model: "gpt-5-codex",
    status: "completed",
    output: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// reasoning item → thinking block
// ---------------------------------------------------------------------------

describe("translateResponsesToAnthropic — reasoning items", () => {
  test("reasoning item → thinking block with summary text and signature", () => {
    const response = makeResponse({
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "opaque-sig-blob",
          summary: [{ type: "summary_text", text: "I thought hard about it" }],
          status: "completed",
        },
      ],
    })
    const result = translateResponsesToAnthropic(response)
    expect(result.content).toHaveLength(1)
    const block = result.content[0]
    expect(block.type).toBe("thinking")
    if (block.type === "thinking") {
      expect(block.thinking).toBe("I thought hard about it")
      expect(block.signature).toBe("opaque-sig-blob")
    }
  })

  test("reasoning item without summary → thinking: ''", () => {
    const response = makeResponse({
      output: [
        {
          type: "reasoning",
          id: "rs_nosummary",
          encrypted_content: "blob",
          status: "completed",
        },
      ],
    })
    const result = translateResponsesToAnthropic(response)
    const block = result.content[0]
    expect(block.type).toBe("thinking")
    if (block.type === "thinking") {
      expect(block.thinking).toBe("")
      expect(block.signature).toBe("blob")
    }
  })

  test("reasoning item without encrypted_content → no signature field", () => {
    const response = makeResponse({
      output: [
        {
          type: "reasoning",
          id: "rs_nosig",
          summary: [{ type: "summary_text", text: "some thought" }],
          status: "completed",
        },
      ],
    })
    const result = translateResponsesToAnthropic(response)
    const block = result.content[0]
    expect(block.type).toBe("thinking")
    if (block.type === "thinking") {
      expect("signature" in block).toBe(false)
    }
  })

  test("multiple summary entries → uses first summary text", () => {
    const response = makeResponse({
      output: [
        {
          type: "reasoning",
          id: "rs_multi",
          summary: [
            { type: "summary_text", text: "first" },
            { type: "summary_text", text: "second" },
          ],
          status: "completed",
        },
      ],
    })
    const result = translateResponsesToAnthropic(response)
    const block = result.content[0]
    if (block.type === "thinking") {
      expect(block.thinking).toBe("first")
    }
  })
})

// ---------------------------------------------------------------------------
// message item → text block
// ---------------------------------------------------------------------------

describe("translateResponsesToAnthropic — message items", () => {
  test("message item with output_text → text block", () => {
    const response = makeResponse({
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello there" }],
          status: "completed",
        },
      ],
    })
    const result = translateResponsesToAnthropic(response)
    expect(result.content).toHaveLength(1)
    const block = result.content[0]
    expect(block.type).toBe("text")
    if (block.type === "text") {
      expect(block.text).toBe("Hello there")
    }
  })

  test("message with multiple output_text parts → merged into single text block", () => {
    const response = makeResponse({
      output: [
        {
          type: "message",
          id: "msg_2",
          role: "assistant",
          content: [
            { type: "output_text", text: "Part one. " },
            { type: "output_text", text: "Part two." },
          ],
          status: "completed",
        },
      ],
    })
    const result = translateResponsesToAnthropic(response)
    expect(result.content).toHaveLength(1)
    const block = result.content[0]
    if (block.type === "text") {
      expect(block.text).toBe("Part one. Part two.")
    }
  })

  test("message containing only refusal → surfaces refusal as text block", () => {
    // Previous behaviour was to drop the message entirely (content: []),
    // which made the assistant look like it went silent. We now flatten
    // refusal text into a normal text block so the client at least sees
    // why their request was declined — Anthropic has no native refusal
    // block, this is the least-bad faithful translation.
    const response = makeResponse({
      output: [
        {
          type: "message",
          id: "msg_3",
          role: "assistant",
          content: [{ type: "refusal", refusal: "I cannot do that." }],
          status: "completed",
        },
      ],
    })
    const result = translateResponsesToAnthropic(response)
    expect(result.content).toHaveLength(1)
    const block = result.content[0]
    expect(block.type).toBe("text")
    if (block.type === "text") {
      expect(block.text).toBe("I cannot do that.")
    }
  })
})

// ---------------------------------------------------------------------------
// function_call item → tool_use block
// ---------------------------------------------------------------------------

describe("translateResponsesToAnthropic — function_call items", () => {
  test("function_call item → tool_use block", () => {
    const response = makeResponse({
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "get_weather",
          arguments: '{"city":"London"}',
          status: "completed",
        },
      ],
    })
    const result = translateResponsesToAnthropic(response)
    expect(result.content).toHaveLength(1)
    const block = result.content[0]
    expect(block.type).toBe("tool_use")
    if (block.type === "tool_use") {
      expect(block.id).toBe("call_abc")
      expect(block.name).toBe("get_weather")
      expect(block.input).toEqual({ city: "London" })
    }
  })

  test("function_call with invalid JSON arguments → wrapped in _raw", () => {
    const response = makeResponse({
      output: [
        {
          type: "function_call",
          id: "fc_2",
          call_id: "call_bad",
          name: "broken_tool",
          arguments: "not-json",
          status: "completed",
        },
      ],
    })
    const result = translateResponsesToAnthropic(response)
    expect(result.content[0].type).toBe("tool_use")
    const block = result.content[0]
    if (block.type === "tool_use") {
      expect(block.input).toEqual({ _raw: "not-json" })
    }
  })

  test("function_call with array JSON arguments → wrapped in _raw (non-object guard)", () => {
    const response = makeResponse({
      output: [
        {
          type: "function_call",
          id: "fc_arr",
          call_id: "call_arr",
          name: "array_tool",
          arguments: JSON.stringify([1, 2, 3]),
          status: "completed",
        },
      ],
    })
    const result = translateResponsesToAnthropic(response)
    expect(result.content[0].type).toBe("tool_use")
    const block = result.content[0]
    if (block.type === "tool_use") {
      expect(block.input).toEqual({ _raw: "[1,2,3]" })
    }
  })

  test("function_call with __proto__ in arguments → stripped (prototype pollution guard)", () => {
    const response = makeResponse({
      output: [
        {
          type: "function_call",
          id: "fc_3",
          call_id: "call_proto",
          name: "evil_tool",
          // Use a raw string literal — JSON.stringify({__proto__:...}) silently
          // drops the key because the JS engine treats it as a prototype setter.
          arguments: '{"__proto__":{"isAdmin":true},"city":"London"}',
          status: "completed",
        },
      ],
    })
    const result = translateResponsesToAnthropic(response)
    expect(result.content[0].type).toBe("tool_use")
    const block = result.content[0]
    if (block.type === "tool_use") {
      expect(Object.hasOwn(block.input, "__proto__")).toBe(false)
      expect(block.input.city).toBe("London")
    }
  })

  test("function_call with constructor/prototype keys → stripped", () => {
    const args =
      '{"constructor":{"name":"hacked"},"prototype":{"x":1},"value":42}'
    const response = makeResponse({
      output: [
        {
          type: "function_call",
          id: "fc_4",
          call_id: "call_ctor",
          name: "ctor_tool",
          arguments: args,
          status: "completed",
        },
      ],
    })
    const result = translateResponsesToAnthropic(response)
    expect(result.content[0].type).toBe("tool_use")
    const block = result.content[0]
    if (block.type === "tool_use") {
      expect(Object.hasOwn(block.input, "constructor")).toBe(false)
      expect(Object.hasOwn(block.input, "prototype")).toBe(false)
      expect(block.input.value).toBe(42)
    }
  })
})

// ---------------------------------------------------------------------------
// status → stop_reason mapping
// ---------------------------------------------------------------------------

describe("translateResponsesToAnthropic — status / stop_reason", () => {
  test("status 'completed' → stop_reason 'end_turn'", () => {
    const result = translateResponsesToAnthropic(
      makeResponse({ status: "completed" }),
    )
    expect(result.stop_reason).toBe("end_turn")
  })

  test("status 'incomplete' → stop_reason 'max_tokens'", () => {
    const result = translateResponsesToAnthropic(
      makeResponse({ status: "incomplete" }),
    )
    expect(result.stop_reason).toBe("max_tokens")
  })

  test("status 'failed' → stop_reason null", () => {
    const result = translateResponsesToAnthropic(
      makeResponse({ status: "failed" }),
    )
    expect(result.stop_reason).toBeNull()
  })

  test("status 'cancelled' → stop_reason null", () => {
    const result = translateResponsesToAnthropic(
      makeResponse({ status: "cancelled" }),
    )
    expect(result.stop_reason).toBeNull()
  })

  test("function_call present → stop_reason 'tool_use' regardless of status", () => {
    const result = translateResponsesToAnthropic(
      makeResponse({
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_xyz",
            name: "do_thing",
            arguments: "{}",
            status: "completed",
          },
        ],
      }),
    )
    expect(result.stop_reason).toBe("tool_use")
  })

  test("function_call present with status 'incomplete' → stop_reason 'tool_use' (tool_use takes precedence)", () => {
    const result = translateResponsesToAnthropic(
      makeResponse({
        status: "incomplete",
        output: [
          {
            type: "function_call",
            id: "fc_2",
            call_id: "call_preempt",
            name: "some_tool",
            arguments: "{}",
            status: "completed",
          },
        ],
      }),
    )
    expect(result.stop_reason).toBe("tool_use")
  })

  test("function_call present with status 'in_progress' → stop_reason 'tool_use'", () => {
    // The response-level status may still be "in_progress" while a function_call
    // item is already present. tool_use must take precedence over any status-derived
    // stop_reason so callers know to execute the tool.
    const result = translateResponsesToAnthropic(
      makeResponse({
        status: "in_progress",
        output: [
          {
            type: "function_call",
            id: "fc_inprog",
            call_id: "call_inprog",
            name: "stream_tool",
            arguments: '{"x":1}',
            status: "in_progress",
          },
        ],
      }),
    )
    expect(result.stop_reason).toBe("tool_use")
  })
})

// ---------------------------------------------------------------------------
// usage mapping
// ---------------------------------------------------------------------------

describe("translateResponsesToAnthropic — usage", () => {
  test("usage fields mapped correctly", () => {
    const result = translateResponsesToAnthropic(
      makeResponse({
        usage: {
          input_tokens: 120,
          output_tokens: 80,
          total_tokens: 200,
          output_tokens_details: { reasoning_tokens: 40 },
        },
      }),
    )
    expect(result.usage.input_tokens).toBe(120)
    expect(result.usage.output_tokens).toBe(80)
  })

  test("cached input tokens → cache_read_input_tokens", () => {
    const result = translateResponsesToAnthropic(
      makeResponse({
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          total_tokens: 250,
          input_tokens_details: { cached_tokens: 100 },
        },
      }),
    )
    expect(result.usage.cache_read_input_tokens).toBe(100)
  })

  test("no usage → defaults to 0", () => {
    const result = translateResponsesToAnthropic(
      makeResponse({ usage: undefined }),
    )
    expect(result.usage.input_tokens).toBe(0)
    expect(result.usage.output_tokens).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ID, model, role passthrough
// ---------------------------------------------------------------------------

describe("translateResponsesToAnthropic — top-level fields", () => {
  test("id → id", () => {
    const result = translateResponsesToAnthropic(
      makeResponse({ id: "resp_xyz" }),
    )
    expect(result.id).toBe("resp_xyz")
  })

  test("model → model", () => {
    const result = translateResponsesToAnthropic(
      makeResponse({ model: "gpt-5-codex" }),
    )
    expect(result.model).toBe("gpt-5-codex")
  })

  test("type is always 'message'", () => {
    const result = translateResponsesToAnthropic(makeResponse())
    expect(result.type).toBe("message")
  })

  test("role is always 'assistant'", () => {
    const result = translateResponsesToAnthropic(makeResponse())
    expect(result.role).toBe("assistant")
  })

  test("stop_sequence is always null", () => {
    const result = translateResponsesToAnthropic(makeResponse())
    expect(result.stop_sequence).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Mixed output ordering
// ---------------------------------------------------------------------------

describe("translateResponsesToAnthropic — mixed output ordering", () => {
  test("reasoning before message → thinking block before text block", () => {
    const result = translateResponsesToAnthropic(
      makeResponse({
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "sig",
            summary: [{ type: "summary_text", text: "I thought" }],
            status: "completed",
          },
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "Answer" }],
            status: "completed",
          },
        ],
      }),
    )
    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe("thinking")
    expect(result.content[1].type).toBe("text")
  })

  test("empty output → empty content array", () => {
    const result = translateResponsesToAnthropic(makeResponse({ output: [] }))
    expect(result.content).toEqual([])
  })
})
