/**
 * Native Anthropic pass-through service.
 *
 * The GitHub Copilot upstream (`api.enterprise.githubcopilot.com`) natively
 * speaks the Anthropic Messages API for all Claude 4.5+ models.  Routing
 * requests directly to `/v1/messages` instead of translating them through
 * `/chat/completions` gives us:
 *
 *  - Real thinking blocks with `signature` field (multi-turn reasoning)
 *  - `cache_creation_input_tokens` in usage
 *  - `top_k` support
 *  - No lossy translation round-trip
 *
 * See research notes: ~/copilot-models-litellm/copilot_models.py
 */

import consola from "consola"
import { events } from "fetch-event-stream"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import type { UpstreamCaptureFn } from "./create-chat-completions"

/**
 * Forward an Anthropic-format request directly to Copilot's native `/v1/messages`
 * endpoint, preserving all fields (thinking, signature, top_k, cache_control, …).
 *
 * Returns:
 *  - For non-streaming: the raw Anthropic JSON response object
 *  - For streaming: an async iterable of SSE events (fetch-event-stream)
 */
export const createMessagesNative = async (
  payload: AnthropicMessagesPayload,
  onUpstream?: UpstreamCaptureFn,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const hasVision = messageHasImages(payload)
  const headers = buildNativeHeaders(hasVision, Boolean(payload.stream))
  // X-Initiator parity with /chat/completions and /responses: tells upstream
  // whether this turn is operator-initiated ("user") or part of an
  // automated/agent loop. Detected from the message history.
  headers["X-Initiator"] = isAgentMessagesCall(payload) ? "agent" : "user"

  const upstream = `${copilotBaseUrl(state)}/v1/messages`
  consola.debug("Native Anthropic upstream:", upstream)

  // Strip fields that are Copilot-API–specific or unsupported by upstream
  const body = buildUpstreamPayload(payload)

  const response = await fetch(upstream, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  // Trace upstream-leg capture (task #25). Error bodies are captured too —
  // they're small and tell us why upstream rejected the request.
  if (onUpstream) {
    try {
      const responseBody =
        payload.stream ? undefined : await response.clone().text()
      onUpstream({
        req: { method: "POST", url: upstream, headers, body },
        res: {
          status: response.status,
          headers: response.headers,
          body: responseBody,
        },
      })
    } catch (err) {
      consola.warn(`[trace] upstream capture failed: ${String(err)}`)
    }
  }

  if (!response.ok) {
    consola.error("Native Anthropic upstream error", response.status)
    throw new HTTPError("Native Anthropic upstream error", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return response.json()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build headers for the Anthropic native endpoint.
 *
 * The upstream requires `anthropic-version` and does NOT want an `openai-intent`
 * header.  We reuse `copilotHeaders()` for auth/agent headers and then layer the
 * Anthropic-specific ones on top.
 */
function buildNativeHeaders(
  vision: boolean,
  stream: boolean,
): Record<string, string> {
  const base = copilotHeaders(state, vision)

  // Remove headers that are OpenAI-specific and not expected by Anthropic endpoint
  const { "openai-intent": _dropped, ...anthropicBase } = base

  return {
    ...anthropicBase,
    "anthropic-version": "2023-06-01",
    // Enable beta features: extended thinking + prompt caching
    "anthropic-beta":
      "interleaved-thinking-2025-05-14,prompt-caching-2024-07-31",
    // Only request SSE streaming format when the caller is streaming
    ...(stream ? { accept: "text/event-stream" } : {}),
  }
}

/**
 * Produce the payload forwarded to upstream.
 *
 * We pass through almost everything verbatim.  The only transformation is that
 * `claude-opus-4.7+` requires the new adaptive thinking format
 * (`thinking: { type: "adaptive" }` + `output_config.effort`) rather than the
 * legacy `{ type: "enabled", budget_tokens: N }`.  If the caller already sent
 * the correct format we leave it alone; if they sent the old format and the
 * model requires adaptive, we upgrade automatically.
 */
export function buildUpstreamPayload(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  const { thinking, output_config, ...rest } = payload

  if (!thinking) {
    return rest // safe: output_config only valid alongside thinking
  }

  if (isAdaptiveThinkingModel(payload.model)) {
    // Upgrade legacy enabled → adaptive if needed
    if (thinking.type === "enabled") {
      consola.debug(
        `Upgrading thinking format to adaptive for model ${payload.model}`,
      )
      return {
        ...rest,
        thinking: { type: "adaptive" },
        output_config:
          output_config?.effort ? output_config : { effort: "medium" },
      }
    }
    // Already adaptive — forward as-is
    return { ...rest, thinking, output_config }
  }

  // Non-adaptive model — forward legacy format, drop output_config
  return { ...rest, thinking }
}

/**
 * Returns true for models that require the adaptive thinking API
 * (`{ type: "adaptive" }` + `output_config.effort`) rather than the
 * legacy `{ type: "enabled", budget_tokens: N }`.
 * Currently: claude-opus-4.7 and later.
 */
function isAdaptiveThinkingModel(model: string): boolean {
  // claude-opus-4.7 and above use adaptive thinking
  const match = model.match(/^claude-opus-4[.-](\d+)/)
  if (match) {
    const minor = Number.parseInt(match[1], 10)
    // claude-opus-4.7 and later use the new adaptive thinking API (not legacy budget_tokens)
    return minor >= 7
  }
  return false
}

/**
 * Check whether the request contains any image blocks (to set vision headers).
 */
function messageHasImages(payload: AnthropicMessagesPayload): boolean {
  for (const msg of payload.messages) {
    if (typeof msg.content === "string") continue
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "image") return true
      }
    }
  }
  return false
}

/**
 * Heuristic for X-Initiator: returns true when the message history makes this
 * look like an automated agent loop rather than the first turn of a manual
 * conversation. Mirrors `isAgentCall` in create-responses.ts and the inline
 * detector in create-chat-completions.ts:
 *
 *  - any prior assistant message → multi-turn → "agent"
 *  - any tool_result block in user content → tool-driven → "agent"
 *  - any tool_use in assistant content → "agent"
 *  - otherwise → "user"
 */
function isAgentMessagesCall(payload: AnthropicMessagesPayload): boolean {
  for (const msg of payload.messages) {
    if (msg.role === "assistant") return true
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result" || block.type === "tool_use") {
          return true
        }
      }
    }
  }
  return false
}
