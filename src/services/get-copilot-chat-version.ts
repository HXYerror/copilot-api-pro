import consola from "consola"

import { VERSION_CACHE_TTL_MS, type VersionCache } from "./version-cache"

/**
 * Hard-coded fallback used when both the Marketplace API and the
 * vscode-copilot-release GitHub releases are unreachable.
 *
 * Bump this periodically. Last bumped 2026-05-19 based on Marketplace
 * extension query returning 0.48.1 for GitHub.copilot-chat.
 */
export const FALLBACK = "0.48.1"

let cache: VersionCache | undefined

async function fetchFromMarketplace(): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)

  try {
    const response = await fetch(
      "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json;api-version=3.0-preview.1",
        },
        body: JSON.stringify({
          filters: [
            {
              criteria: [{ filterType: 7, value: "GitHub.copilot-chat" }],
            },
          ],
          flags: 529,
        }),
        signal: controller.signal,
      },
    )

    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
    const data = (await response.json()) as any
    const parsed: unknown =
      data?.results?.[0]?.extensions?.[0]?.versions?.[0]?.version
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

    if (typeof parsed !== "string" || !parsed) {
      throw new Error("Unexpected response shape")
    }

    return parsed
  } finally {
    clearTimeout(timeout)
  }
}

export async function getCopilotChatVersion(): Promise<string> {
  if (cache && Date.now() - cache.fetchedAt < VERSION_CACHE_TTL_MS) {
    return cache.version
  }

  let fetched: string | null = null

  try {
    fetched = await fetchFromMarketplace()
  } catch {
    consola.warn(
      "Failed to fetch Copilot Chat version from Marketplace, using fallback",
    )
  }

  // Validate format. Same bug class as get-vscode-version: previously we
  // checked `version !== FALLBACK` to choose between cache/warn paths, so
  // when Marketplace returned exactly the fallback string we'd falsely
  // warn about "invalid format". Decide based on regex validity instead.
  const isValid = fetched !== null && /^\d+\.\d+\.\d+$/.test(fetched)
  const version = isValid ? fetched : FALLBACK

  if (isValid) {
    // eslint-disable-next-line require-atomic-updates
    cache = { version, fetchedAt: Date.now() }
  } else if (fetched !== null) {
    const safeVersion = fetched.slice(0, 40).replaceAll(/[^\x20-\x7E]/g, "?")
    consola.warn(
      `Invalid version format received: ${safeVersion}, using fallback`,
    )
  }

  return version
}
