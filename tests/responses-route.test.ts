import {
  describe,
  test,
  expect,
  mock,
  beforeAll,
  beforeEach,
  afterEach,
} from "bun:test"

import { state } from "../src/lib/state"
import { server } from "../src/server"

// ---------------------------------------------------------------------------
// Global fetch mock — returns a minimal non-streaming Responses API response
// ---------------------------------------------------------------------------

const mockResponseBody = {
  id: "resp_test",
  object: "response",
  created_at: 1_700_000_000,
  model: "gpt-4o",
  status: "completed",
  output: [],
}

const fetchMock = mock(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve(mockResponseBody),
  }),
)

// @ts-expect-error – mock doesn't implement full fetch signature
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

// Set up copilot token so createResponses doesn't throw
beforeAll(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.99.0"
  state.accountType = "individual"
  state.manualApprove = false
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/responses — wired handler", () => {
  test("non-streaming request returns upstream JSON", async () => {
    const res = await server.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: [], stream: false }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as typeof mockResponseBody
    expect(body.object).toBe("response")
    expect(body.id).toBe("resp_test")
  })

  test("same endpoint reachable at bare /responses path", async () => {
    const res = await server.request("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: [], stream: false }),
    })
    expect(res.status).toBe(200)
  })

  test("invalid JSON body returns 400", async () => {
    const res = await server.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{{",
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { type: string; code: string }
    }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.code).toBe("invalid_json")
  })

  test("missing copilot token returns 500", async () => {
    state.copilotToken = undefined
    try {
      const res = await server.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", input: [] }),
      })
      expect(res.status).toBe(500)
    } finally {
      state.copilotToken = "test-token"
    }
  })
})

// ---------------------------------------------------------------------------
// createResponses behavior: X-Initiator header and error propagation
// ---------------------------------------------------------------------------

describe("createResponses behavior", () => {
  // Restore state and fetch mock before/after each test in this block
  beforeEach(() => {
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.99.0"
    state.accountType = "individual"
    state.manualApprove = false
  })

  afterEach(() => {
    // @ts-expect-error – mock doesn't implement full fetch signature
    globalThis.fetch = fetchMock
  })

  test("X-Initiator = agent when assistant message present", async () => {
    const captureMock = mock(
      (_url: string, opts: { headers: Record<string, string> }) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockResponseBody),
          headers: opts.headers,
        }),
    )
    // @ts-expect-error – mock doesn't implement full fetch signature
    globalThis.fetch = captureMock

    await server.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        stream: false,
        input: [
          { type: "message", role: "user", content: "hello" },
          { type: "message", role: "assistant", content: "hi there" },
        ],
      }),
    })

    expect(captureMock).toHaveBeenCalled()
    const sentHeaders = (
      captureMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(sentHeaders["X-Initiator"]).toBe("agent")
  })

  test("X-Initiator = user for pure user messages", async () => {
    const captureMock = mock(
      (_url: string, opts: { headers: Record<string, string> }) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockResponseBody),
          headers: opts.headers,
        }),
    )
    // @ts-expect-error – mock doesn't implement full fetch signature
    globalThis.fetch = captureMock

    await server.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        stream: false,
        input: [{ type: "message", role: "user", content: "just a user" }],
      }),
    })

    expect(captureMock).toHaveBeenCalled()
    const sentHeaders = (
      captureMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(sentHeaders["X-Initiator"]).toBe("user")
  })

  test("X-Initiator = agent for function_call_output item", async () => {
    const captureMock = mock(
      (_url: string, opts: { headers: Record<string, string> }) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockResponseBody),
          headers: opts.headers,
        }),
    )
    // @ts-expect-error – mock doesn't implement full fetch signature
    globalThis.fetch = captureMock

    await server.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        stream: false,
        input: [
          { type: "function_call_output", call_id: "call_1", output: "{}" },
        ],
      }),
    })

    expect(captureMock).toHaveBeenCalled()
    const sentHeaders = (
      captureMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(sentHeaders["X-Initiator"]).toBe("agent")
  })

  test("X-Initiator = agent for reasoning item (multi-turn context echo)", async () => {
    const captureMock = mock(
      (_url: string, opts: { headers: Record<string, string> }) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockResponseBody),
          headers: opts.headers,
        }),
    )
    // @ts-expect-error – mock doesn't implement full fetch signature
    globalThis.fetch = captureMock

    await server.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        stream: false,
        input: [
          {
            type: "reasoning",
            id: "rs_abc",
            encrypted_content: "opaque-blob",
            status: "completed",
          },
        ],
      }),
    })

    expect(captureMock).toHaveBeenCalled()
    const sentHeaders = (
      captureMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(sentHeaders["X-Initiator"]).toBe("agent")
  })

  test("upstream 4xx returns error response", async () => {
    const errorMock = mock(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        text: () => Promise.resolve("rate limited"),
      }),
    )
    // @ts-expect-error – mock doesn't implement full fetch signature
    globalThis.fetch = errorMock

    const res = await server.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", stream: false, input: [] }),
    })

    expect(res.status).toBe(429)
  })

  test("streaming request proxies SSE events and returns text/event-stream", async () => {
    const sseBody =
      'event: response.created\ndata: {"type":"response.created"}\n\n'
      + 'event: response.completed\ndata: {"type":"response.completed"}\n\n'
      + "data: [DONE]\n\n"

    const streamMock = mock(() =>
      Promise.resolve({
        ok: true,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseBody))
            controller.close()
          },
        }),
      }),
    )
    // @ts-expect-error – mock doesn't implement full fetch signature
    globalThis.fetch = streamMock

    const res = await server.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: [], stream: true }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/)
    const text = await res.text()
    expect(text).toContain("response.created")
    expect(text).toContain("response.completed")
  })
})

