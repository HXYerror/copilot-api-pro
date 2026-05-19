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
  /**
   * Copilot-reported cache hit tokens.  Sourced from
   * `copilot_usage.token_details[token_type=cache_read]` when present,
   * falls back to native `usage.cache_read_input_tokens`.
   */
  cache_read_tokens?: number
  /** Copilot-reported cache write tokens (cache_creation). */
  cache_creation_tokens?: number
  /** Reasoning tokens (only OpenAI /responses). */
  reasoning_tokens?: number
}

/** Extension of KeyVar with the telemetry-only variables. */
export type TelemetryVar = KeyVar & {
  usage?: TelemetryUsage
  upstream_model?: string
  /**
   * Client-facing alias that the handler decided to route to. Differs from the
   * raw body field when default_model_alias fallback rewrites an unconfigured
   * request (D-013). When unset, telemetry records the body-snapshot value.
   */
  client_requested_model?: string
  effective_model?: string
  /** Anthropic thinking level captured from the request body (D-014). */
  thinking_level?: string | null
}

// ---------------------------------------------------------------------------
// Body inspection — only POST routes carry a `model`
// ---------------------------------------------------------------------------

/** Cap on how much of the request body we'll buffer to look for "model". */
const MODEL_SNAPSHOT_MAX_BYTES = 16 * 1024
const MODEL_FIELD_RE = /"model"\s*:\s*"([^"\\]{1,200})"/

// Anthropic / OpenAI thinking-related fields captured client-side:
//   Claude Code v2.x: {"output_config":{"effort":"low|medium|high|xhigh"}}
//                     (paired with {"thinking":{"type":"adaptive"}}) —
//                     output_config.effort is the level Copilot gates on.
//   Anthropic legacy: {"thinking":{"type":"enabled","budget_tokens":N}}
//                     or {"max_thinking_tokens":N}
//   OpenAI Responses: {"reasoning":{"effort":"low"|"medium"|"high"}}
//
// We store the RAW signal as a short tag the UI can show verbatim:
//   "low" / "medium" / "high" / "xhigh"  — Claude Code output_config.effort
//   "adaptive"                            — Anthropic mode without effort
//   "10000"                               — explicit budget (just the number)
//   "effort:high"                         — OpenAI Responses reasoning effort
//   null                                  — no thinking-related field
//
// Field-priority (the LEVEL that actually controls the model):
//   1. output_config.effort   (Claude Code v2.x — gates on Copilot)
//   2. reasoning.effort       (OpenAI Responses — different endpoint)
//   3. thinking.budget_tokens (Anthropic legacy enabled mode)
//   4. max_thinking_tokens    (very-legacy top-level)
//   5. thinking.type          (just the mode flag, no level)
const THINKING_TYPE_RE = /"thinking"\s*:\s*\{[^{}]*?"type"\s*:\s*"([^"]+)"/
const THINKING_BUDGET_RE =
  /"thinking"\s*:\s*\{[^{}]*?"budget_tokens"\s*:\s*(\d+)/
const MAX_THINKING_TOKENS_RE = /"max_thinking_tokens"\s*:\s*(\d+)/
const REASONING_EFFORT_RE =
  /"reasoning"\s*:\s*\{[^{}]*?"effort"\s*:\s*"([^"]+)"/
const OUTPUT_CONFIG_EFFORT_RE =
  /"output_config"\s*:\s*\{[^{}]*?"effort"\s*:\s*"([^"]+)"/

function captureThinkingRaw(buf: string): string | null {
  // Claude Code v2.x — primary signal, takes priority
  const oc = OUTPUT_CONFIG_EFFORT_RE.exec(buf)
  if (oc && oc[1]) return oc[1]
  // OpenAI Responses
  const reasoning = REASONING_EFFORT_RE.exec(buf)
  if (reasoning && reasoning[1]) return `effort:${reasoning[1]}`
  // Anthropic legacy with explicit budget
  const budget =
    THINKING_BUDGET_RE.exec(buf) ?? MAX_THINKING_TOKENS_RE.exec(buf)
  if (budget && budget[1]) return budget[1]
  // Bare thinking.type (e.g. "adaptive" with no effort)
  const type = THINKING_TYPE_RE.exec(buf)
  if (type && type[1]) return type[1]
  return null
}

/**
 * Best-effort read of a few client-facing fields (model + thinking) from
 * the request body.
 *
 * Reads at most MODEL_SNAPSHOT_MAX_BYTES from a cloned body and stops as
 * soon as both `model` and (when present) `thinking` substrings have been
 * located. Never buffers the entire body — large vision / long-context
 * payloads must not pin memory just for telemetry. Failures (no body, no
 * model field, unreadable) silently fall through to model="n/a".
 *
 * Returns:
 *   - model: client-requested model name, or "n/a" when missing
 *   - thinking_level: short level string ("auto" / "think-hard" / etc.),
 *     or null when the request didn't include a thinking field
 */
