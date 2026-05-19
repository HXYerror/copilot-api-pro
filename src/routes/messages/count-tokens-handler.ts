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
        `count_tokens: model not found in upstream catalog (alias=${anthropicPayload.model} upstream=${upstreamId}); returning default`,
      )
      return c.json({
        input_tokens: 1,
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
    return c.json({
      input_tokens: 1,
    })
  }
}
