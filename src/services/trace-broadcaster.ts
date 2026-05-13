/**
 * In-process pub-sub for the SSE live-tail at /admin/traces/stream.
 *
 * Lives entirely in process memory: no DB, no fs. Subscribers are
 * back-pressured by a per-subscriber 1 MB queue cap with drop-oldest
 * semantics, and the broadcaster caps concurrent subscribers at 4.
 *
 * A small in-memory ring of the last `RING_SIZE` broadcasts is retained
 * so a reconnecting client can pass `Last-Event-ID` and pick up roughly
 * where it left off without poking the on-disk JSONL files.
 */

import consola from "consola"

const HEARTBEAT_MS = 15_000
const QUEUE_BYTES_CAP = 1 * 1024 * 1024 // 1 MB per subscriber
const MAX_SUBSCRIBERS = 4
const RING_SIZE = 100

interface RingEntry {
  id: number
  line: string
}

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>
  queue: Array<{ id: number; bytes: Uint8Array }>
  queueBytes: number
  pending: boolean
  heartbeat: ReturnType<typeof setInterval> | null
  closed: boolean
}

const subscribers = new Set<Subscriber>()
const ring: Array<RingEntry> = []
let monotonicId = 0

const encoder = new TextEncoder()

// Placeholder controller used while a Subscriber is reserved in the
// `subscribers` set but the real ReadableStream `start()` callback hasn't
// fired yet.  Swallows any frame silently — broadcastTrace shouldn't reach
// it in practice, but we'd rather drop a frame than crash if it does.
const PLACEHOLDER_CONTROLLER: ReadableStreamDefaultController<Uint8Array> = {
  desiredSize: 0,
  close() {
    /* noop */
  },
  enqueue() {
    /* noop */
  },
  error() {
    /* noop */
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sseFrame(id: number, line: string): Uint8Array {
  // SSE format: id + data + double newline.  The line is already a JSON
  // string with a trailing \n from the writer; trim it so we emit a single
  // logical record.
  const data = line.endsWith("\n") ? line.slice(0, -1) : line
  return encoder.encode(`id: ${id}\ndata: ${data}\n\n`)
}

function heartbeatFrame(): Uint8Array {
  return encoder.encode(`: ping\n\n`)
}

function flushQueue(sub: Subscriber): void {
  if (sub.closed) return
  if (sub.pending) return
  while (sub.queue.length > 0) {
    const item = sub.queue.shift()
    if (!item) break
    sub.queueBytes -= item.bytes.byteLength
    try {
      sub.controller.enqueue(item.bytes)
    } catch {
      // controller closed under us — mark closed, drop the rest
      closeSubscriber(sub)
      return
    }
  }
}

function pushToSubscriber(
  sub: Subscriber,
  id: number,
  bytes: Uint8Array,
): void {
  // Drop-oldest until we have room for the incoming frame
  while (
    sub.queue.length > 0
    && sub.queueBytes + bytes.byteLength > QUEUE_BYTES_CAP
  ) {
    const dropped = sub.queue.shift()
    if (!dropped) break
    sub.queueBytes -= dropped.bytes.byteLength
  }
  // If a single frame itself exceeds the cap, still enqueue it (a 1MB-bound
  // queue is a back-pressure heuristic, not a hard message size limit) —
  // but log so operators see it.
  if (bytes.byteLength > QUEUE_BYTES_CAP) {
    consola.warn(
      `[trace-broadcaster] frame ${bytes.byteLength}B exceeds queue cap ${QUEUE_BYTES_CAP}B`,
    )
  }
  sub.queue.push({ id, bytes })
  sub.queueBytes += bytes.byteLength
  flushQueue(sub)
}

function closeSubscriber(sub: Subscriber): void {
  if (sub.closed) return
  sub.closed = true
  if (sub.heartbeat) {
    clearInterval(sub.heartbeat)
    sub.heartbeat = null
  }
  subscribers.delete(sub)
  try {
    sub.controller.close()
  } catch {
    // already closed
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Push a redacted trace line to every active subscriber and append it to
 * the replay ring. The caller (trace-writer) is responsible for ensuring
 * the line has already been redacted AND asserted clean.
 */
export function broadcastTrace(line: string): void {
  const id = ++monotonicId
  ring.push({ id, line })
  while (ring.length > RING_SIZE) ring.shift()

  const bytes = sseFrame(id, line)
  for (const sub of subscribers) {
    pushToSubscriber(sub, id, bytes)
  }
}

export interface SubscribeResult {
  ok: true
  stream: ReadableStream<Uint8Array>
}

export interface SubscribeRejected {
  ok: false
  reason: "too_many_subscribers"
}

/**
 * Subscribe to live trace events.
 *
 * Returns a ReadableStream that emits SSE-framed lines plus a periodic
 * heartbeat. When the downstream client cancels, the heartbeat is cleared
 * and the subscriber is removed.
 *
 * `lastEventId` (parsed from the request's Last-Event-ID header) lets
 * reconnecting clients replay anything still in the ring with id >
 * lastEventId.
 *
 * Rejects with `ok: false` once MAX_SUBSCRIBERS are already attached —
 * callers should turn this into an HTTP 503.
 */
export function subscribe(
  opts: {
    lastEventId?: number
  } = {},
): SubscribeResult | SubscribeRejected {
  if (subscribers.size >= MAX_SUBSCRIBERS) {
    return { ok: false, reason: "too_many_subscribers" }
  }

  // Reserve the slot SYNCHRONOUSLY here, not inside start().  ReadableStream's
  // `start` callback is invoked lazily (when the consumer first pulls), so two
  // near-simultaneous subscribe() calls would otherwise both pass the size
  // check on the same value and end up exceeding MAX_SUBSCRIBERS.  Adding a
  // placeholder Subscriber to the set right now closes that window — the
  // ReadableStream's start() callback below fills in `controller` and the
  // heartbeat timer before the first frame is enqueued.
  const sub: Subscriber = {
    // controller is replaced in start(); the placeholder enqueue silently
    // drops frames that arrive before start() (none, in practice, because
    // we only call broadcast after start() has run for at least one event).
    controller: PLACEHOLDER_CONTROLLER,
    queue: [],
    queueBytes: 0,
    pending: false,
    heartbeat: null,
    closed: false,
  }
  subscribers.add(sub)

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sub.controller = controller

      // Replay anything in the ring newer than lastEventId
      if (opts.lastEventId !== undefined) {
        for (const entry of ring) {
          if (entry.id > opts.lastEventId) {
            pushToSubscriber(sub, entry.id, sseFrame(entry.id, entry.line))
          }
        }
      }

      // Send an immediate retry hint + initial heartbeat so the client sees
      // the connection is live even on a quiet system.
      try {
        controller.enqueue(encoder.encode(`retry: 10000\n\n`))
        controller.enqueue(heartbeatFrame())
      } catch {
        closeSubscriber(sub)
        return
      }

      sub.heartbeat = setInterval(() => {
        if (sub.closed) return
        try {
          sub.controller.enqueue(heartbeatFrame())
        } catch {
          closeSubscriber(sub)
        }
      }, HEARTBEAT_MS)
    },
    cancel() {
      closeSubscriber(sub)
    },
  })

  return { ok: true, stream }
}

// ---------------------------------------------------------------------------
// Introspection (tests / admin)
// ---------------------------------------------------------------------------

export function subscriberCount(): number {
  return subscribers.size
}

export function ringSize(): number {
  return ring.length
}

/** Test-only: drop every subscriber and clear the ring. */
export function _resetBroadcaster_TEST_ONLY(): void {
  for (const sub of subscribers) closeSubscriber(sub)
  ring.length = 0
  monotonicId = 0
}
