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
  clientAnthropicBeta?: string,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const hasVision = messageHasImages(payload)
  const headers = buildNativeHeaders(
    hasVision,
    Boolean(payload.stream),
    clientAnthropicBeta,
  )
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
 * Build the anthropic-beta header forwarded upstream.
 *
 * We MUST forward whatever beta flags the client sent — Claude Code sends
 * the full set including `effort-2025-11-24` (which gates
 * `output_config.effort`) and `redact-thinking-2026-02-12` (which gates
 * thinking-encryption behaviour). Hard-coding our own list silently drops
 * them and the model behaves as if those features were off (we observed
 * 0 thinking blocks even with effort:"xhigh" until this was fixed).
 *
 * We additionally union in two flags we always want on so direct-API
 * callers without the right beta header still get them:
 *   - interleaved-thinking-2025-05-14  (mixed thinking + text blocks)
 *   - prompt-caching-2024-07-31        (cache_control support)
 *
 * Output is comma-separated, de-duplicated.
 */
function mergeAnthropicBeta(clientBeta: string | undefined): string {
  const ours = ["interleaved-thinking-2025-05-14", "prompt-caching-2024-07-31"]
  const fromClient = (clientBeta ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return [...new Set([...fromClient, ...ours])].join(",")
}

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
  clientBeta?: string,
): Record<string, string> {
  const base = copilotHeaders(state, vision)

  // Remove headers that are OpenAI-specific and not expected by Anthropic endpoint
  const { "openai-intent": _dropped, ...anthropicBase } = base

  return {
    ...anthropicBase,
    "anthropic-version": "2023-06-01",
    // Forward client beta flags + our defaults. Crucial for Claude Code's
    // `effort-2025-11-24` flag which enables `output_config.effort`.
    "anthropic-beta": mergeAnthropicBeta(clientBeta),
    // Only request SSE streaming format when the caller is streaming
    ...(stream ? { accept: "text/event-stream" } : {}),
  }
}

/**
 * Map a legacy Anthropic `budget_tokens` value to a Copilot effort level
 * for adaptive thinking. The buckets mirror Claude Code's preset budgets
 * so a client that selects "Think hard" upstream lands on Copilot's "high"
 * (etc).
 *
 *   budget ≥ 50K → "xhigh"      (Ultrathink-equivalent)
 *   25K–50K      → "high"       (Think harder)
 *   5K–25K       → "medium"     (Think hard)
 *   < 5K         → "low"        (small explicit budget)
 *
 * When the caller didn't send a budget at all, default to "medium" — the
 * model's adaptive controller will still ramp up if the task warrants it.
 */
function budgetToEffort(
  budget: number | undefined,
): "low" | "medium" | "high" | "xhigh" {
  if (typeof budget !== "number" || budget <= 0) return "medium"
  if (budget >= 50_000) return "xhigh"
  if (budget >= 25_000) return "high"
  if (budget >= 5_000) return "medium"
  return "low"
}

/**
 * Produce the payload forwarded to upstream.
 *
 * We pass through almost everything verbatim.  The only transformation is that
 * `claude-opus-4.7+` requires the new adaptive thinking format
 * (`thinking: { type: "adaptive" }` + `output_config.effort`) rather than the
 * legacy `{ type: "enabled", budget_tokens: N }`.  If the caller already sent
 * the correct format we leave it alone; if they sent the old format and the
 * model requires adaptive, we upgrade automatically — and we **map the
 * budget size to a Copilot effort level** (low/medium/high/xhigh) so the
 * caller's intent isn't flattened to "medium" regardless of input.
 */
export function buildUpstreamPayload(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  const { thinking, output_config, ...rest } = payload

  if (!thinking) {
    return rest // safe: output_config only valid alongside thinking
  }

  if (isAdaptiveThinkingModel(payload.model)) {
    // Upgrade legacy enabled → adaptive if needed.  Map budget_tokens to a
    // Copilot effort level when the caller didn't already supply one.
    if (thinking.type === "enabled") {
      const effort = output_config?.effort ?? budgetToEffort(thinking.budget_tokens)
      consola.debug(
        `Upgrading thinking format to adaptive for model ${payload.model} (budget=${thinking.budget_tokens} → effort=${effort})`,
      )
      return {
        ...rest,
        thinking: { type: "adaptive" },
        output_config: { effort },
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
