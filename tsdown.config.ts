import { defineConfig } from "tsdown"
import fs from "node:fs"
import path from "node:path"

export default defineConfig({
  entry: ["src/main.ts"],

  format: ["esm"],
  target: "es2022",
  // We target Bun, not Node — the proxy uses `bun:sqlite` and other Bun
  // built-ins. The hooks below rewrite the default `#!/usr/bin/env node`
  // shebang to `#!/usr/bin/env bun` so `npx copilot-api` / direct
  // invocation runs on the Bun runtime.
  platform: "node",

  sourcemap: true,
  clean: true,
  removeNodeProtocol: false,

  env: {
    NODE_ENV: "production",
  },

  hooks: {
    "build:done": (ctx) => {
      const outDir = ctx?.options?.outDir ?? "dist"

      // 1. Patch shebang to bun
      const entry = path.join(outDir, "main.js")
      try {
        const raw = fs.readFileSync(entry, "utf8")
        if (raw.startsWith("#!/usr/bin/env node")) {
          fs.writeFileSync(
            entry,
            raw.replace(/^#![^\n]*\n/, "#!/usr/bin/env bun\n"),
          )
        }
        fs.chmodSync(entry, 0o755)
      } catch {
        /* ignore — entry may be elsewhere depending on tsdown version */
      }

      // 2. Copy migration SQL files. The runtime resolves them relative to
      //    `import.meta.dirname` (which is `dist/lib/` in source, but bundles
      //    inline to `dist/`), expecting `dist/migrations/*.sql`. tsdown
      //    won't copy non-JS assets, so we do it here.
      const srcMigrations = "src/lib/migrations"
      const dstMigrations = path.join(outDir, "migrations")
      try {
        fs.mkdirSync(dstMigrations, { recursive: true })
        for (const f of fs.readdirSync(srcMigrations)) {
          if (f.endsWith(".sql")) {
            fs.copyFileSync(
              path.join(srcMigrations, f),
              path.join(dstMigrations, f),
            )
          }
        }
      } catch (err) {
        console.warn(`[tsdown] migration copy failed: ${String(err)}`)
      }
    },
  },
})
