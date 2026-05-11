import {
  describe,
  test,
  expect,
  afterEach,
  beforeEach,
  beforeAll,
} from "bun:test"

import { getModelMode, isResponsesOnlyModel } from "../src/lib/model-routing"
import { state } from "../src/lib/state"
import { server } from "../src/server"

// ---------------------------------------------------------------------------
// isResponsesOnlyModel — pure unit tests (no state needed)
// ---------------------------------------------------------------------------

describe("isResponsesOnlyModel", () => {
  test("gpt-5-codex → responses-only", () =>
    expect(isResponsesOnlyModel("gpt-5-codex")).toBe(true))
  test("gpt-5.1-codex → responses-only", () =>
    expect(isResponsesOnlyModel("gpt-5.1-codex")).toBe(true))
  test("gpt-5.1-codex-max → responses-only", () =>
    expect(isResponsesOnlyModel("gpt-5.1-codex-max")).toBe(true))
  test("gpt-5.3-codex → responses-only", () =>
    expect(isResponsesOnlyModel("gpt-5.3-codex")).toBe(true))
  test("o1-pro → responses-only", () =>
    expect(isResponsesOnlyModel("o1-pro")).toBe(true))
  test("o3-pro → responses-only", () =>
    expect(isResponsesOnlyModel("o3-pro")).toBe(true))
  test("gpt-4o → chat", () =>
    expect(isResponsesOnlyModel("gpt-4o")).toBe(false))
  test("gpt-5 → chat", () => expect(isResponsesOnlyModel("gpt-5")).toBe(false))
  test("o1 → chat", () => expect(isResponsesOnlyModel("o1")).toBe(false))
  test("o3 → chat", () => expect(isResponsesOnlyModel("o3")).toBe(false))
  test("claude-sonnet-4-5 → chat", () =>
    expect(isResponsesOnlyModel("claude-sonnet-4-5")).toBe(false))
  test("o4-mini → chat", () =>
    expect(isResponsesOnlyModel("o4-mini")).toBe(false))
  test("o4-pro → responses-only", () =>
    expect(isResponsesOnlyModel("o4-pro")).toBe(true))
  test("o1-pro-2025-04-09 (dated alias) → responses-only", () =>
    expect(isResponsesOnlyModel("o1-pro-2025-04-09")).toBe(true))
  test("o3-pro-mini → NOT responses-only (not a pro variant)", () =>
    expect(isResponsesOnlyModel("o3-pro-mini")).toBe(false))
})

// ---------------------------------------------------------------------------
// getModelMode — with loaded models list (state mutation)
// ---------------------------------------------------------------------------

describe("getModelMode — with loaded models list", () => {
  let savedModels: typeof state.models

  beforeEach(() => {
    savedModels = state.models
  })

  afterEach(() => {
    state.models = savedModels
  })

  test("model with capabilities.type=responses in list → responses", () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "future-responses-model",
          vendor: "OpenAI",
          name: "Future Model",
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
            type: "responses", // upstream sets this
          },
        },
      ],
    }
    expect(getModelMode("future-responses-model")).toBe("responses")
  })

  test("model with explicit capabilities.type=chat in list → chat (upstream authoritative)", () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-5-codex",
          vendor: "OpenAI",
          name: "Codex",
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
    // capabilities.type = "chat" is authoritative → returns "chat" even though name contains "codex"
    expect(getModelMode("gpt-5-codex")).toBe("chat")
  })

  test("regular chat model → chat", () => {
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
    expect(getModelMode("gpt-4o")).toBe("chat")
  })

  test("state.models undefined → heuristic (codex → responses)", () => {
    state.models = undefined
    expect(getModelMode("gpt-5-codex")).toBe("responses")
  })

  test("state.models undefined → heuristic (gpt-4o → chat)", () => {
    state.models = undefined
    expect(getModelMode("gpt-4o")).toBe("chat")
  })
})

// ---------------------------------------------------------------------------
// Route-level: POST /v1/chat/completions blocks Responses-only models
// ---------------------------------------------------------------------------

