import consola from "consola"

import type { State } from "./state"

import { HTTPError } from "./error"
import { sleep } from "./utils"

// ---------------------------------------------------------------------------
// Per-key rate-limit bucket
// ---------------------------------------------------------------------------

interface KeyBucket {
  lastTs: number
  // windowMs not stored: resolved fresh from overrideSec on each call
}

const keyBuckets = new Map<string, KeyBucket>()

/**
 * Minimum required gap between requests for a given key (in seconds).
 * A window of 5s means: one request allowed, then the next is blocked until
 * 5s have elapsed. This is a minimum-gap throttle, not a sliding window.
 *
 * Returns a 429 Response if the key is rate-limited, null otherwise.
 * Does NOT mutate global state.lastRequestTimestamp.
 *
 * Memory: stale buckets (lastTs older than windowMs * 10) are evicted on access
 * to prevent unbounded growth from revoked/rotated keys.
 */
export function checkKeyRateLimit(
  keyId: string,
  overrideSec: number | null,
): void {
  if (overrideSec === null) return

  const windowMs = overrideSec * 1000
  const now = Date.now()
  const bucket = keyBuckets.get(keyId)

  // Evict stale buckets on access
  if (bucket && now - bucket.lastTs > windowMs * 10) {
    keyBuckets.delete(keyId)
  }

  const current = keyBuckets.get(keyId)

  if (!current) {
    keyBuckets.set(keyId, { lastTs: now })
    return
  }

  const elapsed = now - current.lastTs

  if (elapsed >= windowMs) {
    current.lastTs = now
    return
  }

  const waitSec = Math.ceil((windowMs - elapsed) / 1000)
  consola.warn(`[rate-limit] Key ${keyId} rate limited; wait ${waitSec}s`)
  throw new HTTPError(
    "Rate limit exceeded",
    Response.json(
      {
        error: {
          message: "Rate limit exceeded",
          type: "rate_limit_exceeded",
          code: "rate_limit_exceeded",
        },
      },
      {
        status: 429,
        headers: { "Retry-After": String(waitSec) },
      },
    ),
  )
}

export async function checkRateLimit(state: State) {
  if (state.rateLimitSeconds === undefined) return

  const now = Date.now()

  if (!state.lastRequestTimestamp) {
    state.lastRequestTimestamp = now
    return
  }

  const elapsedSeconds = (now - state.lastRequestTimestamp) / 1000

  if (elapsedSeconds > state.rateLimitSeconds) {
    state.lastRequestTimestamp = now
    return
  }

  const waitTimeSeconds = Math.ceil(state.rateLimitSeconds - elapsedSeconds)

  if (!state.rateLimitWait) {
    consola.warn(
      `Rate limit exceeded. Need to wait ${waitTimeSeconds} more seconds.`,
    )
    throw new HTTPError(
      "Rate limit exceeded",
      Response.json({ message: "Rate limit exceeded" }, { status: 429 }),
    )
  }

  const waitTimeMs = waitTimeSeconds * 1000
  consola.warn(
    `Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`,
  )
  await sleep(waitTimeMs)
  // eslint-disable-next-line require-atomic-updates
  state.lastRequestTimestamp = now
  consola.info("Rate limit wait completed, proceeding with request")
  return
}
