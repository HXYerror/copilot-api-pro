import type { Context } from "hono"

import consola from "consola"

import { resolveAlias } from "~/lib/alias"
import { getConfig } from "~/lib/config-store"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import { translateToOpenAI } from "./non-stream-translation"

/**
 * Handles token counting for Anthropic messages.
 *
 * Claude Code calls this BEFORE every real /v1/messages to estimate the
 * prompt cost and trigger its context-management auto-compression when the
 * estimate crosses a threshold. The estimate doesn't need to be exact but
 * it must be in the right order of magnitude — returning `1` (the legacy
 * fallback) makes Claude Code think every prompt is tiny.
 */
export async function handleCountTokens(c: Context) {
  try {
    const anthropicBeta = c.req.header("anthropic-beta")

    const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

    const openAIPayload = translateToOpenAI(anthropicPayload)

    // Look up the model in the upstream catalog so the tokenizer picks a
    // matching encoding. The client sends an alias ("claude-opus-4-7"),
    // state.models is keyed by upstream id ("claude-opus-4.7-1m-internal")
    // so we resolve the alias first.
    const { models: modelAliases } = getConfig()
    const upstreamId = resolveAlias(anthropicPayload.model, modelAliases)
    const selectedModel = state.models?.data.find(
      (m) => m.id === upstreamId || m.id === anthropicPayload.model,
    )

    if (!selectedModel) {
      consola.warn(
        `count_tokens: model not found in upstream catalog (alias=${anthropicPayload.model} upstream=${upstreamId}); falling back to character estimate`,
      )
      // Same rationale as the outer catch — don't return 1 here either,
      // it would mislead Claude Code into skipping auto-compression for
      // any request that hits an unknown model.
      return c.json({
        input_tokens: estimateTokensFromPayload(anthropicPayload),
      })
    }

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)

    if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
      let mcpToolExist = false
      if (anthropicBeta?.startsWith("claude-code")) {
        mcpToolExist = anthropicPayload.tools.some((tool) =>
          tool.name.startsWith("mcp__"),
        )
      }
      if (!mcpToolExist) {
        if (anthropicPayload.model.startsWith("claude")) {
          // https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview#pricing
          tokenCount.input = tokenCount.input + 346
        } else if (anthropicPayload.model.startsWith("grok")) {
          tokenCount.input = tokenCount.input + 480
        }
      }
    }

    let finalTokenCount = tokenCount.input + tokenCount.output
    if (anthropicPayload.model.startsWith("claude")) {
      finalTokenCount = Math.round(finalTokenCount * 1.15)
    } else if (anthropicPayload.model.startsWith("grok")) {
      finalTokenCount = Math.round(finalTokenCount * 1.03)
    }

    consola.info("Token count:", finalTokenCount)

    return c.json({
      input_tokens: finalTokenCount,
    })
  } catch (error) {
    consola.error("Error counting tokens:", error)
    // CRITICAL: do NOT return 1 here. Claude Code reads the count to decide
    // whether to trigger context auto-compression. Returning 1 makes every
    // failed-tokeniser request look tiny, so the client happily sends a
    // 200k-token prompt straight to upstream which then 413s and aborts
    // the whole session. Fall back to a conservative character-based
    // estimate that errs on the LARGER side (≈3 chars/token for English,
    // ~2 for CJK) so compression kicks in when in doubt. Worst case the
    // client compresses unnecessarily, which is recoverable; the
    // alternative (silent context overflow) is not.
    try {
      // Hono caches the parsed JSON, so this is a free re-read when the
      // success path already consumed the body. The .catch covers the
      // case where the original failure WAS the body parse itself.
      const body = await c.req.json<AnthropicMessagesPayload>().catch(() => ({
        messages: [] as AnthropicMessagesPayload["messages"],
      }))
      const estimated = estimateTokensFromPayload(body)
      consola.warn(
        `count_tokens: tokeniser failed, returning char-based estimate=${estimated}`,
      )
      return c.json({ input_tokens: estimated })
    } catch {
      // Estimation itself failed — fall back to a large fixed value so the
      // client errs on compressing rather than overflowing. 100k is below
      // most model max contexts so still actionable.
      return c.json({ input_tokens: 100_000 })
    }
  }
}

/**
 * Character-based token estimate for fallback paths. Counts characters
 * across text / tool_use / tool_result blocks and divides by 2 (which
 * UNDER-estimates token compression — i.e. yields a high token count) so
 * Claude Code errs toward triggering auto-compression rather than
 * blasting an oversized prompt at upstream.
 *
 * Returns at least 1 so callers don't have to guard.
 */
function estimateTokensFromPayload(
  payload: Pick<AnthropicMessagesPayload, "messages">,
): number {
  let chars = 0
  for (const msg of payload.messages ?? []) {
    if (typeof msg.content === "string") {
      chars += msg.content.length
      continue
    }
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type === "text") chars += block.text.length
      else if (block.type === "tool_use") {
        chars += JSON.stringify(block.input ?? {}).length
      } else if (block.type === "tool_result") {
        chars += JSON.stringify(block.content ?? "").length
      }
    }
  }
  // 2 chars / token is pessimistic (real ratio is ~3-4 for English, ~2 for
  // CJK); pessimism is the safe failure mode here.
  return Math.max(1, Math.ceil(chars / 2))
}
