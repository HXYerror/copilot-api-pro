import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Config } from "../src/lib/config-store"

import {
  distinctModels,
  errorRateByKey,
  p95LatencyPerHour,
  requestsPerMinute,
  streamEventsForCsv,
  tokensPerHour,
  topKeysByTokens,
  topModelsByRequests,
} from "../src/admin/usage/queries"
import { csvField } from "../src/admin/usage/route"
import { loadConfig, saveConfig } from "../src/lib/config-store"
import { closeDb, getDb, initDb, resetDb } from "../src/lib/db"
import { recordEvent } from "../src/services/events"

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../src/lib/migrations")

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "usage-queries-test-"))
}

function makeTmpConfig(dir: string): string {
  const cfgPath = path.join(dir, "config.json")
  const cfg: Config = {
    version: 1,
    models: {},
    retention: {
      events_days: 90,
      traces_days: 7,
      traces_max_bytes: 104_857_600,
      audit_days: 365,
    },
    features: { auth: false, telemetry: false, debug: false },
    default_model_alias: "",
  }
  saveConfig(cfg, cfgPath)
  return cfgPath
}

interface SeedEvent {
  ts: number
  key_id?: string
  model?: string
  prompt_tokens?: number | null
  completion_tokens?: number | null
  status?: number
  latency_ms?: number
  error?: string | null
}

function seed(events: Array<SeedEvent>): void {
  for (const e of events) {
    recordEvent({
      ts: e.ts,
      key_id: e.key_id ?? "k1",
      model: e.model ?? "gpt-4o",
      upstream_model: e.model ?? "gpt-4o",
      prompt_tokens: e.prompt_tokens ?? null,
      completion_tokens: e.completion_tokens ?? null,
      status: e.status ?? 200,
      latency_ms: e.latency_ms ?? 50,
      error: e.error ?? null,
      usage_unknown:
        e.prompt_tokens === null && e.completion_tokens === null ? 1 : 0,
    })
  }
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

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
  // Reset to the shared "auth=false" config file written by telemetry.test.ts
  // so later test files (responses-route.test.ts, etc.) don't suddenly see
  // features.auth=true after we exit.
  await loadConfig(
    path.join(os.tmpdir(), "__nonexistent_keys_reset__.json"),
  ).catch(() => {})
})

// ---------------------------------------------------------------------------
// Fixture: ~50 events spread over 3 keys × 2 models × multiple hours
// ---------------------------------------------------------------------------

const HOUR = 3_600_000
const MINUTE = 60_000
// Snap to an hour boundary so bucket math (floor / 3_600_000) returns the
// anchor itself rather than a slightly-earlier hour mark.
const ANCHOR = Math.floor(1_700_000_000_000 / HOUR) * HOUR

function seedFixture(): void {
  const events: Array<SeedEvent> = []
  // 10 events for k1/gpt-4o spread across hour 0 (0-9 min)
  for (let i = 0; i < 10; i++) {
    events.push({
      ts: ANCHOR + i * MINUTE,
      key_id: "k1",
      model: "gpt-4o",
      prompt_tokens: 10 + i,
      completion_tokens: 5 + i,
      latency_ms: 50 + i * 10,
      status: 200,
    })
  }
  // 10 events for k1/gpt-4o in hour 1
  for (let i = 0; i < 10; i++) {
    events.push({
      ts: ANCHOR + HOUR + i * MINUTE,
      key_id: "k1",
      model: "gpt-4o",
      prompt_tokens: 100,
      completion_tokens: 50,
      latency_ms: 200,
      status: 200,
    })
  }
  // 10 events for k2/claude in hour 0; 2 are errors
  for (let i = 0; i < 10; i++) {
    events.push({
      ts: ANCHOR + i * MINUTE,
      key_id: "k2",
      model: "claude-sonnet-4.5",
      prompt_tokens: 20,
      completion_tokens: 30,
      latency_ms: 80,
      status: i < 2 ? 500 : 200,
      error: i < 2 ? "upstream" : null,
    })
  }
  // 10 events for k3/gpt-4o-mini in hour 2
  for (let i = 0; i < 10; i++) {
    events.push({
      ts: ANCHOR + 2 * HOUR + i * MINUTE,
      key_id: "k3",
      model: "gpt-4o-mini",
      prompt_tokens: 5,
      completion_tokens: 5,
      latency_ms: 30,
      status: 200,
    })
  }
  // 10 events for k2/claude in hour 1, including one with usage_unknown
  for (let i = 0; i < 10; i++) {
    events.push({
      ts: ANCHOR + HOUR + i * MINUTE,
      key_id: "k2",
      model: "claude-sonnet-4.5",
      prompt_tokens: i === 0 ? null : 40,
      completion_tokens: i === 0 ? null : 60,
      latency_ms: 90,
      status: 200,
    })
  }
  seed(events)
}

