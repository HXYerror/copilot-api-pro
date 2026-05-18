import react from "@vitejs/plugin-react"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Build the SPA into ../dist/ui so the hono server can serve it from a
// stable path regardless of whether we're running from `dist/main.js`
// (after `bun run build`) or `src/main.ts` (dev). The server's static
// handler resolves `dist/ui/...` relative to the repo root in both cases.
export default defineConfig({
  plugins: [react()],
  base: "/admin/_app/",
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // Keep the bundle small and predictable — one app chunk plus
        // a separate vendor chunk for react + tremor so cache invalidates
        // less aggressively when only app code changes.
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          tremor: ["@tremor/react"],
          query: ["@tanstack/react-query"],
        },
      },
    },
  },
})