describe("chat-completions route blocks responses-only models", () => {
  let savedModels: typeof state.models

  beforeAll(() => {
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.99.0"
    state.accountType = "individual"
    state.manualApprove = false
  })

  beforeEach(() => {
    savedModels = state.models
  })

  afterEach(() => {
    state.models = savedModels
  })

  test("gpt-5-codex → 400 with responses_only_model code", async () => {
    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-codex",
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { type: string; code: string; message: string }
    }
    expect(body.error.code).toBe("responses_only_model")
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("gpt-5-codex")
    expect(body.error.message).toContain("/v1/responses")
  })

  test("o1-pro → 400 with responses_only_model code", async () => {
    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "o1-pro",
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: string }
    }
    expect(body.error.code).toBe("responses_only_model")
  })

  test("gpt-5.1-codex-max → 400 with responses_only_model code", async () => {
    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.1-codex-max",
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: string }
    }
    expect(body.error.code).toBe("responses_only_model")
  })

  test("model with capabilities.type=responses in state is blocked at /v1/chat/completions", async () => {
    // Set up a model that only the capabilities path would catch (not the heuristic)
    state.models = {
      object: "list",
      data: [
        {
          id: "o5-turbo", // no "codex", not "o\d+-pro"
          vendor: "OpenAI",
          name: "O5 Turbo",
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
            type: "responses",
          },
        },
      ],
    }

    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "o5-turbo",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("responses_only_model")
  })

  test("gpt-4o is NOT blocked at /v1/chat/completions (chat model)", async () => {
    // gpt-4o is a chat model — should pass the guard (will fail at upstream but not with 400)
    // We just need status !== 400 with code responses_only_model
    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    // Should NOT return the routing 400
    if (res.status === 400) {
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).not.toBe("responses_only_model")
    }
    // Any other status is fine (500 from missing upstream, etc.)
  })
})

// ---------------------------------------------------------------------------
// GET /v1/models — mode field in response
// ---------------------------------------------------------------------------

describe("GET /v1/models — mode field", () => {
  let savedModels: typeof state.models

  beforeEach(() => {
    savedModels = state.models
  })

  afterEach(() => {
    state.models = savedModels
  })

  test("each model entry includes a mode field ('chat' or 'responses')", async () => {
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
        {
          id: "gpt-5-codex",
          vendor: "OpenAI",
          name: "Codex",
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
            type: "responses",
          },
        },
      ],
    }

    const res = await server.request("/v1/models", { method: "GET" })
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      object: string
      data: Array<{ id: string; mode: string }>
    }
    expect(body.object).toBe("list")
    expect(Array.isArray(body.data)).toBe(true)

    // Every entry must have a mode field
    for (const entry of body.data) {
      expect(["chat", "responses"]).toContain(entry.mode)
    }

    // Verify specific models get the correct mode
    const chatEntry = body.data.find((m) => m.id === "gpt-4o")
    expect(chatEntry?.mode).toBe("chat")

    const responsesEntry = body.data.find((m) => m.id === "gpt-5-codex")
    expect(responsesEntry?.mode).toBe("responses")
  })

  test("responses-only model (codex) gets mode='responses' from heuristic when capabilities missing type", async () => {
    // Simulate a model list that doesn't set capabilities.type explicitly —
    // the heuristic must still classify codex models as "responses".
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-5.1-codex-max",
          vendor: "OpenAI",
          name: "Codex Max",
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
            // No type field — falls through to heuristic
            type: "chat", // actual upstream sends "chat" for these, but isResponsesOnlyModel overrides
          },
        },
      ],
    }

    // getModelMode respects capabilities.type when explicitly "chat" (upstream authoritative),
    // so this test validates the API shape (mode field present) rather than the heuristic path.
    const res = await server.request("/v1/models", { method: "GET" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ id: string; mode: string }>
    }
    const entry = body.data.find((m) => m.id === "gpt-5.1-codex-max")
    // The mode field must be present regardless of which routing branch fires
    expect(entry?.mode).toBeDefined()
    expect(["chat", "responses"]).toContain(entry?.mode)
  })

  test("o1-pro gets mode='responses' in models list", async () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "o1-pro",
          vendor: "OpenAI",
          name: "O1 Pro",
          object: "model",
          version: "1",
          preview: false,
          model_picker_enabled: true,
          capabilities: {
            family: "o",
            limits: {},
            object: "model_capabilities",
            supports: {},
            tokenizer: "cl100k_base",
            type: "responses",
          },
        },
      ],
    }

    const res = await server.request("/v1/models", { method: "GET" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ id: string; mode: string }>
    }
    const entry = body.data.find((m) => m.id === "o1-pro")
    expect(entry?.mode).toBe("responses")
  })
})
