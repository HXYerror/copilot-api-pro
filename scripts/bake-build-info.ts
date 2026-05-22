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

const info = {
  version: pkg.version,
  branch: git(["rev-parse", "--abbrev-ref", "HEAD"]) || undefined,
  commit: git(["rev-parse", "--short", "HEAD"]) || undefined,
  commit_time: git(["log", "-1", "--format=%cI"]) || undefined,
}

await fs.mkdir(distDir, { recursive: true })
await fs.writeFile(outPath, JSON.stringify(info, null, 2) + "\n")
console.log(`[bake-build-info] wrote ${outPath}:`, info)
