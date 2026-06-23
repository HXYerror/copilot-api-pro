/**
 * Wrap a streamSSE callback so any pause > 10 s in the upstream stream
 * triggers an SSE comment line (": keepalive") to keep the downstream
 * TCP/TLS connection warm.
 *
 * Why this matters: long-thinking models go 30-120 s silent between
 * chunks. Default-config HTTP clients (Claude Code, openai-sdk, fetch
 * without a long timeout, agent frameworks) treat that silence as a
 * dead connection and close their socket. The user sees "Agent failed:
 * upstream stream interrupted" and our events table records
 * `client_aborted` at the timeout point.
 *
 * Comment lines (starting with `:`) are a documented part of the SSE
 * grammar that every spec-compliant parser silently ignores, so we
 * never feed a synthetic event to the consumer.
 *
 * Usage:
 *   return streamSSE(c, async (stream) => {
 *     await withKeepalive(stream, async (touch) => {
 *       for await (const chunk of upstream) {
 *         await stream.writeSSE(chunk)
 *         touch()
 *       }
 *     })
 *   })
 *
 * `touch()` resets the silence timer and MUST be called after every
 * write so we don't fire keepalive bytes back-to-back with real data.
 */
import type { SSEStreamingApi } from "hono/streaming"

const SILENCE_BEFORE_KEEPALIVE_MS = 10_000
const KEEPALIVE_POLL_MS = 5_000

export async function withKeepalive(
  stream: SSEStreamingApi,
  body: (touch: () => void) => Promise<void>,
): Promise<void> {
  let lastWrite = Date.now()
  const touch = () => {
    lastWrite = Date.now()
  }
  const heartbeat = setInterval(() => {
    if (Date.now() - lastWrite > SILENCE_BEFORE_KEEPALIVE_MS) {
      stream.write(": keepalive\n\n").catch(() => {
        // downstream closed; the body loop will exit shortly
      })
      lastWrite = Date.now()
    }
  }, KEEPALIVE_POLL_MS)
  try {
    await body(touch)
  } finally {
    clearInterval(heartbeat)
  }
}
