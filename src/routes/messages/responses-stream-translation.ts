/**
 * Translates Responses API SSE events into Anthropic SSE events for the
 * /v1/messages streaming path.
 *
 * Mapping summary:
 *   response.created              → message_start
 *   response.output_item.added   → content_block_start (thinking / text / tool_use)
 *   response.output_item.done    → signature_delta (if reasoning with encrypted_content) + content_block_stop
 *   response.reasoning_summary_text.delta → content_block_delta (thinking_delta)
 *   response.output_text.delta   → content_block_delta (text_delta)
 *   response.content_part.done   → content_block_stop (for message/text parts)
 *   response.function_call_arguments.delta → content_block_delta (input_json_delta)
 *   response.completed           → message_delta + message_stop
 *   response.failed              → error event
 *   every PING_INTERVAL events   → ping
 */

import { type AnthropicStreamEventData } from "./anthropic-types"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Tracks the state of an in-progress Responses API → Anthropic SSE translation. */
export interface ResponsesStreamState {
  /** Whether the message_start event has been emitted. */
  messageStartSent: boolean
  /** Monotonically increasing Anthropic content-block index. */
  blockIndex: number
  /** Map from Responses output_index → Anthropic block index. */
  outputIndexToBlockIndex: Map<number, number>
  /**
   * Set of output_indexes that correspond to reasoning items.
   * Used to emit signature_delta on response.output_item.done.
   */
  reasoningOutputIndexes: Set<number>
  /**
   * Set of output_indexes that correspond to function_call items.
   * Used to emit content_block_stop on response.output_item.done.
   */
  functionCallOutputIndexes: Set<number>
  /** Message id and model, populated when response.created fires. */
  messageId: string
  messageModel: string
  /** Total number of upstream events received (used for ping scheduling). */
  eventCount: number
}

export function makeResponsesStreamState(): ResponsesStreamState {
  return {
    messageStartSent: false,
    blockIndex: 0,
    outputIndexToBlockIndex: new Map(),
    reasoningOutputIndexes: new Set(),
    functionCallOutputIndexes: new Set(),
    messageId: "",
    messageModel: "",
    eventCount: 0,
  }
}

// ---------------------------------------------------------------------------
// Ping interval
// ---------------------------------------------------------------------------

const PING_INTERVAL = 20

// ---------------------------------------------------------------------------
// Upstream event data shapes (from SSE `data:` field)
// All fields are optional because `data` arrives as unknown at runtime.
// ---------------------------------------------------------------------------

interface ResponseCreatedData {
  response?: { id?: string; model?: string }
}

interface OutputItemAddedData {
  output_index?: number
  item?: {
    type?: string
    id?: string
    call_id?: string
    name?: string
    role?: string
  }
}

interface OutputItemDoneData {
  output_index?: number
  item?: {
    type?: string
    id?: string
    encrypted_content?: string
  }
}

interface ReasoningDeltaData {
  output_index?: number
  delta?: string
}

interface OutputTextDeltaData {
  output_index?: number
  delta?: string
}

interface ContentPartDoneData {
  output_index?: number
}

interface FunctionCallArgsDeltaData {
  output_index?: number
  delta?: string
}

interface ResponseCompletedData {
  response?: {
    status?: string
    usage?: { input_tokens?: number; output_tokens?: number }
  }
}

interface ResponseFailedData {
  response?: { error?: { message?: string } }
}

// ---------------------------------------------------------------------------
// Status → stop_reason
// ---------------------------------------------------------------------------

function mapResponsesStatusToStopReason(
  status: string,
): "end_turn" | "max_tokens" {
  switch (status) {
    case "completed": {
      return "end_turn"
    }
    case "incomplete": {
      return "max_tokens"
    }
    default: {
      // Unknown status (e.g. "cancelled") — default to end_turn to avoid
      // emitting null stop_reason in message_delta which some clients reject.
      return "end_turn"
    }
  }
}

// ---------------------------------------------------------------------------
// Main translation function
// ---------------------------------------------------------------------------

/**
 * Translate one upstream Responses API SSE event into zero or more Anthropic
 * SSE events.  Mutates `state` as a side-effect.
 *
 * Never throws — unknown / unparseable events are silently skipped so we never
 * block stream forwarding.
 */
