/**
 * Translates an Anthropic /v1/messages payload into a Responses API payload.
 *
 * Used when the requested model is a Responses-only model (e.g. codex, o-pro)
 * so the request can be dispatched via `createResponses` instead of
 * `createChatCompletions`.
 */

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
        const imgBlock = block
        if (imgBlock.source.type === "base64") {
          contentParts.push({
            type: "input_image",
            image_url: `data:${imgBlock.source.media_type};base64,${imgBlock.source.data}`,
          })
        }
        // URL images: skip (not supported on Copilot upstream)
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
        // Preserve signature as encrypted_content for multi-turn continuity
        const reasoningItem: ResponsesReasoningItem = {
          type: "reasoning",
          id: `reasoning_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          summary: [{ type: "summary_text", text: thinkingBlock.thinking }],
          ...(thinkingBlock.signature && {
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
): ResponsesPayload["reasoning"] {
  if (!thinking) return undefined

  if (thinking.type === "adaptive") {
    return { effort: "medium" }
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
    reasoning: translateReasoning(payload.thinking),
    stream: payload.stream,
    user: payload.metadata?.user_id,
  }
}
