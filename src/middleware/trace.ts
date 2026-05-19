/**
 * Trace middleware (issue #36, F4.A).
 *
 * Captures the full client→proxy request and proxy→client response for the
 * subset of requests that opted in to debug capture. Activates when ANY of:
 *
 *  - `c.var.key.debug_enabled === 1` and the key is not revoked and
 *    `debug_expires_at > now` (canonical check: services/keys.isDebugActive),
 *  - the request carries `X-Capi-Debug: 1` and the caller's tier is "admin"
 *    (auth.ts strips the header for non-admin keys, so the cheap tier check
 *    here is defence-in-depth),
 *  - `config.features.debug === true` (operator-flipped global switch in the
 *    Settings UI — captures every request regardless of key state, intended
 *    for short-lived debugging sessions).
 *
 * Sits after authMiddleware and telemetryMiddleware, before route handlers,
 * mounted on the same proxied routes as telemetry (excludes /admin/* and
 * health probes).
 *
 * Body capture is capped at MAX_BODY_BYTES per leg; anything beyond is
 * replaced with "[TRUNCATED]".
 *
 * Coverage: client→proxy and proxy→client are captured by the middleware
 * directly. The upstream legs (proxy→GitHub Copilot) are captured by helpers
 * in src/services/copilot/* via the `c.var.trace_capture_upstream` callback
 * we expose here — see the "Note on upstream capture" near the bottom of
 * this file for the contract.
 */

import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"
import { randomUUID } from "node:crypto"

import { getConfig } from "~/lib/config-store"
import { isDebugActive } from "~/services/keys"
import { writeTrace, type TraceLeg } from "~/services/trace-writer"

import type { KeyVar } from "./auth"

const MAX_BODY_BYTES = 256 * 1024 // 256 KB per leg

// ---------------------------------------------------------------------------
// Upstream-capture API
//
// Copilot service helpers (src/services/copilot/*) can call
// `c.var.trace_capture_upstream({req, res})` to record the proxy → GitHub
// Copilot leg of the request.  The trace middleware reads this back in its
// finally hook and emits it as upstream_req / upstream_res in the JSONL line.
//
// When debug capture is NOT active, the setter is a no-op stub — helpers
// can call it unconditionally without any branching at call sites.
// ---------------------------------------------------------------------------

export interface UpstreamCapture {
  req: TraceLeg
  res?: TraceLeg
}

export type TraceCaptureUpstream = (capture: UpstreamCapture) => void

export type TraceVar = KeyVar & {
  trace_capture_upstream?: TraceCaptureUpstream
  /**
   * Free-form metadata bag the route handler stashes onto the context for the
   * trace writer.  Today carries:
   *   { client_requested_model, effective_model, rewritten }
   * when the default-model fallback kicks in.  See lib/default-model.ts.
   */
  trace_meta?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Activation check
// ---------------------------------------------------------------------------

function shouldCapture(c: Context<{ Variables: KeyVar }>): boolean {
  const key = c.get("key") as KeyVar["key"] | undefined
  if (!key) return false

  // Global override from config.features.debug — captures every request
  // regardless of key state. Operator-flipped via Settings UI; intended for
  // short-lived debug sessions because trace files can grow fast.
  if (getConfig().features.debug) return true

  // Key-level debug opt-in (the canonical "trace this key" signal).
  if (isDebugActive(key)) return true

  // Admin-tier override via X-Capi-Debug. authMiddleware has already
  // stripped the header (so it never leaks upstream) and surfaced the bit
  // on the context — we read from there. Tier check is redundant given
  // auth.ts only sets the flag for admin-tier callers, but keeping it
  // makes the contract explicit and survives future refactors.
  const viaHeader = c.get("debug_via_header")
  if (viaHeader === true && key.tier === "admin") return true

  return false
}

// ---------------------------------------------------------------------------
// Body capture
//
// Reads up to MAX_BODY_BYTES from a cloned Request body / wrapped Response.
// Returns a string (not bytes) since the writer JSON-stringifies the body
// before redaction anyway.
// ---------------------------------------------------------------------------

async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!body) return ""
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let totalBytes = 0
  let truncated = false
  try {
    while (totalBytes < MAX_BODY_BYTES) {
      const result = (await reader.read()) as {
        value?: Uint8Array
        done: boolean
      }
      if (result.done) break
      const value = result.value
      if (!value) break
      const remaining = MAX_BODY_BYTES - totalBytes
      if (value.byteLength > remaining) {
        buf += decoder.decode(value.slice(0, remaining), { stream: true })
        totalBytes = MAX_BODY_BYTES
        truncated = true
        break
      }
      buf += decoder.decode(value, { stream: true })
      totalBytes += value.byteLength
    }
    // Detect if there's still more data
    if (!truncated) {
      const tail = (await reader.read()) as {
        value?: Uint8Array
        done: boolean
      }
      if (!tail.done) truncated = true
    }
  } catch (err) {
    consola.debug(`[trace] body read failed: ${String(err)}`)
  } finally {
    try {
      await reader.cancel()
    } catch {
      // already done
    }
  }
  return truncated ? `${buf}[TRUNCATED]` : buf
}

function headersToObj(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of h.entries()) out[k.toLowerCase()] = v
  return out
}

// ---------------------------------------------------------------------------
// Request capture
// ---------------------------------------------------------------------------

