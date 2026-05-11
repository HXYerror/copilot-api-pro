import { defineCommand } from "citty"
import consola from "consola"
import fs from "node:fs"

import { initDb } from "~/lib/db"
import { PATHS } from "~/lib/paths"
import { createKey } from "~/services/keys"

const ADMIN_KEY_FILE_RECOVER = `${PATHS.APP_DIR}/admin.key.txt`

export const adminRecover = defineCommand({
  meta: {
    name: "recover",
    description:
      "Mint a new admin key (requires local data-dir access as proof of operator identity)",
  },
  run() {
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

    const { plain } = createKey({ tier: "admin", label: "recovery-admin" })

    // Write to file and print
    fs.writeFileSync(ADMIN_KEY_FILE_RECOVER, plain + "\n", { mode: 0o600 })
    consola.success(`Recovery admin key generated: ${plain}`)
    consola.info(`Also written to ${ADMIN_KEY_FILE_RECOVER}`)
  },
})
