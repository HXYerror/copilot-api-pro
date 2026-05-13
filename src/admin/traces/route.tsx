/** @jsxImportSource hono/jsx */
import consola from "consola"
import { Hono } from "hono"
import fs from "node:fs"
import path from "node:path"

import { tracesDir } from "~/lib/paths"
import { subscribe } from "~/services/trace-broadcaster"

import type { SessionVar } from "../session-middleware"

import { ADMIN_SECURITY_HEADERS, Layout } from "../layout"

// ---------------------------------------------------------------------------
// Sub-app: /admin/traces
// ---------------------------------------------------------------------------

const tracesApp = new Hono<{ Variables: SessionVar }>()

// Security headers applied to every response from this sub-app (matches
// the other admin sub-apps).
tracesApp.use("*", async (c, next) => {
  await next()
  for (const [k, v] of Object.entries(ADMIN_SECURITY_HEADERS)) {
    c.header(k, v)
  }
})

// ---------------------------------------------------------------------------
// GET /admin/traces — live tail page
// ---------------------------------------------------------------------------

tracesApp.get("/", (c) => {
  const session = c.get("session")
  return c.html(
    <Layout title="Traces" active="traces" csrfToken={session.csrf_token}>
      <h1>Debug capture — live tail</h1>
      <p class="text-muted">
        Streaming redacted trace events from /admin/traces/stream. Capture is
        only active for keys with debug mode enabled (see{" "}
        <a href="/admin/keys">Keys</a>).
      </p>
      <pre id="trace-log" class="trace-log" aria-live="polite" />
      <script src="/admin/assets/traces.js" />
    </Layout>,
  )
})

// ---------------------------------------------------------------------------
// GET /admin/traces/stream — SSE live tail
//
// Per-SSE niceties:
//   - Content-Type: text/event-stream
//   - X-Accel-Buffering: no (disable nginx response buffering if proxied)
//   - Cache-Control: no-store
// ---------------------------------------------------------------------------

tracesApp.get("/stream", (c) => {
  const lastEventIdHeader = c.req.header("last-event-id")
  let lastEventId: number | undefined
  if (lastEventIdHeader !== undefined) {
    const n = Number.parseInt(lastEventIdHeader, 10)
    if (Number.isFinite(n) && n >= 0) lastEventId = n
  }

  const result = subscribe({ lastEventId })
  if (!result.ok) {
    return c.json(
      {
        error: "Too many concurrent SSE subscribers; try again later",
      },
      503,
    )
  }
  return c.body(result.stream, 200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  })
})

// ---------------------------------------------------------------------------
// GET /admin/traces/:date.jsonl — file download
//
// :date is matched by Hono's path param; the regex below enforces the exact
// YYYY-MM-DD shape so we never path-traverse, and we double-check the
// resolved path is inside tracesDir() before opening it.
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

tracesApp.get("/:filename", (c) => {
  const filename = c.req.param("filename")
  // Filename must match exactly "YYYY-MM-DD.jsonl" — no slashes, no dots
  // beyond the extension, no URL-encoded traversal segments (Hono
  // percent-decodes path params, so `%2F` arrives as `/` and fails the
  // regex below; `%2E` arrives as `.` and fails the dot count).
  const ext = ".jsonl"
  if (!filename.endsWith(ext)) return c.text("Not Found", 404)
  const date = filename.slice(0, -ext.length)
  if (!DATE_RE.test(date)) return c.text("Bad Request", 400)

  const base = tracesDir()
  const fullPath = path.join(base, `traces-${date}.jsonl`)
  // Defence-in-depth even though the regex above forbids traversal: ensure
  // the resolved path is strictly inside the traces directory.
  if (!fullPath.startsWith(base + path.sep)) {
    consola.warn(`[admin/traces] rejected path-traversal attempt: ${filename}`)
    return c.text("Bad Request", 400)
  }

  let content: string
  try {
    content = fs.readFileSync(fullPath, "utf8")
  } catch {
    return c.text("Not Found", 404)
  }

  return c.body(content, 200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Content-Disposition": `attachment; filename="traces-${date}.jsonl"`,
    "Cache-Control": "no-store",
  })
})

export { tracesApp }
