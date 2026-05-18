import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Config } from "../src/lib/config-store"

import { recentCallsForKey, usageForKey } from "../src/admin/usage/queries"
import { loadConfig, saveConfig } from "../src/lib/config-store"
import { closeDb, getDb, initDb, resetDb } from "../src/lib/db"
import { recordEvent } from "../src/services/events"

// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../src/lib/migrations")
const KEY = "test-key-A"

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "key-usage-test-"))
}

function makeTmpConfig(dir: string): string {
  const cfgPath = path.join(dir, "config.json")
  const cfg: Config = {
    version: 1,
    models: {},
    retention: {
      events_days: 90,
      traces_days: 0,
      traces_max_bytes: 104857600,
      audit_days: 365,
    },
    features: { auth: false, telemetry: false, debug: false },
  }
  saveConfig(cfg, cfgPath)
  return cfgPath
}

let dir: string

beforeEach(async () => {
  dir = makeTmpDir()
  initDb(path.join(dir, "test.db"), MIGRATIONS_DIR)
  await loadConfig(makeTmpConfig(dir))
})

afterEach(async () => {
  try {
    closeDb(getDb())
  } catch {
    /* already closed */
  }
  resetDb()
  fs.rmSync(dir, { recursive: true, force: true })
  await loadConfig(
    path.join(os.tmpdir(), "__nonexistent_key_usage_reset__.json"),
  ).catch(() => {})
})

// ---------------------------------------------------------------------------

describe("usageForKey", () => {
  test("returns zeros for a key with no events", () => {
    const u = usageForKey(KEY, 86_400_000)
    expect(u.total_requests).toBe(0)
    expect(u.total_prompt_tokens).toBe(0)
    expect(u.total_completion_tokens).toBe(0)
    expect(u.errors).toBe(0)
    expect(u.error_rate).toBe(0)
    expect(u.p95_latency_ms).toBeNull()
    expect(u.last_used_ts).toBeNull()
  })

  test("aggregates token + request counts within window", () => {
    const now = Date.now()
    recordEvent({
      ts: now - 1000,
      key_id: KEY,
      model: "claude",
      upstream_model: "claude",
      prompt_tokens: 100,
      completion_tokens: 50,
      status: 200,
      latency_ms: 200,
      error: null,
      usage_unknown: 0,
    })
    recordEvent({
      ts: now - 2000,
      key_id: KEY,
      model: "claude",
      upstream_model: "claude",
      prompt_tokens: 50,
      completion_tokens: 30,
      status: 200,
      latency_ms: 100,
      error: null,
      usage_unknown: 0,
    })

    const u = usageForKey(KEY, 86_400_000)
    expect(u.total_requests).toBe(2)
    expect(u.total_prompt_tokens).toBe(150)
    expect(u.total_completion_tokens).toBe(80)
    expect(u.errors).toBe(0)
    expect(u.error_rate).toBe(0)
    expect(u.last_used_ts).toBe(now - 1000)
    expect(u.p95_latency_ms).not.toBeNull()
  })

  test("counts errors (status >= 400) and computes error rate", () => {
    const now = Date.now()
    for (let i = 0; i < 8; i++) {
      recordEvent({
        ts: now - i * 100,
        key_id: KEY,
        model: "m",
        upstream_model: "m",
        prompt_tokens: 1,
        completion_tokens: 1,
        status: i < 2 ? 500 : 200, // 2 errors out of 8
        latency_ms: 10,
        error: i < 2 ? "upstream_error" : null,
        usage_unknown: 0,
      })
    }
    const u = usageForKey(KEY, 86_400_000)
    expect(u.total_requests).toBe(8)
    expect(u.errors).toBe(2)
    expect(u.error_rate).toBeCloseTo(0.25, 2)
  })

  test("excludes events outside the window", () => {
    const now = Date.now()
    // 1 event INSIDE the 1h window
    recordEvent({
      ts: now - 1000,
      key_id: KEY,
      model: "m",
      upstream_model: "m",
      prompt_tokens: 10,
      completion_tokens: 5,
      status: 200,
      latency_ms: 50,
      error: null,
      usage_unknown: 0,
    })
    // 1 event OUTSIDE the 1h window (3 hours ago)
    recordEvent({
      ts: now - 3 * 3_600_000,
      key_id: KEY,
      model: "m",
      upstream_model: "m",
      prompt_tokens: 1000,
      completion_tokens: 1000,
      status: 200,
      latency_ms: 50,
      error: null,
      usage_unknown: 0,
    })

    const u = usageForKey(KEY, 3_600_000) // 1h window
    expect(u.total_requests).toBe(1)
    expect(u.total_prompt_tokens).toBe(10) // not 1010
  })

  test("excludes events from other keys", () => {
    const now = Date.now()
    recordEvent({
      ts: now,
      key_id: KEY,
      model: "m",
      upstream_model: "m",
      prompt_tokens: 5,
      completion_tokens: 5,
      status: 200,
      latency_ms: 50,
      error: null,
      usage_unknown: 0,
    })
    recordEvent({
      ts: now,
      key_id: "different-key",
      model: "m",
      upstream_model: "m",
      prompt_tokens: 1000,
      completion_tokens: 1000,
      status: 200,
      latency_ms: 50,
      error: null,
      usage_unknown: 0,
    })

    const u = usageForKey(KEY, 86_400_000)
    expect(u.total_requests).toBe(1)
    expect(u.total_prompt_tokens).toBe(5)
  })
})

describe("recentCallsForKey", () => {
  test("returns rows in descending ts order, limited", () => {
    const now = Date.now()
    for (let i = 0; i < 25; i++) {
      recordEvent({
        ts: now - i * 1000,
        key_id: KEY,
        model: "m",
        upstream_model: "m",
        prompt_tokens: i,
        completion_tokens: i,
        status: 200,
        latency_ms: 50,
        error: null,
        usage_unknown: 0,
      })
    }

    const recent = recentCallsForKey(KEY, 20)
    expect(recent.length).toBe(20)
    // First row should be the newest (now - 0)
    expect(recent[0]?.ts).toBe(now)
    // Descending order
    for (let i = 1; i < recent.length; i++) {
      // Type system knows recent[i] is defined since i < length and there are
      // no holes after .all() — but assert defensively for the test reader.
      expect(recent[i]?.ts).toBeLessThan(recent[i - 1]?.ts ?? Infinity)
    }
  })

  test("returns empty array for unknown key", () => {
    expect(recentCallsForKey("never-seen", 20)).toEqual([])
  })

  test("includes error tag when status >= 400", () => {
    recordEvent({
      ts: Date.now(),
      key_id: KEY,
      model: "m",
      upstream_model: "m",
      prompt_tokens: 1,
      completion_tokens: 1,
      status: 429,
      latency_ms: 50,
      error: "rate_limited",
      usage_unknown: 0,
    })
    const recent = recentCallsForKey(KEY, 20)
    expect(recent[0]?.error).toBe("rate_limited")
    expect(recent[0]?.status).toBe(429)
  })
})
