import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { TelemetryVar } from "~/middleware/telemetry"

import { awaitApproval } from "~/lib/approval"
import { getConfig } from "~/lib/config-store"
import { readCopilotUsage } from "~/lib/copilot-usage"
import { applyDefaultModelRewrite, isAppliedError } from "~/lib/default-model"
import { forwardError } from "~/lib/error"
import { getModelMode } from "~/lib/model-routing"
import { checkRateLimit } from "~/lib/rate-limit"
import { withKeepalive } from "~/lib/sse-keepalive"
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
    return handleNative(c, payload, clientAlias)
  }

  // Route Responses-only models (codex, o-pro variants) via the Responses API.
  if (getModelMode(payload.model) === "responses") {
    return handleAnthropicViaResponses(c, payload, clientAlias)
  }

  return handleTranslated(c, payload, clientAlias)
}

// ---------------------------------------------------------------------------
// Native Anthropic pass-through (Claude 4.5+ models)
// ---------------------------------------------------------------------------

async function handleNative(
  c: Context<{ Variables: TelemetryVar }>,
  payload: AnthropicMessagesPayload,
  clientAlias: string,
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
  // Per-alias default effort (Step 2 of D-014 follow-up): when config has
  // `models[clientAlias].default_effort` set AND the client didn't ask for
  // thinking, inject adaptive + effort. See `buildUpstreamPayload`.
  const defaultEffort = getConfig().models[clientAlias]?.default_effort
  // Tell telemetry the effective thinking level so the Logs row reflects
  // what actually went upstream — the body-snapshot would otherwise be
  // null when the client supplied no thinking field but default_effort
  // kicked in.
  if (payload.thinking) {
    // Client supplied thinking; leave telemetry to pick it up from the
    // body snapshot (it captures budget_tokens / type the same way).
  } else if (defaultEffort && defaultEffort !== "") {
    c.set("thinking_level", defaultEffort)
  }
  const response = await createMessagesNative(
    payload,
    onUpstream,
    clientBeta,
    defaultEffort,
  )

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
  return streamSSE(
    c,
    async (stream) => {
      // Anthropic streaming telemetry state — input_tokens from message_start,
      // latest output_tokens from message_delta. We update c.var.usage on every
      // event so the middleware's finally sees the freshest values.
      let inputTokens: number | undefined
      let outputTokens: number | undefined

      try {
        await withKeepalive(stream, async (touch) => {
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
            touch()

            // Skip the OpenAI-style `[DONE]` sentinel that Copilot's
            // Anthropic endpoint mirrors for compatibility — it's not JSON,
            // attempting to parse it just emits noise. The real terminator
            // is `message_stop`, which we already handled above.
            if (rawEvent.data === "[DONE]") continue

            try {
              const parsed = JSON.parse(
                rawEvent.data,
              ) as AnthropicStreamEventData
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
      } catch (err) {
        // Upstream stream died (TCP reset, 5xx after some events, parse
        // failure inside events() helper). Anthropic clients expect an
        // `error` event followed by `message_stop` — never a silent close —
        // otherwise Claude Code stalls until its keep-alive timeout. Don't
        // leak err.stack to the wire; the cause goes to consola.
        consola.error("Native Anthropic SSE iteration failed:", err)
        try {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              type: "error",
              error: {
                type: "api_error",
                message: "Upstream stream interrupted",
              },
            }),
          })
          await stream.writeSSE({
            event: "message_stop",
            data: JSON.stringify({ type: "message_stop" }),
          })
        } catch {
          // Client connection is already gone — nothing more to do.
        }
      }
    },
    async (err, stream) => {
      // Outer onError: writeSSE itself failed (downstream disconnect). Log
      // detail to consola, return a fixed message to the client.
      consola.error("Native Anthropic SSE outer error:", err)
      try {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            type: "error",
            error: { type: "api_error", message: "Stream write failed" },
          }),
        })
      } catch {
        // Connection already gone.
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Responses API path (Responses-only models via /responses)
// ---------------------------------------------------------------------------

async function handleAnthropicViaResponses(
  c: Context<{ Variables: TelemetryVar }>,
  payload: AnthropicMessagesPayload,
  clientAlias: string,
): Promise<Response> {
  consola.debug("Routing /v1/messages via Responses API for", payload.model)
  const defaultEffort = getConfig().models[clientAlias]?.default_effort
  if (!payload.thinking && defaultEffort && defaultEffort !== "") {
    c.set("thinking_level", defaultEffort)
  }

  if (payload.stream) {
    return streamResponsesAsAnthropic(c, payload, defaultEffort)
  }

  const responsesPayload = translateAnthropicToResponses(payload, defaultEffort)
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

  // Surface upstream terminal failures as errors instead of 200 OK.
  // Anthropic clients (Claude Code in particular) hard-require a non-null
  // `stop_reason` on the response — any status that isn't "completed" or
  // "incomplete" cannot satisfy that. We treat the rest as upstream errors
  // and surface 502 with the upstream's own message when available. Statuses
  // we've seen in the wild that fall through:
  //   - "failed"     — model errored, error.message describes why
  //   - "cancelled"  — request aborted upstream (timeout / control plane)
  //   - "in_progress" — upstream returned a "still working" snapshot,
  //                     never legal for a non-stream call
  if (
    typedResponse.status !== "completed"
    && typedResponse.status !== "incomplete"
  ) {
    const errMsg =
      (typedResponse as unknown as { error?: { message?: string } }).error
        ?.message ?? `Upstream returned status="${typedResponse.status}"`
    consola.error(
      `Responses API non-terminal status (status=${typedResponse.status}):`,
      errMsg,
    )
    // 502 for transport-level non-terminal; 500 only when it's an explicit
    // model failure (matches how the rest of the stack surfaces upstream
    // errors).
    const httpStatus = typedResponse.status === "failed" ? 500 : 502
    return c.json(
      { error: { message: errMsg, type: "api_error", code: "model_error" } },
      httpStatus,
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
  clientAlias: string,
): Promise<Response> {
  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  // Per-alias default effort: inject reasoning_effort onto the translated
  // chat-completions payload when the client sent no thinking signal and
  // the alias config provides a default. Chat-completions only accepts
  // low/medium/high — collapse "xhigh" and "max" down to "high".
  // (Mirrors the same logic in routes/chat-completions/handler.ts so a
  // request that comes in via /v1/messages on a non-Claude alias still
  // honours the configured default.)
  const aliasDefault = getConfig().models[clientAlias]?.default_effort
  let finalPayload = openAIPayload
  if (!openAIPayload.reasoning_effort && aliasDefault && aliasDefault !== "") {
    const e =
      aliasDefault === "xhigh" || aliasDefault === "max" ? "high" : aliasDefault
    consola.debug(
      `[alias-effort] injecting reasoning_effort=${e} (alias=${clientAlias}, translated path)`,
    )
    finalPayload = { ...openAIPayload, reasoning_effort: e }
    c.set("thinking_level", `effort:${e}`)
  } else if (openAIPayload.reasoning_effort) {
    c.set("thinking_level", `effort:${openAIPayload.reasoning_effort}`)
  }

  const onUpstream = (c.var as { trace_capture_upstream?: UpstreamCaptureFn })
    .trace_capture_upstream
  const response = await createChatCompletions(finalPayload, onUpstream)

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
  return streamSSE(
    c,
    async (stream) => {
      const streamState: AnthropicStreamState = {
        messageStartSent: false,
        contentBlockIndex: 0,
        contentBlockOpen: false,
        toolCalls: {},
      }

      try {
        await withKeepalive(stream, async (touch) => {
          for await (const rawEvent of response) {
            consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
            if (rawEvent.data === "[DONE]") {
              break
            }

            if (!rawEvent.data) {
              continue
            }

            // Defensive JSON.parse: Copilot occasionally emits half-buffered or
            // non-JSON chunks (HTML 5xx body during incidents). Throwing would
            // break the whole stream + leave the client hanging, so we log and
            // skip this chunk only.
            let chunk: ChatCompletionChunk
            try {
              chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
            } catch (parseErr) {
              consola.warn(
                `[/v1/messages stream] dropped unparseable chunk (${String(parseErr)}):`,
                rawEvent.data.slice(0, 200),
              )
              continue
            }

            // Telemetry: read copilot_usage off the OpenAI chunk before we
            // translate it into Anthropic events (which drops the field). The
            // helper handles both copilot_usage and native usage shapes.
            const u = readCopilotUsage(chunk)
            if (
              u.prompt_tokens !== undefined
              || u.completion_tokens !== undefined
            ) {
              c.set("usage", u)
            }
            const events = translateChunkToAnthropicEvents(chunk, streamState)

            for (const event of events) {
              consola.debug(
                "Translated Anthropic event:",
                JSON.stringify(event),
              )
              await stream.writeSSE({
                event: event.type,
                data: JSON.stringify(event),
              })
              touch()
            }
          }
        })
      } catch (err) {
        // Upstream iterator threw (TCP reset, events() helper error, etc.).
        // Anthropic clients hang on silent closes — emit error + message_stop
        // and close any open content block first so the protocol stays valid.
        consola.error("Translated /v1/messages SSE iteration failed:", err)
        try {
          if (streamState.contentBlockOpen) {
            await stream.writeSSE({
              event: "content_block_stop",
              data: JSON.stringify({
                type: "content_block_stop",
                index: streamState.contentBlockIndex,
              }),
            })
          }
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              type: "error",
              error: {
                type: "api_error",
                message: "Upstream stream interrupted",
              },
            }),
          })
          await stream.writeSSE({
            event: "message_stop",
            data: JSON.stringify({ type: "message_stop" }),
          })
        } catch {
          // Client already disconnected.
        }
      }
    },
    async (err, stream) => {
      consola.error("Translated /v1/messages SSE outer error:", err)
      try {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            type: "error",
            error: { type: "api_error", message: "Stream write failed" },
          }),
        })
      } catch {
        // Connection already gone.
      }
    },
  )
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
  defaultEffort?: string,
): Response | Promise<Response> {
  const responsesPayload = translateAnthropicToResponses(payload, defaultEffort)
  const onUpstreamStream = (
    c.var as { trace_capture_upstream?: UpstreamCaptureFn }
  ).trace_capture_upstream

  // Kick off the upstream call BEFORE we open the SSE response. If
  // createResponses throws (auth failure, upstream 4xx/5xx, network down),
  // we still hold a raw Response and can return a proper 4xx/5xx via
  // forwardError — once streamSSE opens the response we've already flushed
  // `200 OK + content-type: text/event-stream` and can only smuggle the
  // error inside the SSE body, which most clients don't parse as a
  // request-level failure. This mirrors the synchronous-first pattern
  // used in handleAnthropicViaResponses non-stream branch.
  const upstreamPromise = createResponses(
    { ...responsesPayload, stream: true },
    onUpstreamStream,
  ).catch((err: unknown) => err)

  return (async (): Promise<Response> => {
    const settled = await upstreamPromise
    if (settled instanceof Error) {
      // createResponses failed before producing any iterable — surface as a
      // normal HTTP error rather than a fake 200 SSE.
      consola.error("Responses upstream call failed pre-stream:", settled)
      return forwardError(c, settled)
    }
    const rawResponse = settled

    return streamSSE(
      c,
      async (stream) => {
        const streamState = makeResponsesStreamState()
        let inputTokens: number | undefined
        let outputTokens: number | undefined

        try {
          await withKeepalive(stream, async (touch) => {
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
                consola.debug(
                  "Translated Responses→Anthropic event:",
                  event.type,
                )
                ;[inputTokens, outputTokens] = stashAnthropicUsage(c, event, [
                  inputTokens,
                  outputTokens,
                ])
                await stream.writeSSE({
                  event: event.type,
                  data: JSON.stringify(event),
                })
                touch()
              }
            }
          })
        } catch (err) {
          consola.error("Error during Responses API streaming:", err)
          try {
            // Close any open blocks before the terminal error so the
            // Anthropic protocol stays valid (clients reject a stream
            // ending with an orphan content_block_start).
            for (const blockIndex of streamState.outputIndexToBlockIndex.values()) {
              await stream.writeSSE({
                event: "content_block_stop",
                data: JSON.stringify({
                  type: "content_block_stop",
                  index: blockIndex,
                }),
              })
            }
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({
                type: "error",
                error: {
                  type: "api_error",
                  message: "Upstream stream interrupted",
                },
              }),
            })
            await stream.writeSSE({
              event: "message_stop",
              data: JSON.stringify({ type: "message_stop" }),
            })
          } catch {
            // Client already disconnected.
          }
        }
      },
      async (err, stream) => {
        consola.error("Responses→Anthropic SSE outer error:", err)
        try {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              type: "error",
              error: { type: "api_error", message: "Stream write failed" },
            }),
          })
        } catch {
          // Connection already gone.
        }
      },
    )
  })()
}
