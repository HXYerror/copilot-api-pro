/**
 * Model-to-endpoint routing.
 *
 * Copilot upstream serves some models exclusively via the Responses API
 * (/responses) and others via Chat Completions (/chat/completions).
 * Sending a Responses-only model to /chat/completions produces an error.
 *
 * Detection order (highest authority first):
 *  1. If state.models is loaded, check `supported_endpoints` — this is the
 *     authoritative field Copilot exposes for each model. Models that list
 *     ONLY `/responses` (no `/chat/completions`) must use the Responses API.
 *     This is what catches gpt-5.2-codex, gpt-5.5, o3-pro, etc.
 *  2. Check `capabilities.type === "responses"` (older Copilot models).
 *  3. Static prefix/suffix heuristics (codex / o\d+-pro) as a last resort
 *     when the catalog hasn't loaded yet.
 *
 * "Responses-only" models: codex-* variants, o-pro family, gpt-5.x reasoning
 * models. Everything else uses Chat Completions (or native Anthropic for Claude).
 */

import { state } from "~/lib/state"

/** Endpoint mode for routing. */
export type ModelMode = "chat" | "responses"

/**
 * Returns the upstream endpoint mode for the given model ID.
 * "responses" = must use /responses; "chat" = use /chat/completions (or native Anthropic).
 */
export function getModelMode(modelId: string): ModelMode {
  // Guard: treat missing/empty model as "chat" — upstream will reject with a proper error
  if (!modelId) return "chat"

  // 1. Authoritative: supported_endpoints from the live catalog.
  //    A model that lists ONLY /responses (no /chat/completions) is
  //    Responses-only. The catalog's value is something like
  //    ["/responses", "ws:/responses"] — we strip the optional `ws:` prefix
  //    and check the path component.
  if (state.models?.data) {
    const entry = state.models.data.find((m) => m.id === modelId) as
      | { supported_endpoints?: Array<string>; capabilities?: { type?: string } }
      | undefined
    const supported = entry?.supported_endpoints
    if (Array.isArray(supported) && supported.length > 0) {
      const paths = supported.map((s) => s.replace(/^ws:/i, ""))
      const hasResponses = paths.includes("/responses")
      const hasChat = paths.includes("/chat/completions")
      if (hasResponses && !hasChat) return "responses"
      if (hasChat) return "chat" // trust upstream over heuristics
    }
    // 2. Older Copilot models without supported_endpoints — fall back to
    //    capabilities.type when it explicitly signals "responses".
    //    NOTE: we do NOT trust `type === "chat"` because Copilot has shipped
    //    that value for models that actually require /responses (observed on
    //    gpt-5.x codex variants). When `type === "chat"` we let the static
    //    heuristic below have the final word, so codex / o-pro families are
    //    still routed correctly even without `supported_endpoints`.
    if (entry?.capabilities?.type === "responses") return "responses"
  }

  // 3. Static heuristic: catches codex / o-pro by name pattern.
  return isResponsesOnlyModel(modelId) ? "responses" : "chat"
}

/**
 * Returns true if the model is known to be Responses-only on Copilot upstream
 * by name pattern. Used only as a fallback when the live catalog
 * (state.models) isn't populated.
 */
export function isResponsesOnlyModel(modelId: string): boolean {
  // codex family: gpt-5-codex, gpt-5.1-codex, gpt-5.1-codex-max, gpt-5.3-codex, etc.
  // Anchored to word boundaries to avoid matching hypothetical future "codex-mini" chat models.
  if (/(?:^|-)codex(?:-|$)/.test(modelId)) return true
  // o-pro family: o1-pro, o3-pro, o1-pro-2025-04-09, o3-pro-2025-01-10, etc.
  // Covers: o\d+-pro(?:-\d{4}-\d{2}-\d{2})? — requires string to end after "pro" or date
  if (/^o\d+-pro(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) return true
  return false
}