async function captureRequest(
  c: Context<{ Variables: KeyVar }>,
): Promise<TraceLeg> {
  const raw = c.req.raw
  let body = ""
  if (raw.body && raw.method !== "GET" && raw.method !== "HEAD") {
    try {
      const cloned = raw.clone() as Request
      body = await readBodyCapped(cloned.body)
    } catch (err) {
      consola.debug(`[trace] request clone failed: ${String(err)}`)
    }
  }
  return {
    method: raw.method,
    url: raw.url,
    headers: headersToObj(raw.headers),
    body,
  }
}

// ---------------------------------------------------------------------------
// Response capture
//
// Wraps the response body in a passthrough ReadableStream so we can
// concurrently feed the client AND capture (capped) bytes for the trace.
// Same general shape as telemetry.ts but we also accumulate the body text.
// ---------------------------------------------------------------------------

interface ResponseCaptureState {
  buf: string
  totalBytes: number
  truncated: boolean
}

function appendCapped(
  state: ResponseCaptureState,
  decoder: TextDecoder,
  chunk: Uint8Array,
): void {
  if (state.totalBytes >= MAX_BODY_BYTES) {
    state.truncated = true
    return
  }
  const remaining = MAX_BODY_BYTES - state.totalBytes
  if (chunk.byteLength > remaining) {
    state.buf += decoder.decode(chunk.slice(0, remaining), { stream: true })
    state.totalBytes = MAX_BODY_BYTES
    state.truncated = true
    return
  }
  state.buf += decoder.decode(chunk, { stream: true })
  state.totalBytes += chunk.byteLength
}

function wrapResponseForCapture(
  c: Context<{ Variables: KeyVar }>,
  onFinish: (state: ResponseCaptureState) => void,
): void {
  const body = c.res.body
  const state: ResponseCaptureState = {
    buf: "",
    totalBytes: 0,
    truncated: false,
  }
  if (!body) {
    onFinish(state)
    return
  }

  const decoder = new TextDecoder()
  let finished = false
  const fire = (): void => {
    if (finished) return
    finished = true
    onFinish(state)
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
          if (result.value) {
            appendCapped(state, decoder, result.value)
            controller.enqueue(result.value)
          }
        } catch (err) {
          fire()
          controller.error(err)
        }
      },
      cancel() {
        fire()
        sourceReader.cancel().catch(() => {
          /* upstream already gone */
        })
      },
    })
    c.res = new Response(wrapped, {
      status: c.res.status,
      headers: c.res.headers,
    })
  } catch (err) {
    consola.debug(`[trace] response wrap failed: ${String(err)}`)
    fire()
  }
}

function bodyOrTruncated(state: ResponseCaptureState): string {
  return state.truncated ? `${state.buf}[TRUNCATED]` : state.buf
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export const traceMiddleware: MiddlewareHandler<{ Variables: KeyVar }> = async (
  c,
  next,
) => {
  if (!shouldCapture(c)) {
    await next()
    return
  }

  const start = Date.now()
  const traceId = randomUUID()
  const reqLeg = await captureRequest(c)
  const key = c.get("key") as KeyVar["key"] | undefined

  // Install the upstream-capture sink. Helpers under
  // src/services/copilot/* call this with their fetch req+res shape so we
  // can record the proxy→Copilot leg of the request.
  // v1 supports a SINGLE upstream pair (most routes make exactly one
  // upstream call); subsequent captures within the same request overwrite.
  let upstreamReq: TraceLeg | undefined
  let upstreamRes: TraceLeg | undefined
  const capture: TraceCaptureUpstream = (cap) => {
    upstreamReq = cap.req
    if (cap.res) upstreamRes = cap.res
  }
  // Type-safe set; helpers retrieve via c.var.trace_capture_upstream.
  ;(c as Context<{ Variables: TraceVar }>).set(
    "trace_capture_upstream",
    capture,
  )

  let threw = false
  let thrown: unknown = null
  try {
    await next()
  } catch (err) {
    threw = true
    thrown = err
  }

  const finishTrace = (resState: ResponseCaptureState): void => {
    try {
      const traceMeta = (c.var as { trace_meta?: Record<string, unknown> })
        .trace_meta
      writeTrace({
        trace_id: traceId,
        ts: start,
        key_id: key?.id ?? "__noauth__",
        route: c.req.path,
        req: reqLeg,
        upstream_req: upstreamReq,
        upstream_res: upstreamRes,
        res: {
          status: c.res.status,
          headers: headersToObj(c.res.headers),
          body: bodyOrTruncated(resState),
        },
        latency_ms: Date.now() - start,
        meta: traceMeta,
      })
    } catch (err) {
      consola.error(`[trace] writeTrace failed (continuing): ${String(err)}`)
    }
  }

  if (threw) {
    finishTrace({ buf: "", totalBytes: 0, truncated: false })
    throw thrown
  }

  wrapResponseForCapture(c, finishTrace)
}

// Note on upstream capture: the trace middleware exports a
// TraceCaptureUpstream function via c.var.trace_capture_upstream when debug
// is active. Helpers under src/services/copilot/* call this after each
// upstream fetch to record the proxy→Copilot leg. When debug is NOT active,
// the var is undefined so helpers' branch goes no-op without overhead.
