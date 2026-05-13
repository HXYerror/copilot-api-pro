import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { TelemetryVar } from "~/middleware/telemetry"

import { resolveAlias } from "~/lib/alias"
import { awaitApproval } from "~/lib/approval"
import { getConfig } from "~/lib/config-store"
import { getModelMode } from "~/lib/model-routing"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { isModelAllowed } from "~/middleware/auth"
import { sanitiseResponsesOutput } from "~/routes/responses/translation"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createMessagesNative } from "~/services/copilot/create-messages-native"
import { createResponses } from "~/services/copilot/create-responses"
import { isNativeAnthropicModel } from "~/services/copilot/native-models"

import { translateAnthropicToResponses } from "./anthropic-to-responses"
import {
  type AnthropicMessagesPayload,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  makeResponsesStreamState,
  translateResponsesEventToAnthropic,
} from "./responses-stream-translation"
import { translateResponsesToAnthropic } from "./responses-to-anthropic"
import {
  stashAnthropicUsage,
  translateChunkToAnthropicEvents,
} from "./stream-translation"

export async function handleCompletion(
  c: Context<{ Variables: TelemetryVar }>,
) {
  await checkRateLimit(state)

  // Single config snapshot for this request (consistent ingress + future egress).
  const { models } = getConfig()

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // Ingress: rewrite client-facing alias → upstream model name
  const clientAlias = anthropicPayload.model
  const payload: AnthropicMessagesPayload = {
    ...anthropicPayload,
    model: resolveAlias(anthropicPayload.model, models),
  }

  // Telemetry (issue #34): expose the post-alias upstream model.
  c.set("upstream_model", payload.model)

  // Scope check: verify the user-facing alias is in the key's allowed_models.
  // Uses clientAlias (before upstream resolution) per the comment in models/route.ts:28.
  const key = c.get("key")
  if (!isModelAllowed(key.allowed_models, clientAlias)) {
    return c.json(
      {
        error: {
          message: `Model "${clientAlias}" is not in your key's allowed models`,
          type: "permission_denied",
          code: "model_not_allowed",
        },
      },
      403,
    )
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Route to native Anthropic pass-through for Claude models to preserve
  // thinking blocks (with signature), top_k, cache_control, and richer usage.
  if (isNativeAnthropicModel(payload.model)) {
    return handleNative(c, payload)
  }

  // Route Responses-only models (codex, o-pro variants) via the Responses API.
  if (getModelMode(payload.model) === "responses") {
    return handleAnthropicViaResponses(c, payload)
  }

  return handleTranslated(c, payload)
}

// ---------------------------------------------------------------------------
// Native Anthropic pass-through (Claude 4.5+ models)
// ---------------------------------------------------------------------------

async function handleNative(
  c: Context<{ Variables: TelemetryVar }>,
  payload: AnthropicMessagesPayload,
): Promise<Response> {
  consola.debug("Using native Anthropic pass-through for", payload.model)

  const response = await createMessagesNative(payload)

  if (!payload.stream) {
    // Non-streaming: upstream already returned a complete Anthropic response
    consola.debug(
      "Native non-streaming response:",
      JSON.stringify(response).slice(0, 400),
    )
    // Telemetry (issue #34): native Anthropic returns Anthropic-shaped usage
    const usage = (
      response as { usage?: { input_tokens?: number; output_tokens?: number } }
    ).usage
    if (usage) {
      c.set("usage", {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
      })
    }
    return c.json(response)
  }

  // Streaming: proxy the SSE events directly to the client
  consola.debug("Native streaming response — proxying SSE events")
  return streamSSE(c, async (stream) => {
    // Anthropic streaming telemetry state — input_tokens from message_start,
    // latest output_tokens from message_delta. We update c.var.usage on every
    // event so the middleware's finally sees the freshest values.
    let inputTokens: number | undefined
    let outputTokens: number | undefined

    for await (const rawEvent of response as AsyncIterable<{
      data?: string
      event?: string
    }>) {
      if (!rawEvent.data) continue

      // Forward verbatim — never block on parse failure
      await stream.writeSSE({
        event: rawEvent.event,
        data: rawEvent.data,
      })

      try {
        const parsed = JSON.parse(rawEvent.data) as AnthropicStreamEventData
        consola.debug("Native SSE event:", parsed.type)
        ;[inputTokens, outputTokens] = stashAnthropicUsage(c, parsed, [
          inputTokens,
          outputTokens,
        ])
      } catch {
        consola.warn(
          "Could not parse native SSE chunk for logging:",
          rawEvent.data.slice(0, 200),
        )
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Responses API path (Responses-only models via /responses)
// ---------------------------------------------------------------------------

async function handleAnthropicViaResponses(
  c: Context<{ Variables: TelemetryVar }>,
  payload: AnthropicMessagesPayload,
): Promise<Response> {
  consola.debug("Routing /v1/messages via Responses API for", payload.model)

  if (payload.stream) {
    return streamResponsesAsAnthropic(c, payload)
  }

  const responsesPayload = translateAnthropicToResponses(payload)
  const rawResponse = await createResponses({
    ...responsesPayload,
    stream: false,
  })

  // Runtime guard: createResponses returns ResponsesResponse for stream:false,
  // but TypeScript types the return as a union — narrow explicitly.
  if (!("output" in rawResponse)) {
    consola.error(
      "Unexpected non-response shape from createResponses:",
      rawResponse,
    )
    return c.json(
      {
        error: {
          message: "Upstream returned unexpected response shape",
          type: "api_error",
          code: "invalid_upstream_response",
        },
      },
      502,
    )
  }

  const typedResponse = rawResponse

  // Surface upstream terminal failures as errors instead of 200 OK
  if (typedResponse.status === "failed") {
    const errMsg =
      (typedResponse as unknown as { error?: { message?: string } }).error
        ?.message ?? "Upstream model call failed"
    consola.error("Responses API returned failed status:", errMsg)
    return c.json(
      { error: { message: errMsg, type: "api_error", code: "model_error" } },
      500,
    )
  }

  const sanitised = sanitiseResponsesOutput(typedResponse)
  const anthropicResponse = translateResponsesToAnthropic(sanitised)
  // Telemetry (issue #34): Anthropic-shaped usage on non-streaming path.
  c.set("usage", {
    prompt_tokens: anthropicResponse.usage.input_tokens,
    completion_tokens: anthropicResponse.usage.output_tokens,
  })

  consola.debug(
    "Responses→Anthropic translated response:",
    JSON.stringify(anthropicResponse).slice(0, 400),
  )
  return c.json(anthropicResponse)
}

// ---------------------------------------------------------------------------
// Translation path (non-Claude models via /chat/completions)
// ---------------------------------------------------------------------------

async function handleTranslated(
  c: Context<{ Variables: TelemetryVar }>,
  anthropicPayload: AnthropicMessagesPayload,
): Promise<Response> {
  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    // Telemetry (issue #34): stash usage from the OpenAI-shaped response.
    if (response.usage) {
      c.set("usage", {
        prompt_tokens: response.usage.prompt_tokens,
        completion_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens,
      })
    }
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      // Telemetry (issue #34): grab usage off the OpenAI chunk before we
      // translate it into Anthropic events (which drops the field).
      if (chunk.usage) {
        c.set("usage", {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
          total_tokens: chunk.usage.total_tokens,
        })
      }
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

// ---------------------------------------------------------------------------
// Helper: stream Responses → translated Anthropic SSE
// Extracted from handleAnthropicViaResponses to keep that function under the
// max-lines-per-function lint limit.
// ---------------------------------------------------------------------------

function streamResponsesAsAnthropic(
  c: Context<{ Variables: TelemetryVar }>,
  payload: AnthropicMessagesPayload,
): Response {
  const responsesPayload = translateAnthropicToResponses(payload)
  return streamSSE(c, async (stream) => {
    const rawResponse = await createResponses({
      ...responsesPayload,
      stream: true,
    })
    const streamState = makeResponsesStreamState()
    let inputTokens: number | undefined
    let outputTokens: number | undefined

    try {
      for await (const rawEvent of rawResponse as AsyncIterable<{
        data?: string
        event?: string
      }>) {
        const eventType = rawEvent.event ?? ""

        let parsedData: unknown = undefined
        if (rawEvent.data) {
          try {
            parsedData = JSON.parse(rawEvent.data)
          } catch {
            consola.warn(
              "Could not parse Responses SSE chunk:",
              rawEvent.data.slice(0, 200),
            )
          }
        }

        consola.debug("Responses SSE event:", eventType)

        const anthropicEvents = translateResponsesEventToAnthropic(
          eventType,
          parsedData,
          streamState,
        )

        for (const event of anthropicEvents) {
          consola.debug("Translated Responses→Anthropic event:", event.type)
          ;[inputTokens, outputTokens] = stashAnthropicUsage(c, event, [
            inputTokens,
            outputTokens,
          ])
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
      }
    } catch (err) {
      consola.error("Error during Responses API streaming:", err)
      const errorEvent: AnthropicStreamEventData = {
        type: "error",
        error: {
          type: "api_error",
          message: "An unexpected error occurred during streaming.",
        },
      }
      await stream.writeSSE({
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
    }
  })
}
