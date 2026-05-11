import { getConfig } from "./config-store"

/**
 * Resolve a client-facing alias to the upstream model name.
 * If no alias is configured for `input`, returns `input` unchanged (pass-through).
 */
export function resolveAlias(input: string): string {
  const models = getConfig().models
  if (!Object.hasOwn(models, input)) return input
  return models[input].upstream
}

/**
 * Rewrite an upstream model name back to the client-facing alias.
 * If no alias maps to `upstream`, returns `upstream` unchanged.
 */
export function resolveUpstream(upstream: string): string {
  const models = getConfig().models
  for (const [alias, entry] of Object.entries(models)) {
    if (entry.upstream === upstream) return alias
  }
  return upstream
}
