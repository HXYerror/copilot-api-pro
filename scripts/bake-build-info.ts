#!/usr/bin/env bun
/**
 * Bake commit identity into dist/build-info.json so installs via
 * `bunx github:...` (no .git in the install dir) can still show the
 * branch + commit + commit time in the admin top bar.
 *
 * Read by src/lib/build-identity.ts at runtime; falls back to live
 * `git rev-parse` when this file is absent (e.g. `bun src/main.ts`
 * from a checkout).
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

const here = import.meta.dirname
const repoRoot = path.resolve(here, "..")
const distDir = path.join(repoRoot, "dist")
const outPath = path.join(distDir, "build-info.json")

function git(args: Array<string>): string {
  const r = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 2000,
  })
  if (r.status !== 0) return ""
  return r.stdout.trim()
}

const pkg = JSON.parse(
  await fs.readFile(path.join(repoRoot, "package.json")),
) as { version: string }

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"])
const commit = git(["rev-parse", "--short", "HEAD"])
const commitTime = git(["log", "-1", "--format=%cI"])

// Refuse to clobber an existing build-info.json when git isn't available
// (bunx install from a tarball / tmp dir has no .git — `prepare` would
// otherwise overwrite the committed identity with empty fields and leave
// operators staring at "v0.8.0 ·up 31s" again).
if (!commit) {
  try {
    await fs.access(outPath)
    console.log(
      `[bake-build-info] no git available; keeping existing ${outPath}`,
    )
    process.exit(0)
  } catch {
    // No existing file either — fall through and write what we have.
  }
}

const info = {
  version: pkg.version,
  branch: branch || undefined,
  commit: commit || undefined,
  commit_time: commitTime || undefined,
}

await fs.mkdir(distDir, { recursive: true })
await fs.writeFile(outPath, JSON.stringify(info, null, 2) + "\n")
console.log(`[bake-build-info] wrote ${outPath}:`, info)
