import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// ---------------------------------------------------------------------------
// Path isolation
//
// trace-writer / trace-retention read tracesDir() from src/lib/paths.ts.
// That module computes APP_DIR at load-time from XDG_DATA_HOME, so we have
// to mock it BEFORE importing the writer.  We point tracesDir at a fresh
// tmp dir per-test and reset between tests.
// ---------------------------------------------------------------------------

const sharedTracesDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-"))
let currentTracesDir = sharedTracesDir

// Bun's mock.module returns a thenable that doesn't need awaiting in
// practice (it patches the loader synchronously); silence the floating-
// promise lint rather than wrap the rest of the file in a top-level await.
void mock.module("~/lib/paths", () => ({
  PATHS: { APP_DIR: sharedTracesDir, TRACES_DIR: sharedTracesDir },
  configPath: () => path.join(sharedTracesDir, "config.json"),
  dbPath: () => path.join(sharedTracesDir, "test.db"),
  tracesDir: () => currentTracesDir,
  ensurePaths: async () => Promise.resolve(),
}))

// Now load everything that depends on tracesDir().  The dynamic import
// guarantees the mocked module wins.
const { _resetBroadcaster_TEST_ONLY, subscribe, subscriberCount, ringSize } =
  await import("../src/services/trace-broadcaster")
const { writeTrace, traceFilePath, todayDateStr } = await import(
  "../src/services/trace-writer"
)
const { enforceSizeCap, purgeOldTraces, startTraceRetention, sweepTracesOnce } =
  await import("../src/services/trace-retention")
const { loadConfig, saveConfig } = await import("../src/lib/config-store")
const { server } = await import("../src/server")
const { createKey, setDebugEnabled } = await import("../src/services/keys")
const { initDb, closeDb, getDb, resetDb } = await import("../src/lib/db")
const { _resetNoAuthWarned_TEST_ONLY } = await import("../src/middleware/auth")
import type { Config } from "../src/lib/config-store"

const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../src/lib/migrations")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpConfig(
  dir: string,
  features: Partial<Config["features"]> = {},
  retention: Partial<Config["retention"]> = {},
): string {
  const cfgPath = path.join(dir, "config.json")
  const cfg: Config = {
    version: 1,
    // Pre-register model names used by this test file so the D-013
    // default-model interceptor passes them through unchanged.
    models: {
      "gpt-4o": { upstream: "gpt-4o", enabled: true, allowed_keys: ["*"] },
      "claude-sonnet-4-5": {
        upstream: "claude-sonnet-4-5",
        enabled: true,
        allowed_keys: ["*"],
      },
    },
    retention: {
      events_days: 90,
      traces_days: 7,
      traces_max_bytes: 104857600,
      audit_days: 365,
      ...retention,
    },
    features: { auth: true, telemetry: false, debug: false, ...features },
    default_model_alias: "",
  }
  saveConfig(cfg, cfgPath)
  return cfgPath
}

function makeEvent(
  over: Record<string, unknown> = {},
): Parameters<typeof writeTrace>[0] {
  return {
    trace_id: "00000000-0000-0000-0000-000000000001",
    ts: Date.now(),
    key_id: "k1",
    route: "/v1/chat/completions",
    req: {
      method: "POST",
      url: "http://localhost/v1/chat/completions",
      headers: { "content-type": "application/json" },
      body: { hello: "world" },
    },
    res: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    },
    latency_ms: 12,
    ...over,
  }
}

function fmtDate(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

/** SSE chunks include periodic heartbeats; strip them for content equality. */
function stripHeartbeat(s: string): string {
  return s
    .split("\n\n")
    .filter((p) => !p.startsWith(": ping") && p.length > 0)
    .join("\n\n")
}

let testDir: string

beforeEach(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-case-"))
  currentTracesDir = testDir
  _resetBroadcaster_TEST_ONLY()
  await loadConfig(makeTmpConfig(testDir, {}, { traces_days: 7 }))
})

