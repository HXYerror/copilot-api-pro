/**
 * Read build identity (package version + git branch + short SHA) once at
 * startup so the admin UI can show "what's running" in the top bar.
 *
 * Cached on first call. Falls back gracefully when run from a tarball
 * (no .git directory) or when git isn't on PATH — fields just become
 * undefined and the UI hides the missing pieces.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

export interface BuildIdentity {
  version: string
  branch?: string
  commit?: string
}

let cached: BuildIdentity | null = null
let inflight: Promise<BuildIdentity> | null = null

export async function getBuildIdentity(): Promise<BuildIdentity> {
  if (cached) return cached
  if (inflight) return inflight
  inflight = computeBuildIdentity().then((id) => {
    cached = id
    inflight = null
    return id
  })
  return inflight
}

async function computeBuildIdentity(): Promise<BuildIdentity> {
  // package.json — alongside the entry script when running from source
  // (../package.json from src/) and bundled to the same dir for dist builds.
  let version = "unknown"
  try {
    const pkgPath = new URL("../../package.json", import.meta.url).pathname
    const pkg = JSON.parse(await fs.readFile(pkgPath)) as {
      version: string
    }
    version = pkg.version
  } catch {
    // Try one level up for the dist layout
    try {
      const pkgPath = new URL("../package.json", import.meta.url).pathname
      const pkg = JSON.parse(await fs.readFile(pkgPath)) as {
        version: string
      }
      version = pkg.version
    } catch {
      // leave as "unknown"
    }
  }

  // git — best effort. Run with cwd = the repo root so it works whether
  // we're invoked from a bundled dist/ or directly from source.
  const repoRoot = path.resolve(
    new URL(".", import.meta.url).pathname,
    "..",
    "..",
  )
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)
  const commit = runGit(["rev-parse", "--short", "HEAD"], repoRoot)

  return {
    version,
    branch: branch || undefined,
    commit: commit || undefined,
  }
}

function runGit(args: Array<string>, cwd: string): string | null {
  try {
    const res = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 1000,
    })
    if (res.status !== 0) return null
    return res.stdout.trim() || null
  } catch {
    return null
  }
}