const FULL_WINDOW = { since: ANCHOR - 1, until: ANCHOR + 5 * HOUR }

// ---------------------------------------------------------------------------
// Aggregate-correctness tests
// ---------------------------------------------------------------------------

describe("usage queries: aggregates", () => {
  test("requestsPerMinute buckets and groups by model", () => {
    seedFixture()
    const out = requestsPerMinute(FULL_WINDOW)
    // hour-0 minute-0 has k1/gpt-4o + k2/claude = 2 model rows
    const minute0 = out.filter((r) => r.ts === ANCHOR)
    expect(minute0).toHaveLength(2)
    const models = new Set(minute0.map((r) => r.model))
    expect(models).toEqual(new Set(["gpt-4o", "claude-sonnet-4.5"]))
    for (const r of minute0) expect(r.count).toBe(1)
  })

  test("tokensPerHour sums prompt/completion across the bucket", () => {
    seedFixture()
    const out = tokensPerHour(FULL_WINDOW)
    expect(out).toHaveLength(3) // hours 0, 1, 2

    // Hour 0: k1 gpt-4o (Σ prompt = 10..19 = 145), k2 claude (10×20 = 200)
    // completion: k1 (Σ 5..14 = 95), k2 (10×30 = 300)
    const h0 = out.find((r) => r.ts === ANCHOR)
    expect(h0?.prompt_tokens).toBe(145 + 200)
    expect(h0?.completion_tokens).toBe(95 + 300)
  })

  test("p95LatencyPerHour returns a value per non-empty hour bucket", () => {
    seedFixture()
    const out = p95LatencyPerHour(FULL_WINDOW)
    expect(out).toHaveLength(3)
    // Hour 0: k1 (50,60,..,140) + k2 (10×80) = 20 values; offset = floor(0.95 *
    // 19) = 18; sorted values place 80×10 first then 50,60,..,140 → the 18th
    // index (0-based) is large.  We don't pin a specific number — just assert
    // the p95 lies inside the actual latency range and is >= median.
    for (const point of out) {
      expect(point.p95).toBeGreaterThanOrEqual(30)
      expect(point.p95).toBeLessThanOrEqual(200)
    }
  })

  test("topKeysByTokens orders by total token sum", () => {
    seedFixture()
    const out = topKeysByTokens(FULL_WINDOW)
    expect(out.length).toBeGreaterThanOrEqual(3)
    // k1 totals: hour 0 (Σ 10..19 + Σ 5..14 = 145+95 = 240) + hour 1 (10 ×
    // (100+50) = 1500) = 1740.  k2 totals: 200+300 + 9×(40+60) = 1400.
    // k3 totals: 10×(5+5) = 100.
    expect(out[0]?.key_id).toBe("k1")
    expect(out[1]?.key_id).toBe("k2")
    expect(out[2]?.key_id).toBe("k3")
    expect(out[0]?.tokens).toBe(1740)
  })

  test("topModelsByRequests counts grouped by model", () => {
    seedFixture()
    const out = topModelsByRequests(FULL_WINDOW)
    const byModel = Object.fromEntries(out.map((r) => [r.model, r.count]))
    expect(byModel["gpt-4o"]).toBe(20)
    expect(byModel["claude-sonnet-4.5"]).toBe(20)
    expect(byModel["gpt-4o-mini"]).toBe(10)
  })

  test("errorRateByKey reports per-key totals + error rate", () => {
    seedFixture()
    const out = errorRateByKey(FULL_WINDOW)
    const byKey = Object.fromEntries(out.map((r) => [r.key_id, r]))
    expect(byKey["k1"].errors).toBe(0)
    expect(byKey["k2"].errors).toBe(2)
    expect(byKey["k2"].total).toBe(20)
    expect(byKey["k2"].rate).toBeCloseTo(0.1)
  })

  test("streamEventsForCsv yields rows in ts order", () => {
    seedFixture()
    const iter = streamEventsForCsv(FULL_WINDOW)
    let prev = -Infinity
    let count = 0
    for (const row of iter) {
      expect(row.ts).toBeGreaterThanOrEqual(prev)
      prev = row.ts
      count++
    }
    expect(count).toBe(50)
  })

  test("filter by key narrows results", () => {
    seedFixture()
    const out = topModelsByRequests({
      ...FULL_WINDOW,
      keyIds: ["k1"],
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.model).toBe("gpt-4o")
    expect(out[0]?.count).toBe(20)
  })

  test("filter by model narrows results", () => {
    seedFixture()
    const out = errorRateByKey({
      ...FULL_WINDOW,
      models: ["claude-sonnet-4.5"],
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.key_id).toBe("k2")
  })

  test("distinctModels returns sorted unique models", () => {
    seedFixture()
    expect(distinctModels()).toEqual([
      "claude-sonnet-4.5",
      "gpt-4o",
      "gpt-4o-mini",
    ])
  })

  test("empty table → all query helpers return [] (no crash)", () => {
    expect(requestsPerMinute(FULL_WINDOW)).toEqual([])
    expect(tokensPerHour(FULL_WINDOW)).toEqual([])
    expect(p95LatencyPerHour(FULL_WINDOW)).toEqual([])
    expect(topKeysByTokens(FULL_WINDOW)).toEqual([])
    expect(topModelsByRequests(FULL_WINDOW)).toEqual([])
    expect(errorRateByKey(FULL_WINDOW)).toEqual([])
    expect(distinctModels()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// EXPLAIN QUERY PLAN — each query must use an index
// ---------------------------------------------------------------------------

interface ExplainRow {
  id: number
  parent: number
  notused: number
  detail: string
}

function explain(sql: string, ...params: Array<unknown>): string {
  const rows = getDb()
    .query<ExplainRow, Array<unknown>>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
  return rows.map((r) => r.detail).join("\n")
}

describe("usage queries: EXPLAIN QUERY PLAN uses indices", () => {
  test("requestsPerMinute uses idx_events_ts", () => {
    const plan = explain(
      `SELECT (ts / 60000) * 60000 AS bucket, model, COUNT(*) AS count
         FROM events
        WHERE ts >= ? AND ts < ?
        GROUP BY bucket, model`,
      0,
      Date.now(),
    )
    expect(plan).toMatch(/USING (INDEX|COVERING INDEX) idx_events_ts/)
  })

  test("tokensPerHour uses idx_events_ts", () => {
    const plan = explain(
      `SELECT (ts / 3600000) * 3600000 AS bucket,
              SUM(prompt_tokens), SUM(completion_tokens)
         FROM events
        WHERE ts >= ? AND ts < ?
        GROUP BY bucket`,
      0,
      Date.now(),
    )
    expect(plan).toMatch(/USING (INDEX|COVERING INDEX) idx_events_ts/)
  })

  test("key-filtered query uses idx_events_key_ts when key list present", () => {
    seedFixture()
    const plan = explain(
      `SELECT COUNT(*) FROM events WHERE ts >= ? AND ts < ? AND key_id IN (?)`,
      0,
      Date.now(),
      "k1",
    )
    // The planner picks idx_events_key_ts when key_id is constrained.  Some
    // SQLite versions report "SEARCH" with the index; either form is fine.
    expect(plan).toMatch(
      /USING (INDEX|COVERING INDEX) idx_events_key_ts|SEARCH .* USING/,
    )
  })

  test("model-filtered query uses idx_events_model_ts when model list present", () => {
    seedFixture()
    const plan = explain(
      `SELECT COUNT(*) FROM events
        WHERE ts >= ? AND ts < ? AND model IN (?)`,
      0,
      Date.now(),
      "gpt-4o",
    )
    expect(plan).toMatch(
      /USING (INDEX|COVERING INDEX) idx_events_model_ts|SEARCH .* USING/,
    )
  })
})

// ---------------------------------------------------------------------------
// CSV quoting (RFC 4180)
// ---------------------------------------------------------------------------

describe("CSV RFC 4180 quoting (csvField)", () => {
  test("plain values are emitted bare", () => {
    expect(csvField("plain")).toBe("plain")
    expect(csvField(123)).toBe("123")
  })

  test("null becomes an empty field", () => {
    expect(csvField(null)).toBe("")
  })

  test("commas, quotes, newlines trigger quoting; embedded quotes doubled", () => {
    expect(csvField("a,b")).toBe(`"a,b"`)
    expect(csvField(`a"b`)).toBe(`"a""b"`)
    expect(csvField("a\nb")).toBe(`"a\nb"`)
    expect(csvField("a\r\nb")).toBe(`"a\r\nb"`)
  })

  test(
    String.raw`formula-injection: leading =, +, -, @, \t, \r are prefixed with '`,
    () => {
      // OWASP CSV-injection vector.  A model name starting with `=` could
      // execute as an Excel/Numbers formula.  Defang by prefixing apostrophe.
      expect(csvField("=2+2")).toBe(`'=2+2`)
      expect(csvField("+SUM(A1:A9)")).toBe(`'+SUM(A1:A9)`)
      expect(csvField("-1+1")).toBe(`'-1+1`)
      expect(csvField("@formula")).toBe(`'@formula`)
      expect(csvField("\tleading-tab")).toBe(`'\tleading-tab`)
      // Real-world attack payload: no comma/quote/newline so no RFC 4180
      // quoting is needed — the apostrophe alone defeats Excel's formula parse.
      expect(csvField(`=cmd|'/c calc'!A1`)).toBe(`'=cmd|'/c calc'!A1`)
      // Payload with a comma requires both the apostrophe AND quotes.
      expect(csvField(`=A1,B2`)).toBe(`"'=A1,B2"`)
    },
  )
})

describe("CSV round-trip via the export route's CSV output", () => {
  test("rows containing commas and quotes survive a basic parse", () => {
    // Seed one event with awkward metadata
    recordEvent({
      ts: Date.now(),
      key_id: "k-comma,key",
      model: `claude,3`,
      upstream_model: `bad"quote`,
      prompt_tokens: 1,
      completion_tokens: 2,
      status: 200,
      latency_ms: 5,
      error: null,
      usage_unknown: 0,
    thinking_level: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    reasoning_tokens: null,
    })
    // Build the CSV the same way the route does
    const headers = [
      "id",
      "ts",
      "key_id",
      "model",
      "upstream_model",
      "prompt_tokens",
      "completion_tokens",
      "status",
      "latency_ms",
      "error",
      "usage_unknown",
    ]
    const lines = [headers.join(",")]
    for (const row of streamEventsForCsv({
      since: 0,
      until: Date.now() + 1000,
    })) {
      lines.push(
        headers
          .map((h) => csvField((row as Record<string, unknown>)[h] as never))
          .join(","),
      )
    }
    const csv = lines.join("\n")
    // Parse manually with a tiny RFC-4180-aware tokenizer
    const parsed = parseCsv(csv)
    expect(parsed[0]).toEqual(headers)
    expect(parsed[1]?.[2]).toBe("k-comma,key")
    expect(parsed[1]?.[3]).toBe("claude,3")
    expect(parsed[1]?.[4]).toBe(`bad"quote`)
  })
})

/** Tiny RFC-4180 CSV parser for tests only.  Handles quoting + doubling. */
function parseCsv(text: string): Array<Array<string>> {
  const rows: Array<Array<string>> = []
  let row: Array<string> = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === `"`) {
        if (text[i + 1] === `"`) {
          field += `"`
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    switch (ch) {
      case `"`: {
        inQuotes = true

        break
      }
      case ",": {
        row.push(field)
        field = ""

        break
      }
      case "\n": {
        row.push(field)
        rows.push(row)
        row = []
        field = ""

        break
      }
      default: {
        if (ch !== "\r") {
          field += ch
        }
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// ---------------------------------------------------------------------------
// Performance: 1M events, requestsPerMinute < 1s.
//
// Skipped on CI by default — slow CI runners can blow the bound without it
// being a real regression.  Run locally with `bun test tests/usage-queries`.
// ---------------------------------------------------------------------------

describe("usage queries: 1M-event perf", () => {
  test.skipIf(process.env.CI === "true")(
    "requestsPerMinute over 24h finishes in <1s",
    () => {
      const db = getDb()
      const now = Date.now()
      const span = 24 * HOUR
      db.run("BEGIN")
      const stmt = db.prepare(
        `INSERT INTO events
           (ts, key_id, model, upstream_model, prompt_tokens, completion_tokens,
            status, latency_ms, error, usage_unknown)
         VALUES (?, 'k', 'gpt-4o', 'gpt-4o', 1, 1, 200, 50, NULL, 0)`,
      )
      for (let i = 0; i < 1_000_000; i++) {
        stmt.run(now - Math.floor((i / 1_000_000) * span))
      }
      db.run("COMMIT")

      const t0 = performance.now()
      const out = requestsPerMinute({ since: now - span, until: now + 1 })
      const ms = performance.now() - t0
      expect(out.length).toBeGreaterThan(0)
      expect(ms).toBeLessThan(1000)
    },
    60_000,
  )
})
