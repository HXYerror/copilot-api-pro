/**
 * Read build identity (package version + git branch + short SHA + commit
 * time + server start time) once at startup so the admin UI can show
 * "what's running" in the top bar.
 *
 * Robust to running both from source (`bun src/main.ts` → cwd-walk up from
 * src/lib/) and from the bundled binary (`bun dist/main.js` → cwd-walk up
 * from dist/). Falls back gracefully when run from a tarball with no .git
 * dir or when git isn't on PATH — the missing fields are just omitted.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

export interface BuildIdentity {
  version: string
  branch?: string
  commit?: string
  commit_time?: string
  started_at: number
}

let cached: BuildIdentity | null = null
let inflight: Promise<BuildIdentity> | null = null
const STARTED_AT = Date.now()

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

/**
 * Walk upward from the bundled / source file location until we find a
 * package.json. Handles both layouts in one shot.
 */
async function findRepoRoot(): Promise<string | null> {
  let dir = path.dirname(new URL(import.meta.url).pathname)
  for (let i = 0; i < 6; i++) {
    try {
      await fs.access(path.join(dir, "package.json"))
      return dir
    } catch {
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }
  return null
}

async function computeBuildIdentity(): Promise<BuildIdentity> {
  const repoRoot = await findRepoRoot()
  let version = "unknown"
  if (repoRoot) {
    try {
      const pkg = JSON.parse(
        await fs.readFile(path.join(repoRoot, "package.json")),
      ) as { version: string }
      version = pkg.version
    } catch {
      // leave as "unknown"
    }
  }

  // git — best effort; only run when we found a repo root.
  let branch: string | null = null
  let commit: string | null = null
  let commitTime: string | null = null
  if (repoRoot) {
    branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)
    commit = runGit(["rev-parse", "--short", "HEAD"], repoRoot)
    commitTime = runGit(["log", "-1", "--format=%cI"], repoRoot)
  }

  return {
    version,
    branch: branch || undefined,
    commit: commit || undefined,
    commit_time: commitTime || undefined,
    started_at: STARTED_AT,
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
