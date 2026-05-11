import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import { countActiveAdminKeys, createKey, hashKey } from "~/services/keys"

import { getConfig } from "./config-store"
import { PATHS } from "./paths"

const ADMIN_KEY_FILE = path.join(PATHS.APP_DIR, "admin.key.txt")

/**
 * Returns true if the admin bootstrap file exists (operator hasn't read it yet).
 */
export function bootstrapFilePending(): boolean {
  return fs.existsSync(ADMIN_KEY_FILE)
}

/**
 * Run bootstrap: if auth is enabled and no admin keys exist, generate one.
 * Called during startup AFTER initDb() and BEFORE HTTP listener binds.
 */
export function runBootstrap(): void {
  const { features } = getConfig()
  if (!features.auth) return // auth off — no bootstrap needed

  if (bootstrapFilePending()) {
    // Bootstrap file still exists — operator must read and delete it first
    consola.error(
      `Startup blocked: admin bootstrap file exists at ${ADMIN_KEY_FILE}.\n`
        + `Please read your admin key and delete this file before restarting:\n`
        + `  cat ${ADMIN_KEY_FILE} && rm ${ADMIN_KEY_FILE}`,
    )
    process.exit(1)
  }

  const adminCount = countActiveAdminKeys()
  if (adminCount > 0) return // admin keys exist — no bootstrap needed

  // Generate first admin key
  const { plain } = createKey({ tier: "admin", label: "bootstrap-admin" })
  const sha256prefix = hashKey(plain).slice(0, 8)

  // Write plaintext to file with mode 0600
  fs.mkdirSync(PATHS.APP_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(ADMIN_KEY_FILE, plain + "\n", { mode: 0o600 })

  // Output to stdout: full key only on TTY, path+hash on non-TTY (Docker/journald)
  const isTty = process.stdout.isTTY
  if (isTty) {
    consola.success(`Admin key generated: ${plain}`)
    consola.info(`Also written to ${ADMIN_KEY_FILE} (delete after reading)`)
  } else {
    consola.info(
      `Admin key written to ${ADMIN_KEY_FILE} (sha256:${sha256prefix}…). Read & delete this file.`,
    )
  }
}
