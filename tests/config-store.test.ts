import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  ConfigSchema,
  type Config,
  getConfig,
  loadConfig,
  saveConfig,
  watchConfig,
} from "../src/lib/config-store"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-store-test-"))
  return dir
}

function makeConfigPath(dir: string): string {
  return path.join(dir, "config.json")
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
}

const validComplete: Config = {
  version: 1,
  models: {
    "gpt-4o": {
      upstream: "https://api.example.com",
      enabled: true,
      allowed_keys: ["*"],
    },
  },
  retention: {
    events_days: 30,
    traces_days: 7,
    traces_max_bytes: 104857600,
  },
  features: {
    auth: true,
    telemetry: false,
    debug: false,
  },
}

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe("ConfigSchema — validates a complete config", () => {
  test("accepts a complete valid config", () => {
    const result = ConfigSchema.safeParse(validComplete)
    expect(result.success).toBe(true)
  })

  test("rejects unknown version (version: 2)", () => {
    const result = ConfigSchema.safeParse({ ...validComplete, version: 2 })
    expect(result.success).toBe(false)
  })

  test("rejects missing version field", () => {
    const { version: _v, ...noVersion } = validComplete
    const result = ConfigSchema.safeParse(noVersion)
    expect(result.success).toBe(false)
  })

  test("fills defaults for missing optional fields", () => {
    const result = ConfigSchema.safeParse({ version: 1 })
    expect(result.success).toBe(true)
    if (!result.success) return

    const data = result.data
    expect(data.models).toEqual({})
    expect(data.retention.events_days).toBe(90)
    expect(data.retention.traces_days).toBe(7)
    expect(data.retention.traces_max_bytes).toBe(104857600)
    expect(data.features.auth).toBe(false)
    expect(data.features.telemetry).toBe(false)
    expect(data.features.debug).toBe(false)
  })

  test("fills model-level defaults (enabled, allowed_keys)", () => {
    const result = ConfigSchema.safeParse({
      version: 1,
      models: {
        "my-model": { upstream: "https://example.com" },
      },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    const model = result.data.models["my-model"]
    expect(model.enabled).toBe(true)
    expect(model.allowed_keys).toEqual(["*"])
  })

  test("rejects non-integer events_days", () => {
    const result = ConfigSchema.safeParse({
      version: 1,
      retention: { events_days: 1.5 },
    })
    expect(result.success).toBe(false)
  })

  test("rejects negative retention values", () => {
    const result = ConfigSchema.safeParse({
      version: 1,
      retention: { events_days: -1 },
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig()", () => {
  let tmpDir: string
  let cfgPath: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    cfgPath = makeConfigPath(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("seeds default when file is absent", async () => {
    const config = await loadConfig(cfgPath)
    expect(config.version).toBe(1)
    // The file must now exist
    expect(fs.existsSync(cfgPath)).toBe(true)
    // And be valid JSON matching the schema
    const raw = fs.readFileSync(cfgPath)
    const parsed = ConfigSchema.safeParse(JSON.parse(raw))
    expect(parsed.success).toBe(true)
  })

  test("reads and parses an existing valid config", async () => {
    writeJson(cfgPath, validComplete)
    const config = await loadConfig(cfgPath)
    expect(config.version).toBe(1)
    expect(config.features.auth).toBe(true)
    expect(config.models["gpt-4o"].upstream).toBe("https://api.example.com")
  })

  test("throws on invalid JSON", async () => {
    fs.writeFileSync(cfgPath, "{ not json }", { mode: 0o600 })
    let threw = false
    try {
      await loadConfig(cfgPath)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("throws on schema mismatch (wrong version)", async () => {
    writeJson(cfgPath, { version: 99 })
    let threw = false
    try {
      await loadConfig(cfgPath)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------

describe("saveConfig()", () => {
  let tmpDir: string
  let cfgPath: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    cfgPath = makeConfigPath(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("creates file with mode 0600", () => {
    saveConfig(validComplete, cfgPath)
    expect(fs.existsSync(cfgPath)).toBe(true)
    const stat = fs.statSync(cfgPath)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test("written file is valid JSON matching the schema", () => {
    saveConfig(validComplete, cfgPath)
    const raw = fs.readFileSync(cfgPath)
    const result = ConfigSchema.safeParse(JSON.parse(raw))
    expect(result.success).toBe(true)
  })

  test("is atomic — no .tmp file left behind after write", () => {
    saveConfig(validComplete, cfgPath)
    // With random-suffix tmp files (e.g. config.json.<pid>.<hex>.tmp) there
    // must be no leftover file in the directory matching *.tmp after a
    // successful write.
    const tmpFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"))
    expect(tmpFiles).toHaveLength(0)
  })

  test("overwriting preserves mode 0600", () => {
    saveConfig(validComplete, cfgPath)
    const updated = {
      ...validComplete,
      features: { ...validComplete.features, debug: true },
    }
    saveConfig(updated, cfgPath)
    const stat = fs.statSync(cfgPath)
    expect(stat.mode & 0o777).toBe(0o600)
    const raw = fs.readFileSync(cfgPath)
    const parsed = JSON.parse(raw) as { features: { debug: boolean } }
    expect(parsed.features.debug).toBe(true)
  })

  test("rejects invalid config (bad version) — does not write", () => {
    expect(() =>
      saveConfig({ ...validComplete, version: 2 as 1 }, cfgPath),
    ).toThrow()
    expect(fs.existsSync(cfgPath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// watchConfig
// ---------------------------------------------------------------------------

describe("watchConfig()", () => {
  let tmpDir: string
  let cfgPath: string
  let dispose: (() => void) | null = null

  beforeEach(() => {
    tmpDir = makeTmpDir()
    cfgPath = makeConfigPath(tmpDir)
    // Seed an initial file so watcher directory exists and first load works
    saveConfig(validComplete, cfgPath)
  })

  afterEach(() => {
    if (dispose) {
      dispose()
      dispose = null
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("fires callback on file change (debounced)", async () => {
    let callCount = 0
    let receivedConfig: Config | null = null

    dispose = watchConfig((cfg) => {
      callCount++
      receivedConfig = cfg
    }, cfgPath)

    // Write multiple times within debounce window — should coalesce to 1 call
    const updated = {
      ...validComplete,
      features: { ...validComplete.features, debug: true },
    }
    writeJson(cfgPath, updated)
    writeJson(cfgPath, updated)
    writeJson(cfgPath, updated)

    // Wait longer than the 250ms debounce + some headroom
    await new Promise<void>((resolve) => setTimeout(resolve, 600))

    expect(callCount).toBe(1)
    expect(receivedConfig).not.toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(receivedConfig!.features.debug).toBe(true)
  })

  test("parse error on reload keeps previous valid config", async () => {
    const callbacks: Array<Config> = []

    dispose = watchConfig((cfg) => callbacks.push(cfg), cfgPath)

    // Write corrupt JSON — should NOT invoke callback, should keep previous
    fs.writeFileSync(cfgPath, "{ INVALID JSON !!!", { mode: 0o600 })

    await new Promise<void>((resolve) => setTimeout(resolve, 600))

    // Callback must NOT have been called with a broken config
    expect(callbacks.length).toBe(0)

    // getConfig() still returns the last good config
    const snap = getConfig()
    expect(snap.version).toBe(1)
  })

  test("dispose stops the watcher (no callback after dispose)", async () => {
    let callCount = 0

    const localDispose = watchConfig(() => {
      callCount++
    }, cfgPath)

    // Dispose immediately
    localDispose()

    // Write a change — should not trigger callback
    const updated = {
      ...validComplete,
      features: { ...validComplete.features, auth: true },
    }
    writeJson(cfgPath, updated)

    await new Promise<void>((resolve) => setTimeout(resolve, 600))
    expect(callCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getConfig — frozen snapshot
// ---------------------------------------------------------------------------

describe("getConfig()", () => {
  let tmpDir: string
  let cfgPath: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    cfgPath = makeConfigPath(tmpDir)
    saveConfig(validComplete, cfgPath)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("snapshot is deeply frozen (Object.isFrozen)", async () => {
    await loadConfig(cfgPath)
    const snap = getConfig()
    expect(Object.isFrozen(snap)).toBe(true)
    expect(Object.isFrozen(snap.features)).toBe(true)
    expect(Object.isFrozen(snap.retention)).toBe(true)
    expect(Object.isFrozen(snap.models)).toBe(true)
  })

  test("snapshot is not mutated by a concurrent reload", async () => {
    await loadConfig(cfgPath)
    const snap1 = getConfig()
    const authBefore = snap1.features.auth

    // Simulate a reload by writing new config and loading
    const updated = {
      ...validComplete,
      features: { ...validComplete.features, auth: !authBefore },
    }
    saveConfig(updated, cfgPath)
    await loadConfig(cfgPath)

    // snap1 must be unchanged
    expect(snap1.features.auth).toBe(authBefore)

    // New snapshot reflects the reload
    const snap2 = getConfig()
    expect(snap2.features.auth).toBe(!authBefore)
  })

  test("mutation attempt on frozen snapshot throws in strict mode", async () => {
    await loadConfig(cfgPath)
    const snap = getConfig()
    expect(() => {
      // @ts-expect-error — intentional mutation attempt
      snap.features.debug = true
    }).toThrow()
  })
})
