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

/**
 * Wrap a Node Readable into a Web ReadableStream so Hono can pipe it back
 * without blocking the event loop. fs.createReadStream streams bytes in
 * 64 KB chunks and respects backpressure via `pause()`/`resume()` which the
 * adapter triggers from the ReadableStream pull/cancel callbacks.
 */
function nodeStreamToWeb(filePath: string): ReadableStream<Uint8Array> {
  const nodeStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 })
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer | string) => {
        const bytes =
          typeof chunk === "string" ?
            new TextEncoder().encode(chunk)
          : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        controller.enqueue(bytes)
        if ((controller.desiredSize ?? 0) <= 0) nodeStream.pause()
      })
      nodeStream.on("end", () => {
        controller.close()
      })
      nodeStream.on("error", (err) => {
        controller.error(err)
      })
    },
    pull() {
      nodeStream.resume()
    },
    cancel(reason) {
      consola.debug(
        `[admin/traces] download cancelled: ${String(reason ?? "client_disconnect")}`,
      )
      nodeStream.destroy()
    },
  })
}

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
  const baseWithSep = base + path.sep
  const fullPath = path.join(base, `traces-${date}.jsonl`)

  // Lexical guard: path.join can't produce a path that escapes `base` once
  // the regex has stripped slashes from `date`, but keep the check as a
  // belt for future refactors.
  if (!fullPath.startsWith(baseWithSep)) {
    consola.warn(`[admin/traces] rejected path-traversal attempt: ${filename}`)
    return c.text("Bad Request", 400)
  }

  // Defence-in-depth: a symlink at `traces/traces-YYYY-MM-DD.jsonl` could
  // point outside the traces dir (e.g., -> /etc/passwd). The lexical check
  // above doesn't follow symlinks; resolve and re-check.
  let resolved: string
  try {
    resolved = fs.realpathSync.native(fullPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return c.text("Not Found", 404)
    consola.warn(
      `[admin/traces] realpath failed for ${filename}: ${String(err)}`,
    )
    return c.text("Bad Request", 400)
  }
  if (!resolved.startsWith(baseWithSep)) {
    consola.warn(
      `[admin/traces] rejected symlink escape: ${filename} → ${resolved}`,
    )
    return c.text("Bad Request", 400)
  }

  // Stream the file rather than readFileSync — traces can be up to
  // traces_max_bytes (default 100 MB) and a synchronous read would block
  // the event loop for the duration, freezing all proxy traffic.
  const stream = nodeStreamToWeb(resolved)
  return c.body(stream, 200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Content-Disposition": `attachment; filename="traces-${date}.jsonl"`,
    "Cache-Control": "no-store",
  })
})

export { tracesApp }
