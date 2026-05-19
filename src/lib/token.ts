import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

/**
 * Handle for the Copilot-token refresh timer. Stored module-level so the
 * shutdown hook in start.ts can stop it cleanly, AND so a re-entry into
 * setupCopilotToken (e.g. from tests) doesn't leak a previous interval.
 */
let copilotTokenRefreshTimer: ReturnType<typeof setInterval> | undefined

/** Cancel handle for stopCopilotTokenRefresh(). */
export function stopCopilotTokenRefresh(): void {
  if (copilotTokenRefreshTimer !== undefined) {
    clearInterval(copilotTokenRefreshTimer)
    copilotTokenRefreshTimer = undefined
  }
}

export const setupCopilotToken = async () => {
  const { token, refresh_in } = await getCopilotToken()
  state.copilotToken = token

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", token)
  }

  // Defence in depth: if setupCopilotToken is called twice (test re-init,
  // future hot-reauth path, etc.) we MUST drop the previous interval or
  // we'd quietly stack refresh timers that all hit the GitHub token
  // endpoint in parallel.
  stopCopilotTokenRefresh()

  const refreshInterval = (refresh_in - 60) * 1000
  copilotTokenRefreshTimer = setInterval(() => {
    consola.debug("Refreshing Copilot token")
    // CRITICAL: do NOT `throw` from inside a setInterval async callback —
    // there is no one to await the resulting rejected Promise, so it lands
    // as an unhandledRejection. Bun will, in strict-mode / user-configured
    // unhandledRejection handlers, crash the entire server. A refresh
    // failure here is recoverable: state.copilotToken keeps its current
    // value until it actually expires, at which point the next request
    // surfaces a 401 → operator re-runs auth. Losing the *next* refresh
    // attempt is strictly less bad than killing the process.
    void (async () => {
      try {
        const { token: refreshed } = await getCopilotToken()
        state.copilotToken = refreshed
        consola.debug("Copilot token refreshed")
        if (state.showToken) {
          consola.info("Refreshed Copilot token:", refreshed)
        }
      } catch (error) {
        consola.error(
          "Failed to refresh Copilot token (continuing with existing token until next attempt):",
          error,
        )
      }
    })()
  }, refreshInterval)
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      await logUser()

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}
