import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { TelemetryVar } from "~/middleware/telemetry"

import { awaitApproval } from "~/lib/approval"
import { getConfig } from "~/lib/config-store"
import { readCopilotUsage } from "~/lib/copilot-usage"
import { applyDefaultModelRewrite, isAppliedError } from "~/lib/default-model"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { isModelAllowed } from "~/middleware/auth"
import {
  createResponses,
  type UpstreamCaptureFn,
} from "~/services/copilot/create-responses"

import type { ResponsesPayload, ResponsesResponse } from "./types"

import { sanitiseOutputItem, sanitiseResponsesOutput } from "./translation"

export async function handleResponses(
  c: Context<{ Variables: TelemetryVar }>,
): Promise<Response> {
  let payload: ResponsesPayload
  try {
    payload = await c.req.json<ResponsesPayload>()
  } catch {
    return c.json(
      {
        error: {
          message: "Invalid JSON body",
          type: "invalid_request_error",
          code: "invalid_json",
        },
      },
      400,
    )
  }

  consola.debug("Responses API request payload:", JSON.stringify(payload))

  // D-013: rewrite unconfigured aliases to default_model_alias.  Same
  // semantics as the other two POST routes.
  const resolved = applyDefaultModelRewrite(c, payload.model, "/v1/responses")
  if (isAppliedError(resolved)) return resolved
  const { clientRequestedModel, clientAlias, upstreamModel } = resolved
  payload = { ...payload, model: upstreamModel }

  // Scope check: verify the EFFECTIVE alias is in the key's allowed_models.
  // /v1/responses previously skipped this check entirely (the route was added
  // before alias gating). Adding it here closes the same gap as the other two
  // handlers — without it, callers could bypass scope by requesting a model
  // that hits default-fallback to a privileged alias.
  const key = c.get("key")
  if (!isModelAllowed(key.allowed_models, clientAlias)) {
    return c.json(
      {
        error: {
          message: `Model "${clientRequestedModel}" is not in your key's allowed models`,
          type: "permission_denied",
          code: "model_not_allowed",
        },
      },
      403,
    )
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Apply the operator-configured request rate limit (--rate-limit). The
  // other two endpoints (/v1/chat/completions and /v1/messages) already gate
  // here; without this check, callers can bypass the throttle by routing
  // traffic through /v1/responses and burn Copilot quota → GitHub abuse
  // detection / account suspension.
  await checkRateLimit(state)

  // Per-alias default effort: inject when client didn't supply reasoning.effort.
  // Responses API has effort: low|medium|high (no xhigh); xhigh → high.
  const aliasDefault = getConfig().models[clientAlias]?.default_effort
  if (!payload.reasoning?.effort && aliasDefault && aliasDefault !== "") {
    const e = aliasDefault === "xhigh" ? "high" : aliasDefault
    consola.debug(
      `[alias-effort] injecting reasoning.effort=${e} (alias=${clientAlias})`,
    )
    payload = {
      ...payload,
      reasoning: { ...payload.reasoning, effort: e },
    }
    c.set("thinking_level", `effort:${e}`)
  } else if (payload.reasoning?.effort) {
    c.set("thinking_level", `effort:${payload.reasoning.effort}`)
  }

  const onUpstream = (c.var as { trace_capture_upstream?: UpstreamCaptureFn })
    .trace_capture_upstream
  const response = await createResponses(payload, onUpstream)

  if (!payload.stream) {
    const sanitised = sanitiseResponsesOutput(response as ResponsesResponse)
    consola.debug(
      "Responses non-streaming response:",
      JSON.stringify(sanitised).slice(0, 400),
    )
    // Telemetry: capture Copilot's token counts before returning so the
    // events table reflects /v1/responses traffic too.
    c.set("usage", readCopilotUsage(sanitised))
    return c.json(sanitised)
  }

  return streamResponsesEvents(c, response)
}

// ---------------------------------------------------------------------------
// Streaming branch — extracted to keep handleResponses under the
// max-lines-per-function lint limit.
// ---------------------------------------------------------------------------

function streamResponsesEvents(
  c: Context<{ Variables: TelemetryVar }>,
  response: Awaited<ReturnType<typeof createResponses>>,
): Response {
  // Streaming: proxy SSE events verbatim (same pattern as native Anthropic pass-through)
  consola.debug("Responses streaming response — proxying SSE events")
  return streamSSE(
    c,
    async (stream) => {
      try {
        for await (const rawEvent of response as AsyncIterable<{
          data?: string
          event?: string
        }>) {
          if (!rawEvent.data) continue
          const forwardData = sanitiseSseDataIfPossible(rawEvent.data)
          await stream.writeSSE({
            event: rawEvent.event,
            data: forwardData,
          })
        }
      } catch (err) {
        // Upstream iterator threw mid-stream (TCP reset, 5xx after some events,
        // events() helper internal error). Forward a generic error event so
        // clients see the failure rather than an abruptly-closed stream.
        consola.error("Responses SSE iteration failed:", err)
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            type: "api_error",
            message: "Upstream stream interrupted",
          }),
        })
      }
    },
    async (err, stream) => {
      // streamSSE's outer onError fires when writeSSE itself rejects (e.g.,
      // client disconnected, downstream socket gone). NEVER surface `err.stack`
      // or `String(err)` here — on Bun those include absolute file paths and
      // node_modules internals that leak server topology to the client. The
      // detailed cause goes to consola; the wire only sees a fixed string.
      consola.error("Responses SSE outer error:", err)
      try {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            type: "api_error",
            message: "Stream write failed",
          }),
        })
      } catch {
        // Write also failed — connection is gone. Nothing more to do.
      }
    },
  )
}

/**
 * SSE events like `response.output_item.done` carry full item snapshots which
 * can contain `status: null` that upstream rejects on re-submission.  We
 * parse, sanitise the embedded item/output, and re-serialise.  Failures fall
 * through to the original verbatim string so a malformed chunk doesn't break
 * the stream.
 */
function sanitiseSseDataIfPossible(data: string): string {
  if (data === "[DONE]") return data
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    consola.debug("Responses SSE event:", (parsed as { type?: string }).type)
    if (parsed["item"]) {
      parsed["item"] = sanitiseOutputItem(
        parsed["item"] as Parameters<typeof sanitiseOutputItem>[0],
      )
    }
    if (Array.isArray(parsed["output"])) {
      parsed["output"] = (
        parsed["output"] as Array<Parameters<typeof sanitiseOutputItem>[0]>
      ).map((i) => sanitiseOutputItem(i))
    }
    return JSON.stringify(parsed)
  } catch {
    consola.warn(
      "Could not parse Responses SSE chunk for logging:",
      data.slice(0, 200),
    )
    return data
  }
}
