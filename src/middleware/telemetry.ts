/**
 * Telemetry middleware (issue #34, F3.A).
 *
 * Records one row in the `events` table for every API-proxy request.  Sits
 * after the auth middleware (so `c.var.key` is populated) and before the
 * route handlers.  All telemetry side-effects are wrapped in try/catch so a
 * broken DB / failing insert never propagates to the client.
 *
 * Context variables read:
 * - `key`             — set by authMiddleware (or NO_AUTH_SENTINEL on --no-auth)
 * - `usage`           — set by handler when prompt/completion token counts are known
 * - `upstream_model`  — set by handler after alias resolution
 */

import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

import { recordEvent } from "~/services/events"

import type { KeyVar } from "./auth"

// ---------------------------------------------------------------------------
// Context-variable surface
// ---------------------------------------------------------------------------

export interface TelemetryUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

/** Extension of KeyVar with the telemetry-only variables. */
export type TelemetryVar = KeyVar & {
  usage?: TelemetryUsage
  upstream_model?: string
}

// ---------------------------------------------------------------------------
// Body inspection — only POST routes carry a `model`
// ---------------------------------------------------------------------------

/**
 * Best-effort read of the client-facing model from the request body.
 *
 * We read off a cloned Request so the handler can still call c.req.json().
 * Failures (no body, not JSON, etc.) silently fall through to "n/a".
 */
async function readModelFromBody(reqClone: Request): Promise<string> {
  try {
    const text = await reqClone.text()
    if (!text) return "n/a"
    const parsed = JSON.parse(text) as { model?: unknown }
    if (typeof parsed.model === "string" && parsed.model.length > 0) {
      return parsed.model
    }
  } catch {
    // not JSON or unreadable — fall through
  }
  return "n/a"
}

// ---------------------------------------------------------------------------
// Error-tag heuristic
// ---------------------------------------------------------------------------

/**
 * Map a 4xx/5xx status to a short, low-cardinality tag.  We never store the
 * response body — only this fixed-vocabulary string — so dumps of the events
 * table don't leak request content.
 */
function statusToErrorTag(status: number): string | null {
  if (status < 400) return null
  if (status === 400) return "bad_request"
  if (status === 401) return "unauthorized"
  if (status === 403) return "forbidden"
  if (status === 404) return "not_found"
  if (status === 408) return "timeout"
  if (status === 409) return "conflict"
  if (status === 413) return "payload_too_large"
  if (status === 422) return "unprocessable"
  if (status === 429) return "rate_limited"
  if (status >= 500 && status < 600) return "upstream_error"
  if (status >= 400 && status < 500) return "client_error"
  return "error"
}

// ---------------------------------------------------------------------------
// Insert helper — fully wrapped in try/catch so a failure never propagates
// ---------------------------------------------------------------------------

function safeInsertEvent(
  c: Context<{ Variables: TelemetryVar }>,
  ctx: { start: number; clientModel: string; threw: boolean },
): void {
  try {
    const key = c.get("key") as KeyVar["key"] | undefined
    const usage = c.get("usage")
    const upstream = c.get("upstream_model") ?? ctx.clientModel

    const status = ctx.threw ? 500 : c.res.status
    const errorTag = statusToErrorTag(status)
    const promptTokens = usage?.prompt_tokens ?? null
    const completionTokens = usage?.completion_tokens ?? null
    const usageUnknown =
      promptTokens === null && completionTokens === null ? 1 : 0

    recordEvent({
      ts: ctx.start,
      key_id: key?.id ?? "__noauth__",
      model: ctx.clientModel,
      upstream_model: upstream,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      status,
      latency_ms: Date.now() - ctx.start,
      error: errorTag,
      usage_unknown: usageUnknown,
    })
  } catch (err) {
    // Double-belt: recordEvent already catches its own errors, but if the
    // caller-side prep (c.get, etc.) throws we still don't want to leak.
    consola.error(`[telemetry] middleware insert failed: ${String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export const telemetryMiddleware: MiddlewareHandler<{
  Variables: TelemetryVar
}> = async (c, next) => {
  const start = Date.now()

  // Snapshot the client-facing model name BEFORE next() consumes the body.
  // Hono buffers the body, but we clone defensively so c.req.json() still
  // works inside the handler.
  let clientModel = "n/a"
  if (c.req.method === "POST") {
    try {
      // c.req.raw.clone() returns the undici Request type; cast to lib.dom's
      // Request shape — readModelFromBody only needs .text().
      clientModel = await readModelFromBody(c.req.raw.clone() as Request)
    } catch (err) {
      consola.debug(`[telemetry] body model snapshot failed: ${String(err)}`)
    }
  }

  let threw = false
  try {
    await next()
  } catch (err) {
    threw = true
    // Re-throw so the surrounding error handler turns this into a 500.
    // We still want to record the failure event in the finally below.
    throw err
  } finally {
    // For streaming responses the handler's body-iteration runs AFTER this
    // middleware returns. Wrap the response body in a passthrough that fires
    // the telemetry insert when the underlying stream closes — that way the
    // handler has had a chance to stash usage on c.var.
    instrumentResponseOrInsert(c, { start, clientModel, threw })
  }
}

function instrumentResponseOrInsert(
  c: Context<{ Variables: TelemetryVar }>,
  ctx: { start: number; clientModel: string; threw: boolean },
): void {
  const body = c.res.body
  const contentType = c.res.headers.get("content-type") ?? ""
  const isStreaming = contentType.includes("text/event-stream")

  // Non-stream paths (JSON responses, errors): the handler already returned
  // the body; insert immediately so we don't rely on the client reading the
  // response to trigger flush.
  if (!body || ctx.threw || !isStreaming) {
    safeInsertEvent(c, ctx)
    return
  }

  // Streaming path: tee the body through a transform stream and fire the
  // insert in its `flush` hook (which runs after the source closes — i.e.
  // after the handler has finished writing chunks and stashed usage on the
  // context).
  try {
    const transformed = body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk)
        },
        flush() {
          safeInsertEvent(c, ctx)
        },
      }),
    )
    // Replace the response with one that wraps the instrumented body but
    // preserves all original headers/status.
    c.res = new Response(transformed, {
      status: c.res.status,
      headers: c.res.headers,
    })
  } catch (err) {
    // pipeThrough can throw if body is already locked — fall back to immediate
    consola.error(
      `[telemetry] could not instrument response body: ${String(err)}`,
    )
    safeInsertEvent(c, ctx)
  }
}
