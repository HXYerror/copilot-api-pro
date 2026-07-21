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

// ---------------------------------------------------------------------------
// Refresh with retry + explicit backoff schedule.
//
// GitHub's Copilot token endpoint occasionally 5xx's or times out under load.
// The previous implementation tried once, logged, and gave up — leaving
// state.copilotToken stale for another full ~29 min until the next interval
// tick. Every request served in the meantime would 401 from upstream, which
// the proxy surfaces as a 500 storm to clients.
//
// New behaviour: up to 11 attempts per tick following the explicit delay
// schedule in BACKOFF_DELAYS_MS below (1s, 10s, 30s, 60s, 60s, 120s, 120s,
// 180s, 240s, 300s between attempts). Total worst-case wall time is
// ~18.7 minutes, deliberately kept under the 29-min refresh interval so
// overlapping ticks can't happen in the normal case. If all attempts fail
// we log a loud error and preserve the stale token — same recover-on-next-
// tick behaviour as before, but only after we've genuinely tried to save
// the day. An overlap guard coalesces the (rare) case where a previous
// refresh is still retrying when the next interval fires.
// ---------------------------------------------------------------------------

// Explicit schedule of delays (in ms) between successive attempts. Entry i
// is the wait AFTER attempt (i+1) fails, before attempt (i+2) starts. Total
// attempts = BACKOFF_DELAYS_MS.length + 1 (first attempt has no wait before it).
// Sum ≈ 18.7 minutes, deliberately kept under the ~29-min refresh interval so
// a still-running retry can't collide with the next scheduled tick.
const BACKOFF_DELAYS_MS: ReadonlyArray<number> = [
  1_000, // after attempt 1 → attempt 2
  10_000, // after 2 → 3
  30_000, // after 3 → 4
  60_000, // after 4 → 5
  60_000, // after 5 → 6
  120_000, // after 6 → 7
  120_000, // after 7 → 8
  180_000, // after 8 → 9
  240_000, // after 9 → 10
  300_000, // after 10 → 11
]
const REFRESH_MAX_ATTEMPTS = BACKOFF_DELAYS_MS.length + 1

// In-flight refresh, if any. Using a Promise as the mutex (instead of a
// boolean flag + `await`) keeps the check-and-set synchronous — no race
// between reading the flag and setting it while a microtask hops in.
let inflightRefresh: Promise<void> | null = null

function refreshCopilotTokenWithRetry(): Promise<void> {
  if (inflightRefresh) {
    consola.warn(
      "[copilot-token] previous refresh still running — coalescing with existing",
    )
    return inflightRefresh
  }
  const p = runRefreshLoop().finally(() => {
    inflightRefresh = null
  })
  inflightRefresh = p
  return p
}

async function runRefreshLoop(): Promise<void> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt++) {
    try {
      const { token: refreshed } = await getCopilotToken()
      state.copilotToken = refreshed
      if (attempt === 1) {
        consola.debug("Copilot token refreshed")
      } else {
        consola.info(
          `[copilot-token] refreshed on attempt ${attempt}/${REFRESH_MAX_ATTEMPTS}`,
        )
      }
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", refreshed)
      }
      return
    } catch (err) {
      lastErr = err
      if (attempt >= REFRESH_MAX_ATTEMPTS) break
      // Explicit schedule lookup (not exponential formula) so the sequence
      // is easy to reason about and tune without doing 2^n arithmetic.
      const delayMs = BACKOFF_DELAYS_MS[attempt - 1] ?? 60_000
      consola.warn(
        `[copilot-token] refresh attempt ${attempt}/${REFRESH_MAX_ATTEMPTS} failed, `
          + `retrying in ${delayMs}ms: ${String(err)}`,
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  consola.error(
    `[copilot-token] refresh failed after ${REFRESH_MAX_ATTEMPTS} attempts — `
      + `continuing with stale token, next scheduled tick will try again. `
      + `Last error: ${String(lastErr)}`,
  )
}

/**
 * Test-only handle for the retry-with-backoff path. Production code always
 * enters via the setInterval-scheduled tick inside setupCopilotToken.
 */
export const _refreshCopilotTokenWithRetry_TEST_ONLY =
  refreshCopilotTokenWithRetry

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
    // unhandledRejection handlers, crash the entire server. The retry
    // helper catches everything internally and never throws.
    void refreshCopilotTokenWithRetry()
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
