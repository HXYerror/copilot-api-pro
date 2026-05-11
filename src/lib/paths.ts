import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// XDG Base Directory spec requires XDG_DATA_HOME to be an absolute path.
// Reject relative values to prevent directory traversal when the env var is
// set by an unprivileged caller (e.g. `XDG_DATA_HOME=../../etc`).
function resolveXdgDataHome(): string {
  const xdg = process.env.XDG_DATA_HOME
  if (xdg !== undefined && path.isAbsolute(xdg)) return xdg
  return path.join(os.homedir(), ".local", "share")
}

const XDG_DATA_HOME = resolveXdgDataHome()

const APP_DIR = path.join(XDG_DATA_HOME, "copilot-api")

const GITHUB_TOKEN_PATH = path.join(APP_DIR, "github_token")

const CONFIG_PATH = path.join(APP_DIR, "config.json")

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  CONFIG_PATH,
}

export function configPath(): string {
  return CONFIG_PATH
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}
