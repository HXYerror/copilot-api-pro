/**
 * Default-model fallback (D-013).
 *
 * When a client requests a model that has no alias in `config.models`, we
 * silently rewrite the request to use `config.default_model_alias`.  This
 * stops "I forgot to add gpt-5.5 to the alias map" from sending an unknown
 * name straight to upstream and getting a confusing 4xx.
 *
 * Why a helper instead of inlining in every handler:
 *   - The three POST routes (/v1/chat/completions, /v1/messages, /v1/responses)
 *     all need identical behaviour, including the trace log line.
 *   - Centralising the fallback keeps the scope-check semantics consistent:
 *     scope is enforced against the **effective** alias, never the requested
 *     name, so the fallback can't be used to bypass per-key model gating.
 *
 * What gets logged in the trace / events row:
 *   - events.model           = client_requested  (raw input, even if unknown)
 *   - events.upstream_model  = upstream model id after alias resolution
 *   - consola.info line at debug level when a rewrite happens
 *
 * Errors return a structured payload so the route handler can json() it
 * without rebuilding the message — we never throw.
 */

import type { Config } from "./config-store"

export interface ResolvedModel {
  /** Verbatim model name the client sent in the request body. */
  requested: string
  /** Alias that will be used after fallback (== requested if configured). */
  effective: string
  /** Upstream model id after resolveAlias on `effective`. */
  upstream: string
  /** True iff the client's name was unknown and we rewrote to default. */
  rewritten: boolean
}

export interface ResolveError {
  /** Human-readable message, safe to surface to the client. */
  message: string
  /** Short tag for API consumers (kept stable across error wording changes). */
  code:
    | "unknown_model_no_default"
    | "default_model_alias_misconfigured"
    | "empty_model_field"
}

/**
 * Resolve a client-requested model name through the alias map, falling back
 * to `default_model_alias` when the request names an unconfigured alias.
 *
 * @returns ResolvedModel on success, ResolveError on bad input / unset default.
 */
export function resolveModelWithDefault(
  requested: string | undefined,
  models: Config["models"],
  defaultAlias: string,
): ResolvedModel | ResolveError {
  if (!requested) {
    return {
      message:
        "Request body is missing the `model` field. Set `model` to a configured alias or a known upstream id.",
      code: "empty_model_field",
    }
  }

  // Configured alias — happy path. No fallback, scope check uses requested.
  // Object.hasOwn guards against prototype-chain entries.
  if (Object.hasOwn(models, requested)) {
    return {
      requested,
      effective: requested,
      upstream: models[requested].upstream,
      rewritten: false,
    }
  }

  // Unconfigured alias — try fallback.
  if (!defaultAlias) {
    return {
      message: `Model "${requested}" is not configured and no default_model_alias is set. Add an alias in /admin/settings → Models, or set a default model.`,
      code: "unknown_model_no_default",
    }
  }

  // Schema validation already enforces that defaultAlias exists in models,
  // but a hot-reload race could land us here with a stale alias. Surface as
  // a 500-style error rather than silently picking a different model.
  if (!Object.hasOwn(models, defaultAlias)) {
    return {
      message: `default_model_alias "${defaultAlias}" is not in models. Fix /admin/settings and retry.`,
      code: "default_model_alias_misconfigured",
    }
  }

  return {
    requested,
    effective: defaultAlias,
    upstream: models[defaultAlias].upstream,
    rewritten: true,
  }
}

/** Narrow type-guard for the error branch. */
export function isResolveError(
  r: ResolvedModel | ResolveError,
): r is ResolveError {
  return Object.hasOwn(r, "code")
}

// ---------------------------------------------------------------------------
// applyToContext — handler-side glue
//
// Each of the three POST routes (chat-completions / messages / responses)
// runs the same prelude: resolve → return 400 on error → log on rewrite →
// stash trace_meta on rewrite → set upstream_model.  The handler-local
// version was 30+ lines × 3 = 90 lines of duplication and pushed each
// handler over the max-lines-per-function lint limit.  Centralising here
// keeps the handlers thin.
// ---------------------------------------------------------------------------

import type { Context } from "hono"

import consola from "consola"

import { resolveAlias } from "./alias"
import { getConfig } from "./config-store"

export interface AppliedModelResolution {
  /** Original client-requested alias (verbatim from request body). */
  clientRequestedModel: string
  /** Alias used post-fallback. Equal to clientRequestedModel when no rewrite. */
  clientAlias: string
  /** Final upstream model id (alias → upstream resolution). */
  upstreamModel: string
  /** True iff default-model fallback rewrote the request. */
  rewritten: boolean
}

/**
 * Resolve a request body's `model` field against current config and apply
 * the side effects every D-013 handler needs:
 *
 *   - returns a 400 Response when the model is unknown + no default
 *   - sets `upstream_model` for telemetry
 *   - sets `trace_meta` with the rewrite trail when fallback fired
 *   - logs an info line when fallback fired (visible in debug)
 *
 * Returns either a `Response` (caller should return verbatim) or the
 * resolution details to feed into the rest of the handler.
 */
export function applyDefaultModelRewrite(
  c: Context,
  requestedModel: string | undefined,
  routeLabel: string,
): Response | AppliedModelResolution {
  const { models, default_model_alias } = getConfig()
  const resolved = resolveModelWithDefault(
    requestedModel,
    models,
    default_model_alias,
  )
  if (isResolveError(resolved)) {
    return c.json(
      {
        error: {
          message: resolved.message,
          type: "invalid_request_error",
          code: resolved.code,
        },
      },
      400,
    )
  }
  if (resolved.rewritten) {
    consola.info(
      `[default-model] rewrote "${resolved.requested}" → "${resolved.effective}" (upstream "${resolved.upstream}") on ${routeLabel}`,
    )
  }
  const upstreamModel = resolveAlias(resolved.effective, models)
  c.set("upstream_model", upstreamModel)
  if (resolved.rewritten) {
    c.set("trace_meta", {
      client_requested_model: resolved.requested,
      effective_model: resolved.effective,
      rewritten: true,
    })
  }
  return {
    clientRequestedModel: resolved.requested,
    clientAlias: resolved.effective,
    upstreamModel,
    rewritten: resolved.rewritten,
  }
}

/** True when the value returned by applyDefaultModelRewrite is a 400. */
export function isAppliedError(
  v: Response | AppliedModelResolution,
): v is Response {
  return v instanceof Response
}
