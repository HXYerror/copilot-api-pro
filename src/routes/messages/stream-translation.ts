import { readCopilotUsage, type NormalisedUsage } from "~/lib/copilot-usage"
import { type ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import {
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

/**
 * Telemetry helper (issue #34): inspect a parsed Anthropic stream event and
 * stash any usage figures it carries on the Hono context for the telemetry
 * middleware.
 *
 * Preference order:
 *   1. Copilot's `copilot_usage.token_details` if the event carries it
 *      (Copilot embeds this on `message_delta` events alongside the native
 *      anthropic `usage` block). This gives us the canonical input /
 *      output / cache_read / cache_write counts.
 *   2. Native Anthropic `usage.input_tokens` / `usage.output_tokens` as
 *      captured by previous versions.
 *
 * Returns the updated `(input, output)` pair so the caller can keep its
 * own running state without re-reading the event.
 */
export function stashAnthropicUsage(
  c: {
    set: (k: "usage", v: NormalisedUsage) => void
  },
  parsed: AnthropicStreamEventData,
  prev: [number | undefined, number | undefined],
): [number | undefined, number | undefined] {
  let [input, output] = prev

  // First try copilot_usage (preferred — same shape across all 3 routes).
  // We rebuild a tiny envelope so readCopilotUsage can do its thing.
  const fromCopilot = readCopilotUsage(parsed as unknown)
  if (
    fromCopilot.prompt_tokens !== undefined
    || fromCopilot.completion_tokens !== undefined
    || fromCopilot.cache_read_tokens !== undefined
    || fromCopilot.cache_creation_tokens !== undefined
  ) {
    if (fromCopilot.prompt_tokens !== undefined) {
      input = fromCopilot.prompt_tokens
    }
    if (fromCopilot.completion_tokens !== undefined) {
      output = fromCopilot.completion_tokens
    }
    c.set("usage", fromCopilot)
    return [input, output]
  }

  // Fallback: native anthropic usage on message_start / message_delta.
  // Both fields are defensively optional-chained — a malformed upstream
  // event (or a future shape change) must not crash the stream.
  if (parsed.type === "message_start") {
    const m = parsed.message
    const usage = m?.usage
    if (typeof usage?.input_tokens === "number") {
      input = usage.input_tokens
    }
    if (typeof usage?.output_tokens === "number") {
      output = usage.output_tokens
    }
  } else if (parsed.type === "message_delta") {
    const u = parsed.usage
    if (u) {
      if (typeof u.input_tokens === "number") input = u.input_tokens
      if (typeof u.output_tokens === "number") output = u.output_tokens
    }
  }
  if (input !== undefined || output !== undefined) {
    c.set("usage", {
      prompt_tokens: input,
      completion_tokens: output,
    })
  }
  return [input, output]
}

function isToolBlockOpen(state: AnthropicStreamState): boolean {
  if (!state.contentBlockOpen) {
    return false
  }
  // Check if the current block index corresponds to any known tool call
  return Object.values(state.toolCalls).some(
    (tc) => tc.anthropicBlockIndex === state.contentBlockIndex,
  )
}

// eslint-disable-next-line max-lines-per-function, complexity
export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  // OpenAI's `stream_options.include_usage: true` (which we set in
  // create-chat-completions for all streaming requests) makes Copilot emit a
  // FINAL chunk after the finish-reason chunk with `choices: []` and a
  // top-level `usage` block. If we early-return here, that usage is lost
  // and the client sees `output_tokens: 0` on message_delta — breaking
  // every downstream billing / quota integration.
  //
  // When we have usage AND message_start has fired AND there were no
  // choices, emit a message_delta carrying ONLY the usage (no stop_reason
  // — the finish_reason chunk already set that). Anthropic accepts
  // multiple message_delta events; the last-write-wins semantics on
  // output_tokens are what we want here.
  if (chunk.choices.length === 0) {
    if (state.messageStartSent && chunk.usage) {
      events.push({
        type: "message_delta",
        delta: {
          // No stop_reason / stop_sequence — leaves whatever the
          // finish-reason chunk set in place.
          stop_reason: null,
          stop_sequence: null,
        },
        usage: {
          input_tokens:
            (chunk.usage.prompt_tokens ?? 0)
            - (chunk.usage.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: chunk.usage.completion_tokens ?? 0,
          ...(chunk.usage.prompt_tokens_details?.cached_tokens
            !== undefined && {
            cache_read_input_tokens:
              chunk.usage.prompt_tokens_details.cached_tokens,
          }),
        },
      })
    }
    return events
  }

  const choice = chunk.choices[0]
  // Defensive: Copilot occasionally emits choices with no `delta`
  // (observed on gpt-4o when only finish_reason changes mid-stream). The
  // destructure would yield `delta = undefined`, then `delta.content`
  // would throw and tear down the whole stream. Treat as empty.
  const delta = choice.delta ?? {}

  if (!state.messageStartSent) {
    events.push({
      type: "message_start",
      message: {
        id: chunk.id,
        type: "message",
        role: "assistant",
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: 0, // Will be updated in message_delta when finished
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens
            !== undefined && {
            cache_read_input_tokens:
              chunk.usage.prompt_tokens_details.cached_tokens,
          }),
        },
      },
    })
    state.messageStartSent = true
  }

  if (delta.content) {
    if (isToolBlockOpen(state)) {
      // A tool block was open, so close it before starting a text block.
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockIndex++
      state.contentBlockOpen = false
    }

    if (!state.contentBlockOpen) {
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "text",
          text: "",
        },
      })
      state.contentBlockOpen = true
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "text_delta",
        text: delta.content,
      },
    })
  }

  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        // New tool call starting.
        if (state.contentBlockOpen) {
          // Close any previously open block.
          events.push({
            type: "content_block_stop",
            index: state.contentBlockIndex,
          })
          state.contentBlockIndex++
          state.contentBlockOpen = false
        }

        const anthropicBlockIndex = state.contentBlockIndex
        state.toolCalls[toolCall.index] = {
          id: toolCall.id,
          name: toolCall.function.name,
          anthropicBlockIndex,
        }

        events.push({
          type: "content_block_start",
          index: anthropicBlockIndex,
          content_block: {
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: {},
          },
        })
        state.contentBlockOpen = true
      }

      if (toolCall.function?.arguments) {
        const toolCallInfo = state.toolCalls[toolCall.index]
        // Tool call can still be empty
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (toolCallInfo) {
          events.push({
            type: "content_block_delta",
            index: toolCallInfo.anthropicBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: toolCall.function.arguments,
            },
          })
        }
      }
    }
  }

  if (choice.finish_reason) {
    if (state.contentBlockOpen) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockOpen = false
    }

    events.push(
      {
        type: "message_delta",
        delta: {
          stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
          stop_sequence: null,
        },
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: chunk.usage?.completion_tokens ?? 0,
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens
            !== undefined && {
            cache_read_input_tokens:
              chunk.usage.prompt_tokens_details.cached_tokens,
          }),
        },
      },
      {
        type: "message_stop",
      },
    )
  }

  return events
}

export function translateErrorToAnthropicErrorEvent(): AnthropicStreamEventData {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: "An unexpected error occurred during streaming.",
    },
  }
}
