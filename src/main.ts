#!/usr/bin/env node

import { defineCommand, runMain } from "citty"

import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { adminRecover } from "./cli/admin-recover"
import { debug } from "./debug"
import { start } from "./start"

const admin = defineCommand({
  meta: {
    name: "admin",
    description: "Admin management commands",
  },
  subCommands: { recover: adminRecover },
})

const main = defineCommand({
  meta: {
    name: "copilot-api-pro",
    description:
      "GitHub Copilot proxy with an admin WebUI, per-key debug capture, telemetry, and audit logging. Fork of ericc-ch/copilot-api.",
  },
  subCommands: { auth, start, "check-usage": checkUsage, debug, admin },
})

await runMain(main)
