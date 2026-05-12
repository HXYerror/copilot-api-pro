import { defineCommand } from "citty"
import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import { initDb } from "~/lib/db"
import { PATHS } from "~/lib/paths"
import { countActiveAdminKeys, createKey } from "~/services/keys"

const ADMIN_KEY_FILE_RECOVER = path.join(PATHS.APP_DIR, "admin.key.txt")

export const adminRecover = defineCommand({
  meta: {
    name: "recover",
    description:
      "Mint a new admin key (requires local data-dir access as proof of operator identity)",
  },
  args: {
    force: {
      type: "boolean",
      description: "Create a new admin key even if active admin keys exist",
      default: false,
    },
  },
  run({ args }) {
    // Proof of operator identity: must be able to stat the data directory
    try {
      fs.statSync(PATHS.APP_DIR)
    } catch {
      consola.error(
        `Cannot access data directory ${PATHS.APP_DIR}. Are you running as the correct user?`,
      )
      process.exit(1)
    }

    // Init DB (runs migrations) — needed if invoked independently
    initDb()

    // Guard: warn if active admin keys already exist unless --force is set
    const existing = countActiveAdminKeys()
    if (existing > 0 && !args.force) {
      consola.warn(
        `${existing} active admin key(s) already exist. Pass --force to create a new one anyway.`,
      )
      process.exit(1)
    }

    // Guard: refuse to overwrite an unread key file
    if (fs.existsSync(ADMIN_KEY_FILE_RECOVER)) {
      consola.error(
        `${ADMIN_KEY_FILE_RECOVER} already exists. Read and delete it first:\n`
          + `  cat ${ADMIN_KEY_FILE_RECOVER} && rm ${ADMIN_KEY_FILE_RECOVER}`,
      )
      process.exit(1)
    }

    const { plain } = createKey({ tier: "admin", label: "recovery-admin" })

    // O_EXCL prevents symlink attacks and clobber on race
    try {
      fs.writeFileSync(ADMIN_KEY_FILE_RECOVER, plain + "\n", {
        mode: 0o600,
        flag: "wx",
      })
    } catch (err) {
      consola.error(`Failed to write recovery key file: ${String(err)}`)
      process.exit(1)
    }

    // Mirror bootstrap.ts: full key on TTY only — avoid log capture on non-TTY
    if (process.stdout.isTTY) {
      consola.success(`Recovery admin key generated: ${plain}`)
    } else {
      consola.info(
        `Recovery admin key written to ${ADMIN_KEY_FILE_RECOVER}. Read and delete the file.`,
      )
    }
    consola.info(`Also written to ${ADMIN_KEY_FILE_RECOVER}`)
  },
})

// Re-export the canonical file path so callers don't duplicate the join

export { ADMIN_KEY_FILE } from "~/lib/bootstrap"
