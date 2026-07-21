import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import { _refreshCopilotTokenWithRetry_TEST_ONLY } from "../src/lib/token"

// ---------------------------------------------------------------------------
// The retry helper wraps fetch → getCopilotToken(). We can drive it by
// monkey-patching globalThis.fetch to a controlled mock and asserting on
// the resulting state.copilotToken + call count.
//
// Backoff timing:
//   attempt 1 → fail → wait 500-1000ms (base=1000ms with 50-100% jitter)
//   attempt 2 → fail → wait 1000-2000ms
//   attempt 3 → fail → wait 2000-4000ms
//   attempt N → wait min(1000 * 2^(N-1), 60000) * (0.5..1)
//
// To keep tests fast we override globalThis.setTimeout with a passthrough
// that fires immediately. The retry logic uses `new Promise(r => setTimeout(r, delay))`,
// so the mocked setTimeout resolves each backoff wait instantly and the
// full 10-attempt loop finishes in <100ms.
// ---------------------------------------------------------------------------

let originalFetch: typeof fetch
let originalSetTimeout: typeof setTimeout

function mockCopilotToken(token: string, refresh_in = 1800): typeof fetch {
  const mockFn = (): ReturnType<typeof fetch> =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          token,
          refresh_in,
          expires_at: Math.floor(Date.now() / 1000) + refresh_in,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
  // @ts-expect-error - test mock doesn't implement full fetch signature
  return mockFn
}

function mockCopilotTokenFailingNTimesThen(
  failCount: number,
  eventualToken: string,
): typeof fetch {
  let calls = 0
  const mockFn = (): ReturnType<typeof fetch> => {
    calls++
    if (calls <= failCount) {
      return Promise.resolve(
        new Response("upstream error", {
          status: 503,
          headers: { "content-type": "text/plain" },
        }),
      )
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          token: eventualToken,
          refresh_in: 1800,
          expires_at: Math.floor(Date.now() / 1000) + 1800,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
  }
  // @ts-expect-error - test mock doesn't implement full fetch signature
  return mockFn
}

function mockCopilotTokenAlwaysFailing(): {
  fetch: typeof fetch
  getCalls: () => number
} {
  let calls = 0
  const mockFn = (): ReturnType<typeof fetch> => {
    calls++
    return Promise.resolve(
      new Response("upstream error", {
        status: 503,
        headers: { "content-type": "text/plain" },
      }),
    )
  }
  return {
    // @ts-expect-error - test mock doesn't implement full fetch signature
    fetch: mockFn,
    getCalls: () => calls,
  }
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalSetTimeout = globalThis.setTimeout
  state.githubToken = "test-github-pat"
  state.copilotToken = "stale-token-from-previous-refresh"
  state.showToken = false
  // Bypass real backoff waits — fire callbacks synchronously in the
  // microtask queue. Type-cast because we're intentionally producing a
  // signature that only satisfies the code-under-test's usage of it.
  globalThis.setTimeout = ((cb: () => void) => {
    queueMicrotask(cb)
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
})

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
  state.copilotToken = undefined
  state.githubToken = undefined
})

describe("refreshCopilotTokenWithRetry — happy path", () => {
  test("succeeds first try → state updated, no retries", async () => {
    globalThis.fetch = mockCopilotToken("fresh-token-1")
    await _refreshCopilotTokenWithRetry_TEST_ONLY()
    expect(state.copilotToken).toBe("fresh-token-1")
  })
})

describe("refreshCopilotTokenWithRetry — transient failures", () => {
  test("succeeds on attempt 2 → state gets the fresh token", async () => {
    globalThis.fetch = mockCopilotTokenFailingNTimesThen(1, "fresh-token-2")
    await _refreshCopilotTokenWithRetry_TEST_ONLY()
    expect(state.copilotToken).toBe("fresh-token-2")
  })

  test("succeeds on attempt 5 → state gets the fresh token", async () => {
    globalThis.fetch = mockCopilotTokenFailingNTimesThen(4, "fresh-token-5")
    await _refreshCopilotTokenWithRetry_TEST_ONLY()
    expect(state.copilotToken).toBe("fresh-token-5")
  })

  test("succeeds on the last (10th) attempt → state gets the fresh token", async () => {
    globalThis.fetch = mockCopilotTokenFailingNTimesThen(9, "fresh-token-10")
    await _refreshCopilotTokenWithRetry_TEST_ONLY()
    expect(state.copilotToken).toBe("fresh-token-10")
  })
})

describe("refreshCopilotTokenWithRetry — exhaustion", () => {
  test("all 10 attempts fail → stale token preserved, exactly 10 fetches", async () => {
    const { fetch: mockFn, getCalls } = mockCopilotTokenAlwaysFailing()
    globalThis.fetch = mockFn
    await _refreshCopilotTokenWithRetry_TEST_ONLY()
    // Stale-token-preserving semantics: the previous value stays in state
    // so in-flight requests can still limp along while operators notice
    // the loud error log and intervene.
    expect(state.copilotToken).toBe("stale-token-from-previous-refresh")
    expect(getCalls()).toBe(10)
  })
})

describe("refreshCopilotTokenWithRetry — overlap guard", () => {
  test("concurrent invocations don't stack — second call no-ops", async () => {
    let calls = 0
    // Slow-succeed on first invocation so the second invocation lands
    // while the first is still in flight.
    const slowMock = (): ReturnType<typeof fetch> => {
      calls++
      return new Promise((resolve) => {
        // Use the original setTimeout to guarantee this doesn't resolve
        // before the second call has a chance to bail out on the guard.
        originalSetTimeout(() => {
          resolve(
            new Response(
              JSON.stringify({
                token: `fresh-token-slow-${calls}`,
                refresh_in: 1800,
                expires_at: Math.floor(Date.now() / 1000) + 1800,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          )
        }, 50)
      })
    }
    // @ts-expect-error - test mock signature
    globalThis.fetch = slowMock

    const [,] = await Promise.all([
      _refreshCopilotTokenWithRetry_TEST_ONLY(),
      _refreshCopilotTokenWithRetry_TEST_ONLY(),
    ])
    // Only ONE fetch fired — the second call hit the in-flight guard and
    // returned immediately without hitting the network.
    expect(calls).toBe(1)
    expect(state.copilotToken).toBe("fresh-token-slow-1")
  })
})