// eslint-disable-next-line max-lines-per-function, complexity
export function translateResponsesEventToAnthropic(
  eventType: string,
  data: unknown,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  state.eventCount++

  // Emit a ping every PING_INTERVAL events
  if (state.eventCount % PING_INTERVAL === 0) {
    events.push({ type: "ping" })
  }

  switch (eventType) {
    case "response.created":
    case "response.in_progress": {
      const d = data as ResponseCreatedData | null | undefined
      const responseData = d?.response
      if (!state.messageStartSent) {
        // Use response.id if present; fall back to a generated id so message_start
        // is always emitted (missing id must not silently suppress the event).
        const responseId = responseData?.id ?? `msg_fallback_${Date.now()}`
        state.messageId = responseId
        state.messageModel = responseData?.model ?? ""
        events.push({
          type: "message_start",
          message: {
            id: state.messageId,
            type: "message",
            role: "assistant",
            content: [],
            model: state.messageModel,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              // KNOWN LIMITATION: input_tokens not available until response.completed
              // in the Responses API.  Clients reading billing from message_start
              // will always see 0 here; the real count is in message_delta.usage.
              input_tokens: 0,
              output_tokens: 0,
            },
          },
        })
        state.messageStartSent = true
      }
      break
    }

    case "response.output_item.added": {
      const d = data as OutputItemAddedData | null | undefined
      const item = d?.item
      const outputIndex = d?.output_index

      if (item === undefined || outputIndex === undefined) break

      switch (item.type) {
        case "reasoning": {
          const blockIndex = state.blockIndex++
          state.outputIndexToBlockIndex.set(outputIndex, blockIndex)
          state.reasoningOutputIndexes.add(outputIndex)
          events.push({
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "thinking", thinking: "" },
          })
          break
        }
        case "message": {
          // Open a text block so the block index is registered and deltas can
          // be mapped correctly when output_text.delta events arrive.
          const blockIndex = state.blockIndex++
          state.outputIndexToBlockIndex.set(outputIndex, blockIndex)
          events.push({
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "text", text: "" },
          })
          break
        }
        case "function_call": {
          const blockIndex = state.blockIndex++
          state.outputIndexToBlockIndex.set(outputIndex, blockIndex)
          state.functionCallOutputIndexes.add(outputIndex)
          events.push({
            type: "content_block_start",
            index: blockIndex,
            content_block: {
              type: "tool_use",
              id: item.call_id ?? item.id ?? "",
              name: item.name ?? "",
              input: {},
            },
          })
          break
        }
        default: {
          // Unknown item type — do NOT allocate a block index or register a
          // mapping. Allocating without emitting a content_block_start would
          // cause content_part.done to emit an orphaned content_block_stop.
          break
        }
      }
      break
    }

    case "response.reasoning_summary_text.delta": {
      const d = data as ReasoningDeltaData | null | undefined
      const delta = d?.delta
      const outputIndex = d?.output_index
      if (delta === undefined || outputIndex === undefined) break
      const blockIndex = state.outputIndexToBlockIndex.get(outputIndex)
      if (blockIndex === undefined) break
      events.push({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "thinking_delta", thinking: delta },
      })
      break
    }

    case "response.reasoning_summary_text.done": {
      // No action needed — the stop is handled by response.output_item.done
      break
    }

    case "response.output_item.done": {
      const d = data as OutputItemDoneData | null | undefined
      const item = d?.item
      const outputIndex = d?.output_index
      if (item === undefined || outputIndex === undefined) break
      const blockIndex = state.outputIndexToBlockIndex.get(outputIndex)
      if (blockIndex === undefined) break

      if (state.reasoningOutputIndexes.has(outputIndex)) {
        // Emit signature_delta carrying encrypted_content (if present) before stop
        if (item.encrypted_content) {
          events.push({
            type: "content_block_delta",
            index: blockIndex,
            delta: {
              type: "signature_delta",
              signature: item.encrypted_content,
            },
          })
        }
        events.push({ type: "content_block_stop", index: blockIndex })
      } else if (state.functionCallOutputIndexes.has(outputIndex)) {
        events.push({ type: "content_block_stop", index: blockIndex })
      }
      // message items: content_block_stop is emitted by response.content_part.done
      break
    }

    case "response.output_text.delta": {
      const d = data as OutputTextDeltaData | null | undefined
      const delta = d?.delta
      const outputIndex = d?.output_index
      if (delta === undefined || outputIndex === undefined) break
      const blockIndex = state.outputIndexToBlockIndex.get(outputIndex)
      if (blockIndex === undefined) break
      events.push({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "text_delta", text: delta },
      })
      break
    }

    case "response.output_text.done": {
      // No action needed — stop handled by response.content_part.done
      break
    }

    case "response.content_part.done": {
      const d = data as ContentPartDoneData | null | undefined
      const outputIndex = d?.output_index
      if (outputIndex === undefined) break
      const blockIndex = state.outputIndexToBlockIndex.get(outputIndex)
      if (blockIndex === undefined) break
      // Only emit stop for message output items (text parts).
      // Reasoning items are stopped by response.output_item.done.
      // Function_call items are also stopped by response.output_item.done.
      if (
        !state.reasoningOutputIndexes.has(outputIndex)
        && !state.functionCallOutputIndexes.has(outputIndex)
      ) {
        events.push({ type: "content_block_stop", index: blockIndex })
      }
      break
    }

    case "response.content_part.added": {
      // No action needed — we already open the block on output_item.added
      break
    }

    case "response.function_call_arguments.delta": {
      const d = data as FunctionCallArgsDeltaData | null | undefined
      const delta = d?.delta
      const outputIndex = d?.output_index
      if (delta === undefined || outputIndex === undefined) break
      const blockIndex = state.outputIndexToBlockIndex.get(outputIndex)
      if (blockIndex === undefined) break
      events.push({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "input_json_delta", partial_json: delta },
      })
      break
    }

    case "response.function_call_arguments.done": {
      // No action needed — stop handled by response.output_item.done
      break
    }

    case "response.completed": {
      const d = data as ResponseCompletedData | null | undefined
      events.push(
        {
          type: "message_delta",
          delta: {
            stop_reason: mapResponsesStatusToStopReason(
              d?.response?.status ?? "completed",
            ),
            stop_sequence: null,
          },
          usage: {
            input_tokens: d?.response?.usage?.input_tokens ?? 0,
            output_tokens: d?.response?.usage?.output_tokens ?? 0,
          },
        },
        { type: "message_stop" },
      )
      break
    }

    case "response.failed": {
      const d = data as ResponseFailedData | null | undefined
      const message =
        d?.response?.error?.message ?? "Upstream model call failed"
      events.push({
        type: "error",
        error: { type: "api_error", message },
      })
      break
    }

    default: {
      // Unknown event type — skip silently (parse-then-forward pattern)
      break
    }
  }

  return events
}
