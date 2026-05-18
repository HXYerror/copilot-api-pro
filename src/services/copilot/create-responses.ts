import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { events } from "fetch-event-stream"

import type {
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesPayload,
  ResponsesResponse,
} from "~/routes/responses/types"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import type { UpstreamCaptureFn } from "./create-chat-completions"

// Re-export for ergonomics — handlers that only import from this module
// shouldn't need to dig into create-chat-completions.ts for the type.
export type { UpstreamCaptureFn } from "./create-chat-completions"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if any input item contains an `input_image` content part.
 * Handles both a top-level string input and an array of input items.
 */
export function inputHasImages(payload: ResponsesPayload): boolean {
  if (typeof payload.input === "string") return false

  return payload.input.some((item) => {
    if (item.type !== "message") return false
    if (typeof item.content === "string") return false
    return item.content.some(
      (part: ResponsesContentPart) => part.type === "input_image",
    )
  })
}

/**
 * Returns true if this looks like an agent/multi-turn call:
 * - any input item has role "assistant", OR
 * - any item has type "function_call_output", "function_call", or "reasoning"
 *   (reasoning items only appear when echoing back prior agentic turn context)
 */
export function isAgentCall(payload: ResponsesPayload): boolean {
  if (typeof payload.input === "string") return false

  return payload.input.some(
    (item: ResponsesInputItem) =>
      ("role" in item && item.role === "assistant")
      || item.type === "function_call_output"
      || item.type === "function_call"
      || item.type === "reasoning",
  )
}

// ---------------------------------------------------------------------------
// Service client
// ---------------------------------------------------------------------------

export const createResponses = async (
  payload: ResponsesPayload,
  onUpstream?: UpstreamCaptureFn,
): Promise<ResponsesResponse | AsyncIterable<ServerSentEventMessage>> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = inputHasImages(payload)

  const initiator = isAgentCall(payload) ? "agent" : "user"

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": initiator,
  }

  const url = `${copilotBaseUrl(state)}/responses`
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  // Trace upstream-leg capture (task #25). Error bodies are captured too —
  // they're small and tell us why upstream rejected the request.
  if (onUpstream) {
    try {
      const responseBody =
        payload.stream ? undefined : await response.clone().text()
      onUpstream({
        req: { method: "POST", url, headers, body: payload },
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
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResponse
}
