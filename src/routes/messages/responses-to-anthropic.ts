/**
 * Translates a Responses API `ResponsesResponse` into an Anthropic
 * `AnthropicResponse` so the /v1/messages handler can return a format that
 * Anthropic clients understand.
 */

// Keys that trigger prototype pollution — stripped from upstream tool arguments
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"])

import type {
  ResponsesOutputFunctionCall,
  ResponsesOutputMessage,
  ResponsesOutputReasoning,
  ResponsesResponse,
} from "~/routes/responses/types"

import type {
  AnthropicAssistantContentBlock,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolUseBlock,
} from "./anthropic-types"

// ---------------------------------------------------------------------------
// Status → stop_reason mapping
// ---------------------------------------------------------------------------

function mapStatus(
  status: ResponsesResponse["status"],
): AnthropicResponse["stop_reason"] {
  switch (status) {
    case "completed": {
      return "end_turn"
    }
    case "incomplete": {
      return "max_tokens"
    }
    default: {
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Output item → Anthropic content block(s)
// ---------------------------------------------------------------------------

function translateReasoningItem(
  item: ResponsesOutputReasoning,
): AnthropicThinkingBlock {
  // Prefer the first summary text as the thinking text; fall back to ""
  const thinkingText = item.summary?.[0]?.text ?? ""

  const block: AnthropicThinkingBlock = {
    type: "thinking",
    thinking: thinkingText,
  }

  // Preserve encrypted_content as signature for multi-turn continuity.
  // Use !== undefined rather than truthy check: an empty string "" is a valid
  // (if unusual) blob and must not be silently dropped.
  if (item.encrypted_content !== undefined) {
    block.signature = item.encrypted_content
  }

  return block
}

function translateMessageItem(
  item: ResponsesOutputMessage,
): Array<AnthropicTextBlock> {
  // Join all output_text parts into separate text blocks (one per part)
  const textParts = item.content.filter(
    (
      p,
    ): p is {
      type: "output_text"
      text: string
      annotations?: Array<unknown>
    } => p.type === "output_text",
  )

  if (textParts.length === 0) return []

  // Merge all text parts into a single text block (Anthropic expects one text block per message)
  const combined = textParts.map((p) => p.text).join("")
  return [{ type: "text", text: combined }]
}

function translateFunctionCallItem(
  item: ResponsesOutputFunctionCall,
): AnthropicToolUseBlock {
  let parsedInput: Record<string, unknown>
  try {
    const raw: unknown = JSON.parse(item.arguments)
    // Non-object JSON (array, number, null, etc.) → wrap in _raw
    parsedInput =
      typeof raw !== "object" || raw === null || Array.isArray(raw) ?
        { _raw: item.arguments }
        // Strip prototype-pollution keys before forwarding.
        // Use Object.entries to avoid inherited properties and __proto__ setter tricks.
      : Object.fromEntries(
          Object.entries(raw as Record<string, unknown>).filter(
            ([k]) => !DANGEROUS_KEYS.has(k),
          ),
        )
  } catch {
    // If arguments are not valid JSON, wrap as a string
    parsedInput = { _raw: item.arguments }
  }

  return {
    type: "tool_use",
    id: item.call_id,
    name: item.name,
    input: parsedInput,
  }
}

// ---------------------------------------------------------------------------
// Determine stop_reason from output items (tool_use takes precedence)
// ---------------------------------------------------------------------------

function deriveStopReason(
  response: ResponsesResponse,
): AnthropicResponse["stop_reason"] {
  const hasToolCall = response.output.some(
    (item) => item.type === "function_call",
  )
  if (hasToolCall) return "tool_use"
  return mapStatus(response.status)
}

// ---------------------------------------------------------------------------
// Main translation entry point
// ---------------------------------------------------------------------------

export function translateResponsesToAnthropic(
  response: ResponsesResponse,
): AnthropicResponse {
  const contentBlocks: Array<AnthropicAssistantContentBlock> = []

  for (const item of response.output) {
    switch (item.type) {
      case "reasoning": {
        contentBlocks.push(translateReasoningItem(item))
        break
      }
      case "message": {
        contentBlocks.push(...translateMessageItem(item))
        break
      }
      case "function_call": {
        contentBlocks.push(translateFunctionCallItem(item))
        break
      }
      default: {
        // Unknown output item type — skip silently
        break
      }
    }
  }

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: contentBlocks,
    stop_reason: deriveStopReason(response),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      ...(response.usage?.input_tokens_details?.cached_tokens !== undefined && {
        cache_read_input_tokens:
          response.usage.input_tokens_details.cached_tokens,
      }),
    },
  }
}
