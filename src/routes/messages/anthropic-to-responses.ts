/**
 * Translates an Anthropic /v1/messages payload into a Responses API payload.
 *
 * Used when the requested model is a Responses-only model (e.g. codex, o-pro)
 * so the request can be dispatched via `createResponses` instead of
 * `createChatCompletions`.
 */

import consola from "consola"

import type {
  ResponsesContentPart,
  ResponsesFunctionCallOutput,
  ResponsesInputFunctionCall,
  ResponsesInputItem,
  ResponsesInputMessage,
  ResponsesPayload,
  ResponsesReasoningItem,
  ResponsesTool,
} from "~/routes/responses/types"

import type {
  AnthropicAssistantMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicUserMessage,
} from "./anthropic-types"

// ---------------------------------------------------------------------------
// Allowlisted image media types for data URI construction
// ---------------------------------------------------------------------------

const ALLOWED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

// ---------------------------------------------------------------------------
// Allowlisted reasoning effort values
// ---------------------------------------------------------------------------

const VALID_EFFORT_VALUES = new Set<string>(["low", "medium", "high"])

// ---------------------------------------------------------------------------
// Budget → effort tier mapping
// ---------------------------------------------------------------------------

/**
 * Map an extended-thinking `budget_tokens` value to a Responses API reasoning
 * effort string.  Responses API only has "low" | "medium" | "high", so we
 * collapse "minimal" into "low".
 */
function budgetToEffort(budgetTokens: number): "low" | "medium" | "high" {
  if (budgetTokens >= 10_000) return "high"
  if (budgetTokens >= 5_000) return "medium"
  // < 5000 → "low" (Responses API has no "minimal" tier)
  return "low"
}

// ---------------------------------------------------------------------------
// System prompt → instructions
// ---------------------------------------------------------------------------

function buildInstructions(
  system: AnthropicMessagesPayload["system"],
): string | undefined {
  if (!system) return undefined
  if (typeof system === "string") return system
  // Array of text blocks — join with double newlines
  return system.map((b) => b.text).join("\n\n")
}

// ---------------------------------------------------------------------------
// Image block → input_image content part
// ---------------------------------------------------------------------------

/**
 * Convert a base64 Anthropic image block to a Responses API `input_image`
 * content part.  Returns `undefined` if the source type is not base64 (URL
 * images are not supported on the Copilot upstream) or if the media type is
 * not in the allowed set (guard against data-URI injection).
 */
function translateImageBlock(block: {
  type: "image"
  source: { type: string; media_type?: string; data?: string }
}): ResponsesContentPart | undefined {
  if (block.source.type !== "base64") {
    // URL images: skip (not supported on Copilot upstream)
    return undefined
  }
  const { media_type, data } = block.source as {
    media_type: string
    data: string
  }
  // Allowlist media_type to prevent data-URI injection
  if (!ALLOWED_IMAGE_MEDIA_TYPES.has(media_type)) {
    consola.warn("Skipping image with unsupported media_type:", media_type)
    return undefined
  }
  return {
    type: "input_image",
    image_url: `data:${media_type};base64,${data}`,
  }
}

// ---------------------------------------------------------------------------
// Message translation helpers
// ---------------------------------------------------------------------------

function translateUserMessage(
  message: AnthropicUserMessage,
): Array<ResponsesInputItem> {
  const items: Array<ResponsesInputItem> = []

  if (typeof message.content === "string") {
    items.push({
      type: "message",
      role: "user",
      content: message.content,
    } satisfies ResponsesInputMessage)
    return items
  }

  // Array content: split tool_result blocks from the rest
  const toolResultBlocks = message.content.filter(
    (b): b is AnthropicToolResultBlock => b.type === "tool_result",
  )
  const otherBlocks = message.content.filter((b) => b.type !== "tool_result")

  // Each tool_result becomes a function_call_output item
  for (const block of toolResultBlocks) {
    const output =
      typeof block.content === "string" ?
        block.content
      : block.content
          .filter((b): b is AnthropicTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")

    items.push({
      type: "function_call_output",
      call_id: block.tool_use_id,
      output,
    } satisfies ResponsesFunctionCallOutput)
  }

  // Remaining blocks become a single user message with typed content parts
  if (otherBlocks.length > 0) {
    const contentParts: Array<ResponsesContentPart> = []

    for (const block of otherBlocks) {
      if (block.type === "text") {
        contentParts.push({ type: "input_text", text: block.text })
      } else {
        // image block
        const imagePart = translateImageBlock(block)
        if (imagePart) contentParts.push(imagePart)
      }
    }

    if (contentParts.length > 0) {
      items.push({
        type: "message",
        role: "user",
        content: contentParts,
      } satisfies ResponsesInputMessage)
    }
  }

  return items
}

function translateAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<ResponsesInputItem> {
  const items: Array<ResponsesInputItem> = []

  if (typeof message.content === "string") {
    items.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: message.content }],
    } satisfies ResponsesInputMessage)
    return items
  }

  // Process content blocks in order
  for (const block of message.content) {
    switch (block.type) {
      case "text": {
        const textBlock = block
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: textBlock.text }],
        } satisfies ResponsesInputMessage)
        break
      }
      case "thinking": {
        const thinkingBlock = block
        // Preserve signature as encrypted_content for multi-turn continuity.
        // NOTE: the original reasoning item `id` is not preserved here — the
        // Anthropic ThinkingBlock format has no id field.  If the upstream
        // validates stable IDs across turns this could break multi-turn
        // reasoning; at present Copilot upstream does not enforce this.
        // TODO: investigate id round-trip once multi-turn Responses is stable.
        const reasoningItem: ResponsesReasoningItem = {
          type: "reasoning",
          id: `reasoning_${crypto.randomUUID()}`,
          summary: [{ type: "summary_text", text: thinkingBlock.thinking }],
          ...(thinkingBlock.signature !== undefined && {
            encrypted_content: thinkingBlock.signature,
          }),
        }
        items.push(reasoningItem)
        break
      }
      case "tool_use": {
        const toolUseBlock = block
        items.push({
          type: "function_call",
          call_id: toolUseBlock.id,
          name: toolUseBlock.name,
          arguments: JSON.stringify(toolUseBlock.input),
        } satisfies ResponsesInputFunctionCall)
        break
      }
      default: {
        // Unknown block type — skip silently
        break
      }
    }
  }

  return items
}

