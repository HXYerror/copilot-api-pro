import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const getModels = async () => {
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotHeaders(state),
  })

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  return (await response.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_non_streaming_output_tokens?: number
  max_inputs?: number
  vision?: {
    max_prompt_image_size?: number
    max_prompt_images?: number
    supported_media_types?: Array<string>
  }
  // Forward-compat: Copilot adds new limit dimensions over time.
  [extra: string]: unknown
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  streaming?: boolean
  vision?: boolean
  structured_outputs?: boolean
  dimensions?: boolean
  adaptive_thinking?: boolean
  max_thinking_budget?: number
  min_thinking_budget?: number
  reasoning_effort?: Array<string>
  // Forward-compat
  [extra: string]: unknown
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object?: string
  supports: ModelSupports
  tokenizer: string
  /** Known values: "chat" | "responses" | "embeddings" | "completion". Open string for forward-compat. */
  type: "chat" | "responses" | (string & {})
  // Forward-compat
  [extra: string]: unknown
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  /** "powerful" | "versatile" | ... — Copilot's UI categorisation. */
  model_picker_category?: string
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  /** Authoritative list of upstream endpoint paths this model accepts.
   * Values look like "/responses", "/chat/completions", "ws:/responses".
   * Used by lib/model-routing.ts to pick the right endpoint. */
  supported_endpoints?: Array<string>
  policy?: {
    state: string
    terms: string
  }
  // Forward-compat: Copilot adds new top-level model fields too.
  [extra: string]: unknown
}
