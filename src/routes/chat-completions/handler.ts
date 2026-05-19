import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import type { TelemetryVar } from "~/middleware/telemetry"

import { resolveUpstream } from "~/lib/alias"
import { awaitApproval } from "~/lib/approval"
import { getConfig } from "~/lib/config-store"
import { readCopilotUsage } from "~/lib/copilot-usage"
import { applyDefaultModelRewrite, isAppliedError } from "~/lib/default-model"
import { getModelMode } from "~/lib/model-routing"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import { isModelAllowed } from "~/middleware/auth"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type UpstreamCaptureFn,
} from "~/services/copilot/create-chat-completions"

export async function handleCompletion(
  c: Context<{ Variables: TelemetryVar }>,
) {
  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Take a single config snapshot for the lifetime of this request.
  const { models } = getConfig()

  // D-013: rewrite unconfigured aliases to default_model_alias, stash
  // upstream_model + trace_meta. Returns a 400 Response when the alias is
  // unknown and no default is set.
  const resolved = applyDefaultModelRewrite(
    c,
    payload.model,
    "/v1/chat/completions",
  )
  if (isAppliedError(resolved)) return resolved
  const { clientRequestedModel, clientAlias, upstreamModel } = resolved
  payload = { ...payload, model: upstreamModel }

  // Scope check: verify the EFFECTIVE alias is in the key's allowed_models.
  // We use clientAlias (post-fallback) so scope can't be bypassed by sending
  // an unknown name; we also prefer rejecting against the alias the user
  // actually sees in the API response.
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

  if (getModelMode(payload.model) === "responses") {
    return c.json(
      {
        error: {
          message: `Model "${payload.model}" is only available via the Responses API. Use POST /v1/responses instead.`,
          type: "invalid_request_error",
          code: "responses_only_model",
        },
      },
      400,
    )
  }

  await checkRateLimit(state)

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info("Current token count:", tokenCount)
    } else {
      consola.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  // Pull the trace upstream-capture sink off the context if debug is active
  // (set by src/middleware/trace.ts). undefined when no debug → no overhead.
  const onUpstream = (c.var as { trace_capture_upstream?: UpstreamCaptureFn })
    .trace_capture_upstream

  // Per-alias default effort: inject when client didn't supply reasoning_effort.
  // OpenAI chat-completions only accepts low/medium/high — collapse "xhigh"
  // down to "high" for this endpoint.
  const aliasDefault = models[clientAlias]?.default_effort
  if (!payload.reasoning_effort && aliasDefault && aliasDefault !== "") {
    const e = aliasDefault === "xhigh" ? "high" : aliasDefault
    consola.debug(
      `[alias-effort] injecting reasoning_effort=${e} (alias=${clientAlias})`,
    )
    payload = { ...payload, reasoning_effort: e }
  }

  const response = await createChatCompletions(payload, onUpstream)

  if (isNonStreaming(response)) {
    consola.debug("Non-streaming response:", JSON.stringify(response))
    // Telemetry: prefer copilot_usage.token_details over the native OpenAI
    // usage shape so events table reflects Copilot's own token counts.
    c.set("usage", readCopilotUsage(response))
    // Egress: return the original client alias rather than the upstream name.
    // Use clientAlias directly (exact round-trip) if an alias was configured;
    // fall back to resolveUpstream for un-aliased models.
    const egressModel =
      clientAlias !== payload.model ?
        clientAlias
      : resolveUpstream(response.model, models)
    return c.json({ ...response, model: egressModel })
  }

  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      consola.debug("Streaming chunk:", JSON.stringify(chunk))

      // Telemetry (issue #34): inspect every chunk for a top-level `usage`
      // field. When `stream_options.include_usage = true` is honored, the
      // terminal chunk carries it; older models may never emit it (in which
      // case the middleware records usage_unknown=1).
      maybeStashUsageFromChunk(c, chunk as SSEMessage)

      // Egress SSE rewrite: parse event data and rewrite the model field.
      // Only rewrite on structured JSON chunks — skip [DONE] sentinel and
      // any non-JSON data verbatim to avoid corrupting tool-call arguments.
      const rewritten = rewriteChunkModel(chunk as SSEMessage, {
        clientAlias,
        upstreamModel: payload.model,
        models,
      })
      await stream.writeSSE(rewritten)
    }
  })
}

/**
 * Look for a top-level `usage: { prompt_tokens, completion_tokens }` on a
 * streamed SSE chunk and stash it on the context for the telemetry
 * middleware. Silently ignores chunks that are non-JSON or have no usage.
 */
function maybeStashUsageFromChunk(
  c: Context<{ Variables: TelemetryVar }>,
  chunk: SSEMessage,
): void {
  const data = chunk.data
  if (!data || data === "[DONE]") return
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return
  }
  if (typeof parsed !== "object" || parsed === null) return
  // Prefer copilot_usage on the chunk (Copilot stamps it on the terminal
  // chat-completion chunk), fall back to the native OpenAI usage block.
  const u = readCopilotUsage(parsed)
  if (
    u.prompt_tokens !== undefined
    || u.completion_tokens !== undefined
    || u.cache_read_tokens !== undefined
    || u.cache_creation_tokens !== undefined
  ) {
    c.set("usage", u)
  }
}

type ModelMap = ReturnType<typeof getConfig>["models"]

interface RewriteCtx {
  clientAlias: string
  upstreamModel: string
  models: ModelMap
}

/**
 * Rewrite the `model` field in a single SSE chunk's `data` payload.
 * Returns the chunk unchanged if `data` is not parseable JSON or has no
 * top-level `model` field.  Never touches nested JSON (tool-call arguments).
 */
function rewriteChunkModel(chunk: SSEMessage, ctx: RewriteCtx): SSEMessage {
  const data = chunk.data
  if (!data || data === "[DONE]") return chunk

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return chunk
  }

  if (
    typeof parsed !== "object"
    || parsed === null
    || !Object.hasOwn(parsed, "model")
  ) {
    return chunk
  }

  const { clientAlias, upstreamModel, models } = ctx
  const egressModel =
    clientAlias !== upstreamModel ? clientAlias : (
      resolveUpstream((parsed as { model: string }).model, models)
    )

  return {
    ...chunk,
    data: JSON.stringify({ ...parsed, model: egressModel }),
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
