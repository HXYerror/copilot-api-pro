/**
 * Pull token counts out of an upstream response, preferring Copilot's
 * `copilot_usage.token_details` array over native Anthropic / OpenAI usage
 * shapes.
 *
 * Why prefer `copilot_usage`:
 *   - It's stamped by Copilot itself on every response (all 3 routes —
 *     /v1/messages, /v1/chat/completions, /v1/responses), so we get a
 *     consistent view regardless of which native API shape the upstream
 *     returned.
 *   - The token_types we've observed in the wild are exactly:
 *       "input" / "output" / "cache_read" / "cache_write"
 *   - It carries cost data (cost_per_batch / total_nano_aiu) we want to
 *     expose later — picking this as the source of truth now avoids a
 *     second migration.
 *
 * Falls back to native `usage` (input_tokens / prompt_tokens / etc.) when
 * the response doesn't include copilot_usage, e.g. mocked responses in
 * tests or non-Copilot proxies.
 */

export interface NormalisedUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  /** Copilot cache_read tokens (= prompt-cache hits). */
  cache_read_tokens?: number
  /** Copilot cache_write tokens (= prompt-cache creations). */
  cache_creation_tokens?: number
  /**
   * "How many of the output tokens were spent on internal reasoning".
   * Only OpenAI's `/responses` route exposes this — under
   * `usage.output_tokens_details.reasoning_tokens`. Anthropic /v1/messages
   * does NOT break it out (thinking tokens are folded into output_tokens
   * with no way to separate them). Best-effort: undefined when upstream
   * didn't report it.
   */
  reasoning_tokens?: number
}

interface CopilotTokenDetail {
  token_type?: string
  token_count?: number
}

interface NativeUsage {
  input_tokens?: number
  output_tokens?: number
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  cache_read_input_tokens?: number
  cache_read_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation_tokens?: number
  /**
   * Field naming varies by upstream shape:
   *   - OpenAI /responses:      usage.output_tokens_details.reasoning_tokens
   *   - Anthropic /v1/messages: usage.output_tokens_details.thinking_tokens
   * We accept both.
   */
  output_tokens_details?: {
    reasoning_tokens?: number
    thinking_tokens?: number
  }
}

/**
 * Read normalised token counts from an upstream response object. Returns
 * an object where every field is optional; callers should `?? undefined`
 * when stashing on `c.var.usage` (telemetry middleware tolerates absent
 * fields and records usage_unknown=1 in that case).
 */
export function readCopilotUsage(response: unknown): NormalisedUsage {
  if (!response || typeof response !== "object") return {}
  const r = response as {
    copilot_usage?: { token_details?: Array<CopilotTokenDetail> }
    usage?: NativeUsage
  }
  const out: NormalisedUsage = {}

  // Primary: copilot_usage.token_details
  const details = r.copilot_usage?.token_details
  if (Array.isArray(details)) {
    for (const td of details) {
      if (typeof td.token_count !== "number") continue
      switch (td.token_type) {
        case "input": {
          out.prompt_tokens = td.token_count
          break
        }
        case "output": {
          out.completion_tokens = td.token_count
          break
        }
        case "cache_read": {
          out.cache_read_tokens = td.token_count
          break
        }
        case "cache_write": {
          out.cache_creation_tokens = td.token_count
          break
        }
        // forward-compat: ignore unknown types here; UI surfaces them via Raw
      }
    }
  }

  // Fallback: native usage shapes (Anthropic / OpenAI). Only fill fields
  // copilot_usage didn't already provide, so the primary source wins.
  const native = r.usage
  if (native) {
    out.prompt_tokens =
      out.prompt_tokens ?? native.input_tokens ?? native.prompt_tokens
    out.completion_tokens =
      out.completion_tokens ?? native.output_tokens ?? native.completion_tokens
    out.total_tokens = out.total_tokens ?? native.total_tokens
    out.cache_read_tokens =
      out.cache_read_tokens
      ?? native.cache_read_input_tokens
      ?? native.cache_read_tokens
    out.cache_creation_tokens =
      out.cache_creation_tokens
      ?? native.cache_creation_input_tokens
      ?? native.cache_creation_tokens
    // Reasoning / thinking tokens hide under output_tokens_details.
    // OpenAI /responses  → reasoning_tokens
    // Anthropic /messages → thinking_tokens
    // Same concept, different field name; accept either.
    out.reasoning_tokens =
      out.reasoning_tokens
      ?? native.output_tokens_details?.reasoning_tokens
      ?? native.output_tokens_details?.thinking_tokens
  }

  // Best-effort total_tokens when neither field provided it.
  if (
    out.total_tokens === undefined
    && out.prompt_tokens !== undefined
    && out.completion_tokens !== undefined
  ) {
    out.total_tokens = out.prompt_tokens + out.completion_tokens
  }

  return out
}
