import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import { audit } from "~/services/audit"
import { countActiveAdminKeys, createKey } from "~/services/keys"

import { getConfig } from "./config-store"
import { PATHS } from "./paths"

export const ADMIN_KEY_FILE = path.join(PATHS.APP_DIR, "admin.key.txt")

/**
 * Returns true if the admin bootstrap file exists (operator hasn't read it yet).
 */
export function bootstrapFilePending(): boolean {
  return fs.existsSync(ADMIN_KEY_FILE)
}

/**
 * Run bootstrap: if auth is enabled and no admin keys exist, generate one.
 * Called during startup AFTER initDb() and BEFORE HTTP listener binds.
 *
 * Logic:
 * 1. If auth is disabled → no-op.
 * 2. If admin keys already exist in DB → warn if file still present, return.
 * 3. Otherwise → create first admin key and write to ADMIN_KEY_FILE.
 */
export function runBootstrap(): void {
  const { features } = getConfig()
  if (!features.auth) return // auth off — no bootstrap needed

  const adminCount = countActiveAdminKeys()

  if (adminCount > 0) {
    // Already bootstrapped. Remind operator to delete the key file if it lingers.
    if (bootstrapFilePending()) {
      consola.warn(
        `Admin key file still present at ${ADMIN_KEY_FILE}. Delete it after reading:\n`
          + `  rm ${ADMIN_KEY_FILE}`,
      )
    }
    return
  }

  // No active admin keys — generate the first one.
  // Ensure APP_DIR exists before writing key file.
  fs.mkdirSync(PATHS.APP_DIR, { recursive: true, mode: 0o700 })

  const { plain } = createKey({ tier: "admin", label: "bootstrap-admin" })

  // Write plaintext key with O_EXCL to prevent symlink/TOCTOU attacks.
  // If the file somehow already exists (race between two server starts),
  // the write fails — the first writer wins and the second exits cleanly.
  try {
    fs.writeFileSync(ADMIN_KEY_FILE, plain + "\n", { mode: 0o600, flag: "wx" })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EEXIST") {
      // Another instance won the race — its key is valid.
      consola.warn(
        `Bootstrap key file already exists at ${ADMIN_KEY_FILE} (parallel start?). Using existing file.`,
      )
      return
    }
    // Unexpected write failure: key is in DB but not on disk.
    // Surface the error so the operator can run `admin recover`.
    consola.error(
      `Admin key created in DB but file write failed. Run 'copilot-api admin recover' to retrieve it. Error: ${String(err)}`,
    )
    throw err
  }

  // Audit the bootstrap event after the key file is successfully written
  audit({
    actor_key_id: "__system__",
    actor_tier: "system",
    action: "auth.bootstrap",
    after: { label: "bootstrap-admin" },
  })

  // Output: full key on TTY; path-only on non-TTY (Docker/journald — avoid log capture)
  if (process.stdout.isTTY) {
    consola.success(`Admin key generated: ${plain}`)
    consola.info(`Also written to ${ADMIN_KEY_FILE} (delete after reading)`)
  } else {
    consola.info(
      `Admin key written to ${ADMIN_KEY_FILE}. Read it and delete the file before restarting.`,
    )
  }
}