// ---------------------------------------------------------------------------
// Tool translation
// ---------------------------------------------------------------------------

function translateTools(
  tools: AnthropicMessagesPayload["tools"],
): Array<ResponsesTool> | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }))
}

// ---------------------------------------------------------------------------
// Tool choice translation
// ---------------------------------------------------------------------------

function translateToolChoice(
  toolChoice: AnthropicMessagesPayload["tool_choice"],
): ResponsesPayload["tool_choice"] {
  if (!toolChoice) return undefined

  switch (toolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (toolChoice.name) {
        return { type: "function", name: toolChoice.name }
      }
      consola.warn(
        "tool_choice.type is 'tool' but no name was provided — falling back to 'auto'",
      )
      return "auto"
    }
    case "none": {
      return "none"
    }
    default: {
      return undefined
    }
  }
}

// ---------------------------------------------------------------------------
// Reasoning config translation
// ---------------------------------------------------------------------------

function translateReasoning(
  thinking: AnthropicMessagesPayload["thinking"],
  outputConfig?: AnthropicMessagesPayload["output_config"],
  defaultEffort?: string,
): ResponsesPayload["reasoning"] {
  // Per-alias default effort: when the client didn't ask for thinking at
  // all AND the alias provides a default, surface it as reasoning.effort.
  // Responses API only accepts low/medium/high, so we collapse "xhigh"
  // down to "high" (the highest valid value for this endpoint).
  if (!thinking) {
    if (defaultEffort && defaultEffort !== "") {
      // Responses API only accepts low/medium/high — collapse both
      // "xhigh" and "max" down to "high" (highest valid value).
      const e =
        defaultEffort === "xhigh" || defaultEffort === "max" ? "high"
        : VALID_EFFORT_VALUES.has(defaultEffort) ? defaultEffort
        : null
      if (e) return { effort: e as "low" | "medium" | "high" }
    }
    return undefined
  }

  if (thinking.type === "adaptive") {
    const rawEffort = outputConfig?.effort
    // Validate effort value against allowlist to prevent forwarding arbitrary strings
    const effort =
      rawEffort !== undefined && VALID_EFFORT_VALUES.has(rawEffort) ?
        rawEffort
      : "medium"
    return { effort: effort }
  }

  // type === "enabled"
  if (thinking.budget_tokens !== undefined) {
    return { effort: budgetToEffort(thinking.budget_tokens) }
  }

  return { effort: "medium" }
}

// ---------------------------------------------------------------------------
// Main translation entry point
// ---------------------------------------------------------------------------

export function translateAnthropicToResponses(
  payload: AnthropicMessagesPayload,
  defaultEffort?: string,
): ResponsesPayload {
  // Build input items from all messages
  const inputItems: Array<ResponsesInputItem> = []
  for (const message of payload.messages) {
    if (message.role === "user") {
      inputItems.push(...translateUserMessage(message))
    } else {
      inputItems.push(...translateAssistantMessage(message))
    }
  }

  return {
    model: payload.model,
    input: inputItems,
    instructions: buildInstructions(payload.system),
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
    temperature: payload.temperature,
    top_p: payload.top_p,
    max_output_tokens: payload.max_tokens,
    reasoning: translateReasoning(
      payload.thinking,
      payload.output_config,
      defaultEffort,
    ),
    stream: payload.stream,
    user: payload.metadata?.user_id,
    // NOTE: stop_sequences is not forwarded — the Responses API has no
    // equivalent field.  Callers relying on stop sequences will not get that
    // behaviour when using Responses-only models.
  }
}
