import { afterEach, describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveAlias, resolveUpstream } from "../src/lib/alias"
import { loadConfig } from "../src/lib/config-store"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a temporary config JSON file and load it into the config store. */
async function loadTmpConfig(
  models: Record<string, { upstream: string }>,
): Promise<void> {
  const filePath = join(
    tmpdir(),
    `alias-test-${Date.now()}-${Math.random()}.json`,
  )
  await writeFile(filePath, JSON.stringify({ version: 1, models }), "utf8")
  await loadConfig(filePath)
}

/** Reset to empty models after each test. */
afterEach(async () => {
  await loadTmpConfig({})
})

// ---------------------------------------------------------------------------
// resolveAlias — pass-through when no config entry
// ---------------------------------------------------------------------------

describe("resolveAlias — no matching alias", () => {
  test("returns input unchanged when models map is empty", () => {
    // Default config has empty models
    expect(resolveAlias("gpt-4o")).toBe("gpt-4o")
  })

  test("returns input unchanged for unknown model when entries exist", async () => {
    await loadTmpConfig({ "my-alias": { upstream: "gpt-4o" } })
    expect(resolveAlias("completely-unknown-model")).toBe(
      "completely-unknown-model",
    )
  })
})

// ---------------------------------------------------------------------------
// resolveAlias — matching alias → returns upstream
// ---------------------------------------------------------------------------

describe("resolveAlias — matching alias", () => {
  test("resolves a simple alias to its upstream model", async () => {
    await loadTmpConfig({ fast: { upstream: "gpt-4o-mini" } })
    expect(resolveAlias("fast")).toBe("gpt-4o-mini")
  })

  test("resolves one alias among several", async () => {
    await loadTmpConfig({
      fast: { upstream: "gpt-4o-mini" },
      smart: { upstream: "gpt-4o" },
      big: { upstream: "claude-opus-4" },
    })
    expect(resolveAlias("smart")).toBe("gpt-4o")
    expect(resolveAlias("fast")).toBe("gpt-4o-mini")
    expect(resolveAlias("big")).toBe("claude-opus-4")
  })
})

// ---------------------------------------------------------------------------
// resolveUpstream — pass-through when no matching upstream
// ---------------------------------------------------------------------------

describe("resolveUpstream — no matching upstream", () => {
  test("returns upstream unchanged when models map is empty", () => {
    expect(resolveUpstream("gpt-4o")).toBe("gpt-4o")
  })

  test("returns upstream unchanged when it does not match any entry", async () => {
    await loadTmpConfig({ "my-alias": { upstream: "gpt-4o" } })
    expect(resolveUpstream("gpt-4o-mini")).toBe("gpt-4o-mini")
  })
})

// ---------------------------------------------------------------------------
// resolveUpstream — matching upstream → returns alias
// ---------------------------------------------------------------------------

describe("resolveUpstream — matching upstream", () => {
  test("rewrites a known upstream name back to its alias", async () => {
    await loadTmpConfig({ fast: { upstream: "gpt-4o-mini" } })
    expect(resolveUpstream("gpt-4o-mini")).toBe("fast")
  })

  test("returns one alias when multiple aliases map to same upstream", async () => {
    await loadTmpConfig({
      "alias-a": { upstream: "gpt-4o" },
      "alias-b": { upstream: "gpt-4o" },
    })
    const result = resolveUpstream("gpt-4o")
    expect(["alias-a", "alias-b"]).toContain(result)
  })
})

// ---------------------------------------------------------------------------
// Alias functions do NOT modify body content strings (tool call JSON guard)
// ---------------------------------------------------------------------------

describe("alias functions only operate on the model field — not body content", () => {
  test('resolveAlias does not touch a string containing "model":"gpt-4"', async () => {
    await loadTmpConfig({ "gpt-4": { upstream: "gpt-4o" } })
    // A tool-call argument JSON blob passed verbatim — should not be modified
    const toolArgJson = '{"model":"gpt-4","temperature":0.5}'
    // resolveAlias only looks up exact model names; the blob is not a key
    expect(resolveAlias(toolArgJson)).toBe(toolArgJson)
  })

  test("resolveUpstream does not touch a string containing the upstream name", async () => {
    await loadTmpConfig({ alias: { upstream: "gpt-4o" } })
    const toolArgJson = '{"model":"gpt-4o","max_tokens":100}'
    expect(resolveUpstream(toolArgJson)).toBe(toolArgJson)
  })
})