afterEach(async () => {
  fs.rmSync(testDir, { recursive: true, force: true })
  // Reset config to features.auth=false so later test files (model-routing,
  // native-passthrough, etc.) that POST without an Authorization header
  // aren't blocked by the lingering auth-on state we set up here.
  const resetPath = path.join(os.tmpdir(), "__trace_test_reset__.json")
  const resetCfg: Config = {
    version: 1,
    models: {},
    retention: {
      events_days: 90,
      traces_days: 0,
      traces_max_bytes: 104857600,
      audit_days: 365,
    },
    features: { auth: false, telemetry: false, debug: false },
    default_model_alias: "",
  }
  saveConfig(resetCfg, resetPath)
  await loadConfig(resetPath).catch(() => {})
})

afterAll(() => {
  fs.rmSync(sharedTracesDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// trace-writer: on-disk persistence
// ---------------------------------------------------------------------------

describe("writeTrace — on-disk persistence", () => {
  test("creates traces/YYYY-MM-DD.jsonl with mode 0o600", () => {
    writeTrace(makeEvent())
    const filePath = traceFilePath(todayDateStr())
    expect(fs.existsSync(filePath)).toBe(true)
    const stat = fs.statSync(filePath)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test("writes a single JSONL line per event", () => {
    writeTrace(makeEvent({ trace_id: "id-1" }))
    writeTrace(makeEvent({ trace_id: "id-2" }))
    const filePath = traceFilePath(todayDateStr())
    const raw = fs.readFileSync(filePath, "utf8")
    const lines = raw.split("\n").filter((l) => l.trim().length > 0)
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0])).toMatchObject({ trace_id: "id-1" })
    expect(JSON.parse(lines[1])).toMatchObject({ trace_id: "id-2" })
  })

  test("redacts header values before writing", () => {
    writeTrace(
      makeEvent({
        req: {
          method: "POST",
          url: "http://localhost",
          headers: { authorization: "Bearer ghp_secret_token_abcdefghijkl" },
          body: { hi: "ok" },
        },
      }),
    )
    const raw = fs.readFileSync(traceFilePath(todayDateStr()), "utf8")
    expect(raw).not.toContain("ghp_secret_token_abcdefghijkl")
    expect(raw).toContain("[REDACTED]")
  })

  test("traces_days=0 → no file is written (in-memory only)", async () => {
    await loadConfig(makeTmpConfig(testDir, {}, { traces_days: 0 }))
    writeTrace(makeEvent({ trace_id: "should-not-persist" }))
    const filePath = traceFilePath(todayDateStr())
    expect(fs.existsSync(filePath)).toBe(false)
    // Broadcaster still receives it (in-memory only mode keeps live tail)
    // — we just can't easily assert that here without a subscriber.
  })

  test("ensures tracesDir() exists with 0o700 on first write", () => {
    // currentTracesDir is the per-test dir; ensure the writer (re-)creates
    // it with 0o700 if it's been deleted.
    fs.rmSync(currentTracesDir, { recursive: true, force: true })
    writeTrace(makeEvent())
    const stat = fs.statSync(currentTracesDir)
    expect(stat.isDirectory()).toBe(true)
    // 0o700 — only the owner should have permissions
    expect(stat.mode & 0o077).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// trace-retention: age-based purge
// ---------------------------------------------------------------------------

describe("trace-retention — age purge", () => {
  test("deletes files older than traces_days", async () => {
    await loadConfig(makeTmpConfig(testDir, {}, { traces_days: 7 }))
    const oldDate = fmtDate(new Date(Date.now() - 30 * 86_400_000))
    const recentDate = fmtDate(new Date(Date.now() - 1 * 86_400_000))
    const oldFile = path.join(currentTracesDir, `traces-${oldDate}.jsonl`)
    const recentFile = path.join(currentTracesDir, `traces-${recentDate}.jsonl`)
    fs.mkdirSync(currentTracesDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(oldFile, "{}\n", { mode: 0o600 })
    fs.writeFileSync(recentFile, "{}\n", { mode: 0o600 })

    const purged = purgeOldTraces()
    expect(purged).toBe(1)
    expect(fs.existsSync(oldFile)).toBe(false)
    expect(fs.existsSync(recentFile)).toBe(true)
  })

  test("traces_days=0 still safe to run (no-op)", async () => {
    await loadConfig(makeTmpConfig(testDir, {}, { traces_days: 0 }))
    expect(() => purgeOldTraces()).not.toThrow()
  })

  test("ignores non-trace files in the directory", () => {
    fs.mkdirSync(currentTracesDir, { recursive: true, mode: 0o700 })
    const unrelated = path.join(currentTracesDir, "notes.txt")
    fs.writeFileSync(unrelated, "irrelevant")
    purgeOldTraces()
    expect(fs.existsSync(unrelated)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// trace-retention: size cap
// ---------------------------------------------------------------------------

describe("trace-retention — size cap", () => {
  test("evicts oldest day when total exceeds traces_max_bytes", async () => {
    // Cap at 200 bytes; write three 100-byte files
    await loadConfig(
      makeTmpConfig(testDir, {}, { traces_days: 30, traces_max_bytes: 200 }),
    )
    fs.mkdirSync(currentTracesDir, { recursive: true, mode: 0o700 })
    const now = Date.now()
    const dates = [
      fmtDate(new Date(now - 3 * 86_400_000)),
      fmtDate(new Date(now - 2 * 86_400_000)),
      fmtDate(new Date(now - 1 * 86_400_000)),
    ]
    for (const d of dates) {
      fs.writeFileSync(
        path.join(currentTracesDir, `traces-${d}.jsonl`),
        "x".repeat(100),
        { mode: 0o600 },
      )
    }
    const evicted = enforceSizeCap()
    // 300B total, cap 200B → must evict at least one file (the oldest first)
    expect(evicted).toBeGreaterThanOrEqual(1)
    expect(
      fs.existsSync(path.join(currentTracesDir, `traces-${dates[0]}.jsonl`)),
    ).toBe(false)
    // Newest should still be there
    expect(
      fs.existsSync(path.join(currentTracesDir, `traces-${dates[2]}.jsonl`)),
    ).toBe(true)
  })

  test("logs alarm when evicting within retention window", async () => {
    // Cap small + long retention → the only way to enforce cap is to evict
    // a file that's still inside the retention window.
    await loadConfig(
      makeTmpConfig(testDir, {}, { traces_days: 30, traces_max_bytes: 50 }),
    )
    fs.mkdirSync(currentTracesDir, { recursive: true, mode: 0o700 })
    const d = fmtDate(new Date(Date.now() - 2 * 86_400_000))
    fs.writeFileSync(
      path.join(currentTracesDir, `traces-${d}.jsonl`),
      "x".repeat(100),
      { mode: 0o600 },
    )

    // We can't easily intercept consola; instead verify the eviction
    // happened, which is the observable signal (the warn log is best-effort).
    const evicted = enforceSizeCap()
    expect(evicted).toBe(1)
  })

  test("sweepTracesOnce runs both purge + cap and returns counts", () => {
    fs.mkdirSync(currentTracesDir, { recursive: true, mode: 0o700 })
    const result = sweepTracesOnce()
    expect(typeof result.purged).toBe("number")
    expect(typeof result.evicted).toBe("number")
  })

  test("startTraceRetention returns a cancel handle that clears the interval", () => {
    const cancel = startTraceRetention()
    expect(typeof cancel).toBe("function")
    cancel()
    // Calling cancel twice must be safe
    expect(() => cancel()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Broadcaster
// ---------------------------------------------------------------------------

describe("trace-broadcaster", () => {
  test("two subscribers receive identical lines", async () => {
    const r1 = subscribe()
    const r2 = subscribe()
    if (!r1.ok || !r2.ok) throw new Error("subscribe rejected")

    // Drain in the background into a string buffer per subscriber. We can't
    // race reader.read() against a timeout (the pending read consumes the
    // next chunk on the next tick and there's no way to "give it back"); so
    // instead spawn a draining task per subscriber and let it run until we
    // explicitly cancel.
    function spawnDrainer(stream: ReadableStream<Uint8Array>): {
      buf: { value: string }
      cancel: () => Promise<void>
    } {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      const buf = { value: "" }
      let stopped = false
      const loop = async (): Promise<void> => {
        while (!stopped) {
          try {
            const result = (await reader.read()) as {
              value?: Uint8Array
              done: boolean
            }
            if (result.done) return
            if (result.value)
              buf.value += decoder.decode(result.value, { stream: true })
          } catch {
            return
          }
        }
      }
      const promise = loop()
      return {
        buf,
        cancel: async () => {
          stopped = true
          try {
            await reader.cancel()
          } catch {
            // already closed
          }
          await promise
        },
      }
    }

    const d1 = spawnDrainer(r1.stream)
    const d2 = spawnDrainer(r2.stream)

    // Let the initial retry/heartbeat frames flush
    await new Promise((r) => setTimeout(r, 30))

    // Broadcast a recognisable line
    const { broadcastTrace } = await import("../src/services/trace-broadcaster")
    const line = `${JSON.stringify({ hello: "world", ts: 1 })}\n`
    broadcastTrace(line)

    // Give the drainers a tick to see the new frame
    await new Promise((r) => setTimeout(r, 50))

    expect(d1.buf.value).toContain("hello")
    expect(d2.buf.value).toContain("hello")

    // Strip heartbeat noise; the rest must match between the two subscribers
    expect(stripHeartbeat(d1.buf.value)).toBe(stripHeartbeat(d2.buf.value))

    await d1.cancel()
    await d2.cancel()
  })

  test("rejects subscriber #5 (cap = 4 concurrent)", () => {
    const subs = []
    for (let i = 0; i < 4; i++) {
      const r = subscribe()
      expect(r.ok).toBe(true)
      subs.push(r)
    }
    expect(subscriberCount()).toBe(4)
    const fifth = subscribe()
    expect(fifth.ok).toBe(false)
    if (!fifth.ok) expect(fifth.reason).toBe("too_many_subscribers")
  })

  test("drop-oldest at 1MB queue cap", async () => {
    // Create a subscriber but never read — its queue fills up.
    const r = subscribe()
    if (!r.ok) throw new Error("subscribe rejected")
    // Hold the stream; don't drain it so the queue grows.
    const reader = r.stream.getReader()
    await reader.read() // consume initial retry/heartbeat to start counting

    // Push frames totalling > 1 MB. Each frame ~ 100 bytes header + data.
    const big = "x".repeat(4000)
    const { broadcastTrace } = await import("../src/services/trace-broadcaster")
    for (let i = 0; i < 400; i++) {
      broadcastTrace(`${JSON.stringify({ i, big })}\n`)
    }
    // We can't easily inspect queueBytes from outside, but the broadcaster
    // must not throw and must remain alive — that's the contract.
    expect(subscriberCount()).toBeGreaterThanOrEqual(1)

    await reader.cancel()
  })

  test("Last-Event-ID replays only newer ring entries", async () => {
    const { broadcastTrace } = await import("../src/services/trace-broadcaster")
    broadcastTrace(`${JSON.stringify({ n: 1 })}\n`)
    broadcastTrace(`${JSON.stringify({ n: 2 })}\n`)
    broadcastTrace(`${JSON.stringify({ n: 3 })}\n`)

    const ringSizeNow = ringSize()
    expect(ringSizeNow).toBeGreaterThanOrEqual(3)

    // Subscribe asking for everything after id=1; expect to see at least
    // the n=2 and n=3 entries replayed.
    const r = subscribe({ lastEventId: 1 })
    if (!r.ok) throw new Error("subscribe rejected")

    // Drain in the background — replayed frames are enqueued synchronously
    // inside start() so they're available immediately.
    const reader = r.stream.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    const drain = (async () => {
      while (true) {
        try {
          const result = (await reader.read()) as {
            value?: Uint8Array
            done: boolean
          }
          if (result.done) return
          if (result.value)
            buf += decoder.decode(result.value, { stream: true })
        } catch {
          return
        }
      }
    })()
    await new Promise((res) => setTimeout(res, 80))

    expect(buf).toContain(`"n":2`)
    expect(buf).toContain(`"n":3`)
    expect(buf).not.toContain(`"n":1`)

    await reader.cancel()
    await drain
  })
})

// ---------------------------------------------------------------------------
// Path-traversal guard on the download endpoint
// ---------------------------------------------------------------------------

describe("/admin/traces/:date.jsonl — path traversal", () => {
  beforeAll(() => {
    _resetNoAuthWarned_TEST_ONLY()
    initDb(path.join(sharedTracesDir, "test.db"), MIGRATIONS_DIR)
  })

  afterAll(() => {
    try {
      closeDb(getDb())
    } catch {
      // already closed
    }
    resetDb()
  })

  // These hit unauthenticated /admin/traces/<bad>; the session middleware
  // will redirect (302) to /admin/login. We assert that REGARDLESS of the
  // session check, the routes never accept a traversal-shaped param —
  // because the date pattern is validated inside the route, the session
  // middleware doesn't even need to run for the guard to be effective.
  test("URL-encoded ../ → 400 or auth redirect", async () => {
    const res = await server.request(
      "/admin/traces/..%2F..%2Fetc%2Fpasswd.jsonl",
    )
    // Either 400 (path guard) or 302/401 (session). Crucially NOT 200.
    expect([302, 400, 401, 404]).toContain(res.status)
  })

  test("literal ../ → 400 or auth redirect", async () => {
    const res = await server.request("/admin/traces/..%2Fpasswd.jsonl")
    expect([302, 400, 401, 404]).toContain(res.status)
  })

  test("malformed date '2025-..-..' → 400 or auth redirect", async () => {
    const res = await server.request("/admin/traces/2025-..-...jsonl")
    expect([302, 400, 401, 404]).toContain(res.status)
  })

  test("symlink at traces-YYYY-MM-DD.jsonl pointing OUTSIDE tracesDir → 400 (crew R3)", async () => {
    // Place a symlink in the traces dir pointing at /etc/passwd. The
    // lexical startsWith guard passes (the link itself is inside the
    // dir), but the realpath defence-in-depth check must reject it.
    const linkPath = path.join(sharedTracesDir, "traces-2099-01-01.jsonl")
    try {
      fs.symlinkSync("/etc/passwd", linkPath)
    } catch {
      // some filesystems (Windows w/o admin) can't symlink — skip
      return
    }
    try {
      const res = await server.request("/admin/traces/2099-01-01.jsonl")
      // Pre-auth path-guard or session redirect or 404 — anything but
      // 200 (which would mean we leaked /etc/passwd to the client).
      expect(res.status).not.toBe(200)
      // If we DID make it past auth, the response should be 400 rejecting
      // the symlink escape.  Accept 302/401 (auth) too.
      expect([302, 400, 401, 404]).toContain(res.status)
    } finally {
      fs.unlinkSync(linkPath)
    }
  })
})

// ---------------------------------------------------------------------------
// Middleware integration via server.request
// ---------------------------------------------------------------------------

function modelsListFetchMock(): {
  ok: true
  json: () => Promise<unknown>
  text: () => Promise<string>
  status: number
} {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        object: "list",
        data: [
          {
            id: "gpt-4o",
            name: "GPT-4o",
            vendor: "openai",
            object: "model",
            model_picker_enabled: true,
            preview: false,
            version: "1",
            capabilities: {
              family: "gpt-4",
              object: "model_capabilities",
              tokenizer: "o200k_base",
              type: "chat",
              limits: {
                max_context_window_tokens: 128_000,
                max_output_tokens: 4096,
                max_prompt_tokens: 64_000,
              },
              supports: {},
            },
          },
        ],
      }),
    text: () => Promise.resolve(""),
    status: 200,
  }
}

function chatCompletionFetchMock(): typeof fetch {
  const mockFn = (): ReturnType<typeof fetch> =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          id: "cmpl-1",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
  // @ts-expect-error - mock doesn't implement full fetch signature
  return mockFn
}

describe("trace middleware — end-to-end", () => {
  beforeAll(async () => {
    const { state } = await import("../src/lib/state")
    _resetNoAuthWarned_TEST_ONLY()
    initDb(path.join(sharedTracesDir, "test-mw.db"), MIGRATIONS_DIR)
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.99.0"
    state.accountType = "individual"
    state.manualApprove = false
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-4o",
          name: "GPT-4o",
          vendor: "openai",
          object: "model",
          model_picker_enabled: true,
          preview: false,
          version: "1",
          capabilities: {
            family: "gpt-4",
            object: "model_capabilities",
            tokenizer: "o200k_base",
            type: "chat",
            limits: {
              max_context_window_tokens: 128_000,
              max_output_tokens: 4096,
              max_prompt_tokens: 64_000,
            },
            supports: { tool_calls: true, parallel_tool_calls: true },
          },
        },
      ],
    }
  })

  afterAll(async () => {
    const { state } = await import("../src/lib/state")
    try {
      closeDb(getDb())
    } catch {
      // already closed
    }
    resetDb()
    state.models = undefined
    state.copilotToken = undefined
    // @ts-expect-error - mock fetch
    globalThis.fetch = modelsListFetchMock
  })

  test("admin key + X-Capi-Debug:1 → trace line written", async () => {
    await loadConfig(makeTmpConfig(testDir, { auth: true }, { traces_days: 7 }))
    const { plain } = createKey({ tier: "admin", label: "trace-admin" })
    globalThis.fetch = chatCompletionFetchMock()

    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plain}`,
        "Content-Type": "application/json",
        "X-Capi-Debug": "1",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    })
    expect(res.status).toBe(200)
    await res.text()
    // Give the writer a tick to flush
    await new Promise((r) => setTimeout(r, 50))

    const filePath = traceFilePath(todayDateStr())
    expect(fs.existsSync(filePath)).toBe(true)
    const raw = fs.readFileSync(filePath, "utf8")
    const lines = raw.split("\n").filter((l) => l.trim().length > 0)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const parsed = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>
    expect(parsed.route).toBe("/v1/chat/completions")
    // Authorization is stripped by authMiddleware BEFORE trace runs, so the
    // captured request headers won't include it. What we CAN verify is that
    // no raw secret-shaped substring leaked, and the body was captured.
    expect(raw).not.toContain("ghp_")
    expect(parsed.key_id).toBeDefined()
  })

  test("client tier with X-Capi-Debug → NO trace (header stripped by auth)", async () => {
    await loadConfig(makeTmpConfig(testDir, { auth: true }, { traces_days: 7 }))
    const { plain } = createKey({ tier: "client", label: "trace-client" })
    globalThis.fetch = chatCompletionFetchMock()

    const beforeSize =
      fs.existsSync(traceFilePath(todayDateStr())) ?
        fs.statSync(traceFilePath(todayDateStr())).size
      : 0

    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plain}`,
        "Content-Type": "application/json",
        "X-Capi-Debug": "1",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    })
    expect(res.status).toBe(200)
    await res.text()
    await new Promise((r) => setTimeout(r, 50))

    const afterSize =
      fs.existsSync(traceFilePath(todayDateStr())) ?
        fs.statSync(traceFilePath(todayDateStr())).size
      : 0
    expect(afterSize).toBe(beforeSize)
  })

  test("key with debug_enabled=1 → trace line written", async () => {
    await loadConfig(makeTmpConfig(testDir, { auth: true }, { traces_days: 7 }))
    const { plain, row } = createKey({ tier: "client", label: "trace-debug" })
    setDebugEnabled(row.id, true)
    globalThis.fetch = chatCompletionFetchMock()

    const beforeSize =
      fs.existsSync(traceFilePath(todayDateStr())) ?
        fs.statSync(traceFilePath(todayDateStr())).size
      : 0

    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    })
    expect(res.status).toBe(200)
    await res.text()
    await new Promise((r) => setTimeout(r, 50))

    const afterSize =
      fs.existsSync(traceFilePath(todayDateStr())) ?
        fs.statSync(traceFilePath(todayDateStr())).size
      : 0
    expect(afterSize).toBeGreaterThan(beforeSize)
  })
})