async function snapshotPostMeta(
  reqClone: Request,
): Promise<{ model: string; thinking_level: string | null }> {
  const reader = reqClone.body?.getReader()
  if (!reader) return { model: "n/a", thinking_level: null }
  const decoder = new TextDecoder()
  let buf = ""
  let totalBytes = 0
  let modelMatch: string | undefined
  try {
    while (totalBytes < MODEL_SNAPSHOT_MAX_BYTES) {
      const result = (await reader.read()) as {
        value?: Uint8Array
        done: boolean
      }
      if (result.done) break
      const value = result.value
      if (!value) break
      totalBytes += value.byteLength
      buf += decoder.decode(value, { stream: true })
      if (!modelMatch) {
        const m = MODEL_FIELD_RE.exec(buf)
        if (m && m[1]) modelMatch = m[1]
      }
      // Early-exit once we've grabbed the model AND seen either a thinking
      // / reasoning / output_config field (or scanned enough that they
      // would have been near the top).
      if (
        modelMatch
        && (buf.includes('"thinking"')
          || buf.includes('"reasoning"')
          || buf.includes('"output_config"')
          || totalBytes >= 4096)
      ) {
        break
      }
    }
  } catch {
    // unreadable — fall through
  } finally {
    try {
      await reader.cancel()
    } catch {
      // already closed
    }
  }
  if (!modelMatch) {
    const final = MODEL_FIELD_RE.exec(buf)
    if (final && final[1]) modelMatch = final[1]
  }
  return {
    model: modelMatch ?? "n/a",
    thinking_level: captureThinkingRaw(buf),
  }
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
  ctx: {
    start: number
    clientModel: string
    thinkingLevel: string | null
    threw: boolean
    aborted?: boolean
  },
): void {
  try {
    const key = c.get("key") as KeyVar["key"] | undefined
    const usage = c.get("usage")
    const upstream = c.get("upstream_model") ?? ctx.clientModel

    const status = ctx.threw ? 500 : c.res.status
    const errorTag =
      ctx.aborted && status < 400 ? "client_aborted" : statusToErrorTag(status)
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
      thinking_level: ctx.thinkingLevel,
      cache_read_tokens: usage?.cache_read_tokens ?? null,
      cache_creation_tokens: usage?.cache_creation_tokens ?? null,
      reasoning_tokens: usage?.reasoning_tokens ?? null,
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

  // Snapshot the client-facing model name + thinking level BEFORE next()
  // consumes the body. We clone defensively so c.req.json() still works
  // inside the handler. GET routes (e.g. /v1/models) have no body fields —
  // for those we record "<METHOD route>" so the Logs page row shows the
  // actual endpoint instead of an uninformative "n/a".
  let clientModel = `${c.req.method} ${c.req.path}`
  let thinkingLevel: string | null = null
  if (c.req.method === "POST") {
    try {
      const meta = await snapshotPostMeta(c.req.raw.clone() as Request)
      if (meta.model !== "n/a") clientModel = meta.model
      thinkingLevel = meta.thinking_level
    } catch (err) {
      consola.debug(`[telemetry] body meta snapshot failed: ${String(err)}`)
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
    instrumentResponseOrInsert(c, {
      start,
      clientModel,
      thinkingLevel,
      threw,
    })
  }
}

function instrumentResponseOrInsert(
  c: Context<{ Variables: TelemetryVar }>,
  ctx: {
    start: number
    clientModel: string
    thinkingLevel: string | null
    threw: boolean
  },
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

  // Streaming path: wrap the body in a custom ReadableStream so we can hook
  // BOTH the EOF path (controller.close inside pull) and the cancel path
  // (downstream client disconnect). The `recorded` guard prevents double
  // inserts when an EOF arrives after a cancel.
  //
  // Note: TransformStream's `cancel` callback is not invoked on downstream
  // cancel in current Bun runtime, so we hand-roll the wrap.
  let recorded = false
  const fire = (extra: { aborted?: boolean } = {}): void => {
    if (recorded) return
    recorded = true
    safeInsertEvent(c, { ...ctx, ...extra })
  }

  try {
    const sourceReader = body.getReader()
    const wrapped = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = (await sourceReader.read()) as {
            value?: Uint8Array
            done: boolean
          }
          if (result.done) {
            controller.close()
            fire()
            return
          }
          if (result.value) controller.enqueue(result.value)
        } catch (err) {
          // Upstream errored mid-stream — record and propagate.
          fire({ aborted: true })
          controller.error(err)
        }
      },
      cancel(reason) {
        consola.debug(
          `[telemetry] stream cancelled: ${String(reason ?? "client_disconnect")}`,
        )
        fire({ aborted: true })
        // Best-effort upstream cancellation.
        sourceReader.cancel(reason).catch(() => {
          /* upstream already gone */
        })
      },
    })

    // Replace the response with one that wraps the instrumented body but
    // preserves all original headers/status.
    c.res = new Response(wrapped, {
      status: c.res.status,
      headers: c.res.headers,
    })
  } catch (err) {
    // getReader can throw if body is already locked — fall back to immediate
    consola.error(
      `[telemetry] could not instrument response body: ${String(err)}`,
    )
    fire()
  }
}
