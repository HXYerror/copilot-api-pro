import consola from "consola"

import { VERSION_CACHE_TTL_MS, type VersionCache } from "./version-cache"

/**
 * Hard-coded fallback used when both the official VSCode update API and the
 * AUR PKGBUILD mirror are unreachable (offline / firewall / DNS issue).
 *
 * Bump this periodically — Copilot's upstream is lenient about
 * `editor-version` header values but a wildly stale string could in theory
 * trip future anti-abuse heuristics. Last bumped 2026-05-19 based on
 * `update.code.visualstudio.com/api/releases/stable` returning 1.120.0.
 */
export const FALLBACK = "1.120.0"

let cache: VersionCache | undefined

async function fetchFromOfficialApi(): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)

  try {
    const response = await fetch(
      "https://update.code.visualstudio.com/api/releases/stable",
      { signal: controller.signal },
    )

    const versions = (await response.json()) as Array<string>

    if (Array.isArray(versions) && versions.length > 0 && versions[0]) {
      return versions[0]
    }

    throw new Error("Unexpected response shape")
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchFromAur(): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)

  try {
    const response = await fetch(
      "https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=visual-studio-code-bin",
      { signal: controller.signal },
    )

    const pkgbuild = await response.text()
    const match = pkgbuild.match(/pkgver=(\d+\.\d+\.\d+)/)

    if (match?.[1]) {
      return match[1]
    }

    throw new Error("Version not found in PKGBUILD")
  } finally {
    clearTimeout(timeout)
  }
}

export async function getVSCodeVersion(): Promise<string> {
  if (cache && Date.now() - cache.fetchedAt < VERSION_CACHE_TTL_MS) {
    return cache.version
  }

  let fetched: string | null = null

  try {
    fetched = await fetchFromOfficialApi()
  } catch {
    try {
      fetched = await fetchFromAur()
    } catch {
      consola.warn(
        "Failed to fetch VS Code version from all sources, using fallback",
      )
    }
  }

  const version =
    fetched !== null && /^\d+\.\d+\.\d+$/.test(fetched) ? fetched : FALLBACK

  if (fetched !== null && version !== FALLBACK) {
    // eslint-disable-next-line require-atomic-updates
    cache = { version, fetchedAt: Date.now() }
  } else if (fetched !== null) {
    // Format validation rejected the fetched value
    const safeVersion = fetched.slice(0, 40).replaceAll(/[^\x20-\x7E]/g, "?")
    consola.warn(
      `Invalid version format received: ${safeVersion}, using fallback`,
    )
  }

  return version
}
