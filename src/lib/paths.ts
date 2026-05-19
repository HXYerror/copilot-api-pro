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

// This fork ("copilot-api-pro") uses its OWN data directory so it doesn't
// clobber data files written by upstream ericc-ch/copilot-api running on the
// same machine. Old data in `~/.local/share/copilot-api/` is ignored —
// re-run `auth` to log in fresh.
const APP_DIR = path.join(XDG_DATA_HOME, "copilot-api-pro")

const GITHUB_TOKEN_PATH = path.join(APP_DIR, "github_token")

const CONFIG_PATH = path.join(APP_DIR, "config.json")

const DB_PATH = path.join(APP_DIR, "copilot-api.db")

const TRACES_DIR = path.join(APP_DIR, "traces")

// Persistent log of beta flags upstream rejected at runtime. One flag per
// line, ASCII-only. The Anthropic-passthrough service appends to this file
// when it auto-learns a new unsupported flag; subsequent process restarts
// read it to skip flagging-from-cold-start.
//
// Why a separate file (not config.json): operators don't *configure* this;
// it's an observability artefact. Living next to `traces/` keeps the
// "ops byproduct" semantics clear.
const LEARNED_BETA_PATH = path.join(APP_DIR, "learned-unsupported-beta.txt")

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  CONFIG_PATH,
  DB_PATH,
  TRACES_DIR,
  LEARNED_BETA_PATH,
}

export function configPath(): string {
  return CONFIG_PATH
}

export function dbPath(): string {
  return DB_PATH
}

/**
 * Per-day trace JSONL files live here. The directory is created lazily by
 * the trace-writer with mode 0o700 (this matches the parent APP_DIR
 * permissions) so test environments that never write a trace don't
 * accidentally create the directory just by importing this module.
 */
export function tracesDir(): string {
  return TRACES_DIR
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
