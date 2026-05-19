import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { TelemetryVar } from "~/middleware/telemetry"

import { awaitApproval } from "~/lib/approval"
import { readCopilotUsage } from "~/lib/copilot-usage"
import { applyDefaultModelRewrite, isAppliedError } from "~/lib/default-model"
import { getModelMode } from "~/lib/model-routing"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { isModelAllowed } from "~/middleware/auth"
import { sanitiseResponsesOutput } from "~/routes/responses/translation"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type UpstreamCaptureFn,
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

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // Strip Anthropic-only fields that Copilot upstream doesn't recognise.
  // Claude Code v2.x ships `context_management` / `context_mgmt` in the
  // request body to control its own context-window heuristics; upstream
  // Bedrock/Vertex routes reject the request with HTTP 400
  // "Extra inputs are not permitted". The fields have no analogue server-
  // side, so dropping them is the right behaviour.
  const stripped = anthropicPayload as AnthropicMessagesPayload & {
    context_management?: unknown
    context_mgmt?: unknown
  }
  delete stripped.context_management
  delete stripped.context_mgmt

  // D-013: rewrite unconfigured aliases to default_model_alias before any
  // scope check or upstream call.
  const resolved = applyDefaultModelRewrite(
    c,
    anthropicPayload.model,
    "/v1/messages",
  )
  if (isAppliedError(resolved)) return resolved
  const { clientRequestedModel, clientAlias, upstreamModel } = resolved

  // Ingress: payload uses upstream model id; egress translation maps back.
  const payload: AnthropicMessagesPayload = {
    ...anthropicPayload,
    model: upstreamModel,
  }

  // Scope check: verify the EFFECTIVE alias is in the key's allowed_models.
  const key = c.get("key")
  if (!isModelAllowed(key.allowed_models, clientAlias)) {
    return c.json(
      {
        error: {
          message: `Model "${clientRequestedModel}" is not in your key's allowed models`,
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

  const onUpstream = (c.var as { trace_capture_upstream?: UpstreamCaptureFn })
    .trace_capture_upstream
  // Forward the client's `anthropic-beta` header so feature flags like
  // `effort-2025-11-24` (gates `output_config.effort`) and
  // `redact-thinking-2026-02-12` (controls thinking encryption) actually
  // reach Copilot. Without this, Claude Code's effort:"xhigh" is silently
  // ignored and the model never thinks.
  const clientBeta = c.req.header("anthropic-beta")
  const response = await createMessagesNative(payload, onUpstream, clientBeta)

  if (!payload.stream) {
    // Non-streaming: upstream already returned a complete Anthropic response
    consola.debug(
      "Native non-streaming response:",
      JSON.stringify(response).slice(0, 400),
    )
    // Telemetry: read from copilot_usage.token_details when present so we
    // capture Copilot's own token counts (input / output / cache_read /
    // cache_write), falling back to native Anthropic usage when not.
    c.set("usage", readCopilotUsage(response))
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
  const onUpstreamRes = (
    c.var as { trace_capture_upstream?: UpstreamCaptureFn }
  ).trace_capture_upstream
  const rawResponse = await createResponses(
    {
      ...responsesPayload,
      stream: false,
    },
    onUpstreamRes,
  )

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
  // Telemetry: read from copilot_usage on the original upstream response so
  // we capture Copilot's own token counts (the translated anthropic shape
  // doesn't include copilot_usage).
  c.set("usage", readCopilotUsage(typedResponse))

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

  const onUpstream = (c.var as { trace_capture_upstream?: UpstreamCaptureFn })
    .trace_capture_upstream
  const response = await createChatCompletions(openAIPayload, onUpstream)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    // Telemetry (issue #34): stash usage from the OpenAI-shaped response.
    // Telemetry: prefer copilot_usage from the original chat-completion
    // response over the translated-to-Anthropic shape (the latter strips
    // copilot_usage during translation).
    c.set("usage", readCopilotUsage(response))
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
      // Telemetry: read copilot_usage off the OpenAI chunk before we
      // translate it into Anthropic events (which drops the field). The
      // helper handles both copilot_usage and native usage shapes.
      const u = readCopilotUsage(chunk)
      if (u.prompt_tokens !== undefined || u.completion_tokens !== undefined) {
        c.set("usage", u)
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
  const onUpstreamStream = (
    c.var as { trace_capture_upstream?: UpstreamCaptureFn }
  ).trace_capture_upstream
  return streamSSE(c, async (stream) => {
    const rawResponse = await createResponses(
      {
        ...responsesPayload,
        stream: true,
      },
      onUpstreamStream,
    )
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