// ---------------------------------------------------------------------------
// Feature #11 — Copilot-Vision-Request header
// ---------------------------------------------------------------------------

describe("createResponses — vision header (#11)", () => {
  beforeEach(() => {
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.99.0"
    state.accountType = "individual"
    state.manualApprove = false
  })

  afterEach(() => {
    // @ts-expect-error – mock doesn't implement full fetch signature
    globalThis.fetch = fetchMock
  })

  test("copilot-vision-request header is set when input contains input_image", async () => {
    const captureMock = mock(
      (_url: string, opts: { headers: Record<string, string> }) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockResponseBody),
          headers: opts.headers,
        }),
    )
    // @ts-expect-error – mock doesn't implement full fetch signature
    globalThis.fetch = captureMock

    await server.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        stream: false,
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "What is in this image?" },
              {
                type: "input_image",
                image_url: "https://example.com/img.png",
                detail: "auto",
              },
            ],
          },
        ],
      }),
    })

    expect(captureMock).toHaveBeenCalled()
    const sentHeaders = (
      captureMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(sentHeaders["copilot-vision-request"]).toBe("true")
  })

  test("copilot-vision-request header is absent for text-only input", async () => {
    const captureMock = mock(
      (_url: string, opts: { headers: Record<string, string> }) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockResponseBody),
          headers: opts.headers,
        }),
    )
    // @ts-expect-error – mock doesn't implement full fetch signature
    globalThis.fetch = captureMock

    await server.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        stream: false,
        input: [{ type: "message", role: "user", content: "just text" }],
      }),
    })

    expect(captureMock).toHaveBeenCalled()
    const sentHeaders = (
      captureMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(sentHeaders["copilot-vision-request"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Feature #12 — previous_response_id passthrough
// ---------------------------------------------------------------------------

describe("createResponses — previous_response_id passthrough (#12)", () => {
  beforeEach(() => {
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.99.0"
    state.accountType = "individual"
    state.manualApprove = false
  })

  afterEach(() => {
    // @ts-expect-error – mock doesn't implement full fetch signature
    globalThis.fetch = fetchMock
  })

  test("previous_response_id is forwarded verbatim in the upstream request body", async () => {
    const captureMock = mock(
      (_url: string, opts: { headers: Record<string, string>; body: string }) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockResponseBody),
          headers: opts.headers,
        }),
    )
    // @ts-expect-error – mock doesn't implement full fetch signature
    globalThis.fetch = captureMock

    await server.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        stream: false,
        input: [{ type: "message", role: "user", content: "continue" }],
        previous_response_id: "resp_prev_123",
      }),
    })

    expect(captureMock).toHaveBeenCalled()
    const sentBody = JSON.parse(
      (captureMock.mock.calls[0][1] as { body: string }).body,
    ) as { previous_response_id?: string }
    expect(sentBody.previous_response_id).toBe("resp_prev_123")
  })

  test("previous_response_id is absent in body when not provided", async () => {
    const captureMock = mock(
      (_url: string, opts: { headers: Record<string, string>; body: string }) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockResponseBody),
          headers: opts.headers,
        }),
    )
    // @ts-expect-error – mock doesn't implement full fetch signature
    globalThis.fetch = captureMock

    await server.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        stream: false,
        input: [{ type: "message", role: "user", content: "fresh start" }],
      }),
    })

    expect(captureMock).toHaveBeenCalled()
    const sentBody = JSON.parse(
      (captureMock.mock.calls[0][1] as { body: string }).body,
    ) as { previous_response_id?: string }
    expect(sentBody.previous_response_id).toBeUndefined()
  })
})
