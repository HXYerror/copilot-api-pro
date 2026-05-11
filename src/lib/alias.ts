import { getConfig } from "./config-store"

type ModelMap = ReturnType<typeof getConfig>["models"]

/**
 * Resolve a client-facing alias to the upstream model name.
 * If no alias is configured for `input`, returns `input` unchanged (pass-through).
 *
 * Pass an explicit `models` snapshot to share one getConfig() call across
 * ingress + egress rewrites within the same request (avoids inconsistency
 * during hot-reloads and pays the structuredClone cost only once).
 */
export function resolveAlias(input: string, models?: ModelMap): string {
  // Object.hasOwn guards against prototype-chain properties (e.g. "__proto__", "constructor")
  const map = models ?? getConfig().models
  if (!input || !Object.hasOwn(map, input)) return input
  return map[input].upstream
}

/**
 * Rewrite an upstream model name back to the client-facing alias.
 * If no alias maps to `upstream`, returns `upstream` unchanged.
 *
 * Linear scan — acceptable for small alias counts (< ~100 entries).
 * Prefer storing the original client alias from ingress and returning it
 * directly on egress to avoid this scan and multi-alias ambiguity.
 */
export function resolveUpstream(upstream: string, models?: ModelMap): string {
  const map = models ?? getConfig().models
  for (const [alias, entry] of Object.entries(map)) {
    if (entry.upstream === upstream) return alias
  }
  return upstream
}
