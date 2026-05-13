#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import { purgeExpiredSessions } from "./admin/session"
import { logAuthModeBanner, resolveAuthMode } from "./lib/auth-mode"
import { runBootstrap } from "./lib/bootstrap"
import { getConfig, setRuntimeAuthOverride } from "./lib/config-store"
import { closeDb, getDb, initDb } from "./lib/db"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { setupCopilotToken, setupGitHubToken } from "./lib/token"
import { cacheModels } from "./lib/utils"
import { warnNoAuth } from "./middleware/auth"
import { server } from "./server"
import { audit, initAudit } from "./services/audit"
import { sweepExpiredDebugKeys } from "./services/debug-ttl-sweeper"
import { getCopilotChatVersion } from "./services/get-copilot-chat-version"
import { getVSCodeVersion } from "./services/get-vscode-version"

interface RunServerOptions {
  port: number
  host: string
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  noAuth: boolean
  acceptRisk: boolean
}

/** Apply CLI options to mutable state and kick off version fetches. */
async function applyOptions(options: RunServerOptions): Promise<void> {
  if (options.proxyEnv) initProxyFromEnv()

  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }
  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken

  await ensurePaths()
  ;[state.vsCodeVersion, state.copilotChatVersion] = await Promise.all([
    getVSCodeVersion(),
    getCopilotChatVersion(),
  ])
  consola.info(
    `VS Code: ${state.vsCodeVersion}  Copilot Chat: ${state.copilotChatVersion}`,
  )

  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
  } else {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheModels()
}

/** Start the session + debug-TTL background sweepers. */
function startPeriodicSweepers(): void {
  // Purge expired sessions on startup, then sweep hourly.
  purgeExpiredSessions()
  setInterval(
    () => {
      purgeExpiredSessions()
    },
    60 * 60 * 1000,
  )

  // Sweep expired debug keys on startup, then every 60 seconds.
  // The interval is purely a cleanup; correctness gates use isDebugActive(row).
  sweepExpiredDebugKeys()
  setInterval(() => {
    sweepExpiredDebugKeys()
  }, 60 * 1000)
}

/** Install SIGINT/SIGTERM handlers that flush the DB before exit. */
function installShutdownHandlers(): void {
  const shutdown = (code: number): void => {
    try {
      closeDb(getDb())
    } catch {
      // db was never initialized or already closed — safe to ignore
    }
    process.exit(code)
  }
  process.on("SIGINT", () => {
    shutdown(0)
  })
  process.on("SIGTERM", () => {
    shutdown(0)
  })
}

export async function runServer(options: RunServerOptions): Promise<void> {
  // Resolve auth mode FIRST — this throws before any side-effects if
  // --no-auth is requested on a non-loopback host without acknowledgement.
  const authMode = resolveAuthMode({
    noAuth: options.noAuth,
    acceptRisk: options.acceptRisk,
    host: options.host,
    port: options.port,
  })
  // The CLI flag wins over whatever is in config.json.
  setRuntimeAuthOverride(authMode.authEnabled)
  state.authModeLabel = authMode.label
  state.bindAddress = authMode.bindAddress

  await applyOptions(options)

  // Run DB migrations BEFORE binding HTTP listener (no schema race)
  initDb()

  // Initialize audit log — prunes old files beyond retention
  initAudit()

  logAuthModeBanner(authMode)
  warnNoAuth()

  // First-run admin bootstrap (no-op if auth disabled or keys exist)
  runBootstrap()

  startPeriodicSweepers()

  // Emit audit event when starting without authentication, with bind context.
  if (!getConfig().features.auth) {
    audit({
      actor_key_id: "__system__",
      actor_tier: "system",
      action: "server.start_no_auth",
      after: {
        bind_address: authMode.bindAddress,
        auth_mode: authMode.label,
      },
    })
  }

  installShutdownHandlers()

  consola.info(
    `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    invariant(state.models, "Models should be loaded by now")

    const selectedModel = await consola.prompt(
      "Select a model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const selectedSmallModel = await consola.prompt(
      "Select a small model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const command = generateEnvScript(
      {
        ANTHROPIC_BASE_URL: serverUrl,
        ANTHROPIC_AUTH_TOKEN: "dummy",
        ANTHROPIC_MODEL: selectedModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
        ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      "claude",
    )

    try {
      clipboard.writeSync(command)
      consola.success("Copied Claude Code command to clipboard!")
    } catch {
      consola.warn(
        "Failed to copy to clipboard. Here is the Claude Code command:",
      )
      consola.log(command)
    }
  }

  consola.box(
    `🌐 Usage Viewer: https://ericc-ch.github.io/copilot-api?endpoint=${serverUrl}/usage`,
  )

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
    hostname: options.host,
  })
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    host: {
      type: "string",
      default: "127.0.0.1",
      description:
        "Bind hostname. Default 127.0.0.1 (loopback only). Use 0.0.0.0 or :: to expose to LAN — requires auth or --i-accept-account-suspension-risk.",
    },
    "no-auth": {
      type: "boolean",
      default: false,
      description:
        "DISABLE authentication. Refused on non-loopback bind unless --i-accept-account-suspension-risk is also set.",
    },
    "i-accept-account-suspension-risk": {
      type: "boolean",
      default: false,
      description:
        "Acknowledge that running --no-auth on a non-loopback bind can burn Copilot quota and trigger GitHub abuse detection.",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    return runServer({
      port: Number.parseInt(args.port, 10),
      host: args.host,
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      noAuth: args["no-auth"],
      acceptRisk: args["i-accept-account-suspension-risk"],
    }).catch((err: unknown) => {
      // Auth-mode safety guard throws before any side-effects; surface the
      // message in red and exit with status 2 (distinguishes from other errors).
      consola.error(`\x1B[31m${String(err)}\x1B[0m`)
      process.exit(2)
    })
  },
})
