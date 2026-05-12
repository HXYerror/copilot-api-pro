import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import type { KeyVar } from "~/middleware/auth"

import { resolveAlias, resolveUpstream } from "~/lib/alias"
import { awaitApproval } from "~/lib/approval"
import { getConfig } from "~/lib/config-store"
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
} from "~/services/copilot/create-chat-completions"

export async function handleCompletion(c: Context<{ Variables: KeyVar }>) {
  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Take a single config snapshot for the lifetime of this request.
  // Using one snapshot ensures ingress + egress rewrites are consistent even
  // if the config hot-reloads between the two calls.
  const { models } = getConfig()

  // Ingress: rewrite client-facing alias → upstream model name.
  // Preserve the original alias so egress can return it verbatim (avoids the
  // O(n) reverse-scan and multi-alias ambiguity problems).
  const clientAlias = payload.model
  payload = { ...payload, model: resolveAlias(payload.model, models) }

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

  const response = await createChatCompletions(payload)

  if (isNonStreaming(response)) {
    consola.debug("Non-streaming response:", JSON.stringify(response))
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
