import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { state } from "~/lib/state"
import {
  createResponses,
  type UpstreamCaptureFn,
} from "~/services/copilot/create-responses"

import type { ResponsesPayload, ResponsesResponse } from "./types"

import { sanitiseOutputItem, sanitiseResponsesOutput } from "./translation"

export async function handleResponses(c: Context): Promise<Response> {
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

  if (state.manualApprove) {
    await awaitApproval()
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
    return c.json(sanitised)
  }

  // Streaming: proxy SSE events verbatim (same pattern as native Anthropic pass-through)
  consola.debug("Responses streaming response — proxying SSE events")
  return streamSSE(
    c,
    async (stream) => {
      for await (const rawEvent of response as AsyncIterable<{
        data?: string
        event?: string
      }>) {
        if (!rawEvent.data) continue

        // Sanitise status:null from embedded output items before forwarding.
        // SSE events like response.output_item.done carry full item snapshots
        // which can contain null status fields rejected by upstream on re-submission.
        let forwardData = rawEvent.data
        if (rawEvent.data !== "[DONE]") {
          try {
            const parsed = JSON.parse(rawEvent.data) as Record<string, unknown>
            consola.debug(
              "Responses SSE event:",
              (parsed as { type?: string }).type,
            )
            // Sanitise embedded item or output array
            if (parsed["item"]) {
              parsed["item"] = sanitiseOutputItem(
                parsed["item"] as Parameters<typeof sanitiseOutputItem>[0],
              )
            }
            if (Array.isArray(parsed["output"])) {
              parsed["output"] = (
                parsed["output"] as Array<
                  Parameters<typeof sanitiseOutputItem>[0]
                >
              ).map((i) => sanitiseOutputItem(i))
            }
            forwardData = JSON.stringify(parsed)
          } catch {
            // [DONE] sentinel or truly malformed chunk
            if (rawEvent.data !== "[DONE]") {
              consola.warn(
                "Could not parse Responses SSE chunk for logging:",
                rawEvent.data.slice(0, 200),
              )
            }
          }
        }

        await stream.writeSSE({
          event: rawEvent.event,
          data: forwardData,
        })
      }
    },
    async (err, stream) => {
      consola.error("Responses SSE stream error:", err)
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: String(err) }),
      })
    },
  )
}
