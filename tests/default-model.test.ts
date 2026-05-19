import { afterEach, describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadConfig } from "../src/lib/config-store"
import {
  isResolveError,
  resolveModelWithDefault,
} from "../src/lib/default-model"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const models = {
  sonnet: {
    upstream: "claude-sonnet-4",
    enabled: true,
    allowed_keys: ["*"],
  },
  opus47: {
    upstream: "claude-opus-4-7",
    enabled: true,
    allowed_keys: ["*"],
  },
  "gpt-4o": {
    upstream: "gpt-4o",
    enabled: true,
    allowed_keys: ["*"],
  },
}

// Reset config store after schema tests touch _currentConfig.
afterEach(async () => {
  const tmp = join(tmpdir(), `defmodel-reset-${Date.now()}.json`)
  await writeFile(tmp, JSON.stringify({ version: 1, models: {} }), "utf8")
  await loadConfig(tmp)
})

// ---------------------------------------------------------------------------
// Happy path — configured alias is returned verbatim
// ---------------------------------------------------------------------------

describe("resolveModelWithDefault — configured aliases pass through", () => {
  test("returns the requested alias when it exists in models", () => {
    const r = resolveModelWithDefault("sonnet", models, "opus47")
    expect(isResolveError(r)).toBe(false)
    if (isResolveError(r)) return
    expect(r.requested).toBe("sonnet")
    expect(r.effective).toBe("sonnet")
    expect(r.upstream).toBe("claude-sonnet-4")
    expect(r.rewritten).toBe(false)
  })

  test("does not rewrite even when default is set", () => {
    const r = resolveModelWithDefault("gpt-4o", models, "opus47")
    if (isResolveError(r)) throw new Error("unexpected error")
    expect(r.rewritten).toBe(false)
    expect(r.effective).toBe("gpt-4o")
  })
})

// ---------------------------------------------------------------------------
// Fallback — unknown alias gets rewritten to default
// ---------------------------------------------------------------------------

describe("resolveModelWithDefault — unknown alias rewrites to default", () => {
  test("rewrites unknown name to default_model_alias when set", () => {
    const r = resolveModelWithDefault("claude-opus-4-7", models, "opus47")
    if (isResolveError(r)) throw new Error("unexpected error")
    expect(r.requested).toBe("claude-opus-4-7")
    expect(r.effective).toBe("opus47")
    expect(r.upstream).toBe("claude-opus-4-7")
    expect(r.rewritten).toBe(true)
  })

  test("rewrites typos to default", () => {
    const r = resolveModelWithDefault("snnet", models, "sonnet")
    if (isResolveError(r)) throw new Error("unexpected error")
    expect(r.rewritten).toBe(true)
    expect(r.effective).toBe("sonnet")
  })

  test("preserves the requested name for telemetry", () => {
    const r = resolveModelWithDefault("brand-new-model-xyz", models, "opus47")
    if (isResolveError(r)) throw new Error("unexpected error")
    expect(r.requested).toBe("brand-new-model-xyz")
    expect(r.effective).toBe("opus47")
  })
})

// ---------------------------------------------------------------------------
// Error path — no default + unknown alias → 400
// ---------------------------------------------------------------------------

describe("resolveModelWithDefault — error cases", () => {
  test("returns error when alias is unknown and no default is configured", () => {
    const r = resolveModelWithDefault("totally-unknown", models, "")
    expect(isResolveError(r)).toBe(true)
    if (!isResolveError(r)) return
    expect(r.code).toBe("unknown_model_no_default")
    expect(r.message).toContain("totally-unknown")
    expect(r.message).toContain("not configured")
  })

  test("returns error when default_model_alias is set but missing from models", () => {
    // Schema validation usually prevents this — but a hot-reload race or a
    // manually-edited config.json could land us here. We must NOT silently
    // pick a different model.
    const r = resolveModelWithDefault("anything", models, "stale-alias-xyz")
    expect(isResolveError(r)).toBe(true)
    if (!isResolveError(r)) return
    expect(r.code).toBe("default_model_alias_misconfigured")
  })

  test("returns error for empty model field", () => {
    const r = resolveModelWithDefault("", models, "opus47")
    expect(isResolveError(r)).toBe(true)
    if (!isResolveError(r)) return
    expect(r.code).toBe("empty_model_field")
  })

  test("returns error for undefined model field", () => {
    const r = resolveModelWithDefault(undefined, models, "opus47")
    expect(isResolveError(r)).toBe(true)
    if (!isResolveError(r)) return
    expect(r.code).toBe("empty_model_field")
  })
})

// ---------------------------------------------------------------------------
// Prototype-chain safety — Object.hasOwn rather than `in`
// ---------------------------------------------------------------------------

describe("resolveModelWithDefault — prototype-chain safety", () => {
  test("does not treat __proto__ as a configured alias", () => {
    const r = resolveModelWithDefault("__proto__", models, "opus47")
    if (isResolveError(r)) throw new Error("unexpected error")
    // __proto__ is not in our map; the fallback should kick in.
    expect(r.rewritten).toBe(true)
    expect(r.effective).toBe("opus47")
  })

  test("does not treat constructor as a configured alias", () => {
    const r = resolveModelWithDefault("constructor", models, "opus47")
    if (isResolveError(r)) throw new Error("unexpected error")
    expect(r.rewritten).toBe(true)
  })
})
