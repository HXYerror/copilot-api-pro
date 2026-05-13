import { Hono } from "hono"

import type { TelemetryVar } from "~/middleware/telemetry"

import { forwardError } from "~/lib/error"

import { handleCompletion } from "./handler"

export const completionRoutes = new Hono<{ Variables: TelemetryVar }>()

completionRoutes.post("/", async (c) => {
  try {
    return await handleCompletion(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
