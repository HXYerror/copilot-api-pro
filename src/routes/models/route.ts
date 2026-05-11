import { Hono } from "hono"

import { getConfig } from "~/lib/config-store"
import { forwardError } from "~/lib/error"
import { getModelMode } from "~/lib/model-routing"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const { models: configModels } = getConfig()
    const hasAliases = Object.keys(configModels).length > 0

    if (hasAliases) {
      // Config defines aliases — return only enabled aliases.
      // Per-key scope check (F2.C): deferred until auth middleware lands.
      // Until then every caller has implicit wildcard scope (all enabled aliases).
      //
      // NOTE: scope check uses the alias name (user-facing), not the resolved
      // upstream name.  Alias rewriting happens at request time, AFTER auth.
      const data = Object.entries(configModels)
        .filter(([, entry]) => entry.enabled)
        .map(([alias, entry]) => ({
          id: alias,
          object: "model",
          type: "model",
          created: 0,
          created_at: new Date(0).toISOString(),
          // owned_by reflects the upstream model name so clients can infer the provider
          owned_by: entry.upstream,
          display_name: alias,
          mode: getModelMode(entry.upstream),
        }))

      return c.json({ object: "list", data, has_more: false })
    }

    // No aliases configured — fall through to upstream model list (passthrough mode).
    const upstreamModels = state.models?.data.map((model) => ({
      id: model.id,
      object: "model",
      type: "model",
      created: 0,
      created_at: new Date(0).toISOString(),
      owned_by: model.vendor,
      display_name: model.name,
      mode: getModelMode(model.id),
    }))

    return c.json({
      object: "list",
      data: upstreamModels,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
