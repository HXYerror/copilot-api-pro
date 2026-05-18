import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

/**
 * Optional callback for capturing the proxy→Copilot leg of a request.
 * Set by the trace middleware on c.var when debug capture is active.
 * Undefined → no capture, zero overhead.
 */
export type UpstreamCaptureFn = (capture: {
  req: {
    method: string
    url: string
    headers: Record<string, string> | Headers
    body: unknown
  }
  res?: {
    status: number
    headers: Record<string, string> | Headers
    body: unknown
  }
}) => void

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  onUpstream?: UpstreamCaptureFn,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  // Issue #34 (F3.A): for streaming requests, ask upstream to emit a final
  // chunk with usage stats so the telemetry middleware can record real token
  // counts.  Preserve caller intent — if the client already supplied
  // stream_options, don't overwrite their choice.
  // Older Copilot models may ignore this flag; in that case the stream
  // simply contains no usage chunk and we record usage_unknown=1.
  // https://github.com/ericc-ch/copilot-api/issues/34
  const upstreamPayload: ChatCompletionsPayload =
    payload.stream === true && payload.stream_options === undefined ?
      { ...payload, stream_options: { include_usage: true } }
    : payload

  const url = `${copilotBaseUrl(state)}/chat/completions`
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamPayload),
  })

  // Trace upstream-leg capture (task #25). For non-streaming responses
  // (success OR error) we .clone() and read the body without consuming
  // the original — error bodies are small and crucial for debugging.
  // For streaming responses we capture headers+status only; the body is
  // an SSE stream that gets consumed by events() below, and the
  // proxy→client SSE leg is already captured by the trace middleware
  // wrapper on c.res.
  if (onUpstream) {
    try {
      const responseBody =
        payload.stream ? undefined : await response.clone().text()
      onUpstream({
        req: { method: "POST", url, headers, body: upstreamPayload },
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
    consola.error("Failed to create chat completions", response)
    throw new HTTPError("Failed to create chat completions", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  reasoning_content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  reasoning_content?: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null
  /**
   * OpenAI-compatible streaming options.  Setting `include_usage = true` asks
   * upstream to emit a final SSE chunk with a top-level `usage` field so the
   * telemetry middleware can record token counts (issue #34).
   */
  stream_options?: { include_usage?: boolean } | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
  reasoning_effort?: "low" | "medium" | "high" | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
