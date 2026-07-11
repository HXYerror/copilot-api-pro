import { consola } from "consola"
import crypto from "node:crypto"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

import { configPath } from "./paths"

// ---------------------------------------------------------------------------
// Schema
//
// Zod v4 note: `.default({})` on a nested object returns the raw `{}` literal
// without applying inner field defaults.  We use `z.preprocess((v) => v ?? {}, schema)`
// so that a missing sub-object resolves to `{}` and the nested `.default()` calls
// then apply correctly.
// ---------------------------------------------------------------------------

const ModelEntrySchema = z.object({
  // upstream must be a model identifier, not a URL.
  // Reject URL-shaped values to prevent SSRF if this field is ever used as an
  // endpoint. Valid: "gpt-4o", "claude-opus-4". Invalid: "https://…", "//…".
  upstream: z
    .string()
    .regex(
      /^\w[\w.:-]*$/,
      "upstream must be a model ID (e.g. 'gpt-4o'), not a URL",
    ),
  enabled: z.boolean().default(true),
  allowed_keys: z.array(z.string()).default(["*"]),
  /**
   * Optional thinking-effort default for this alias. When the client request
   * does NOT include any thinking signal (no `thinking` field, no
   * `output_config.effort`, no `reasoning_effort`, no `reasoning.effort`),
   * the proxy injects this effort before forwarding upstream.
   *
   * Values:
   *   - `"low"` / `"medium"` / `"high"` / `"xhigh"` — inject as-is (subject
   *     to clampEffortForModel so a model variant with restricted effort
   *     list still gets a valid value)
   *   - `""` (default) — don't inject; respect client's absence
   *
   * Never overrides what the client explicitly sent — purely a fill-in.
   * See HANDOFF.md §5.7 for the thinking protocol details.
   */
  /**
   * Default effort injected when the client sends no thinking signal:
   *   - Claude Code effort enum ("low" | "medium" | "high" | "xhigh" | "max")
   *     — set on `output_config.effort` (Anthropic via effort-2025-11-24
   *     beta), `reasoning_effort` (OpenAI chat-completions with xhigh→high
   *     collapse; `max` treated as `high`), or `reasoning.effort`
   *     (Responses API).
   *   - `""` (default) — don't inject; respect client's absence.
   *
   * The Settings UI narrows the dropdown to each model's catalog-declared
   * `reasoning_effort` array so operators can only pick a value the model
   * actually supports.
   *
   * See HANDOFF.md §5.7 for the thinking protocol details.
   */
  default_effort: z
    .enum(["low", "medium", "high", "xhigh", "max", ""])
    .default(""),
})

const RetentionSchema = z.object({
  events_days: z.number().int().min(0).default(60),
  // On-disk trace persistence. Traces are always written to disk when the
  // trace middleware fires (see src/services/trace-writer.ts) — this knob
  // only controls how long the sweeper keeps them. 60d default matches
  // events_days so operators see a consistent retention window.
  traces_days: z.number().int().min(0).default(60),
  traces_max_bytes: z.number().int().min(0).default(104857600), // 100MB
  audit_days: z.number().int().min(0).default(365),
})

const FeaturesSchema = z.object({
  // v0.8 breaking change: authentication is required by default.
  // To opt out on loopback, pass `--no-auth` on the CLI (see lib/auth-mode.ts).
  // Setting this to `false` in config.json is equivalent to passing `--no-auth`
  // and is still subject to the same safety guard.
  auth: z.boolean().default(true),
  telemetry: z.boolean().default(false),
  debug: z.boolean().default(false),
})

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    models: z.preprocess(
      (v) => v ?? {},
      z.record(z.string(), ModelEntrySchema),
    ),
    retention: z.preprocess((v) => v ?? {}, RetentionSchema),
    features: z.preprocess((v) => v ?? {}, FeaturesSchema),
    // Fallback alias used when a client requests a model that is not in
    // `models`. When set, unconfigured aliases are rewritten to this alias
    // before scope-check and upstream routing. When unset (empty string),
    // unconfigured requests return 400 (see lib/default-model.ts).
    default_model_alias: z.string().default(""),
  })
  .superRefine((cfg, ctx) => {
    if (
      cfg.default_model_alias
      && !Object.hasOwn(cfg.models, cfg.default_model_alias)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["default_model_alias"],
        message: `default_model_alias "${cfg.default_model_alias}" is not defined in models. Add the alias to models first, or clear this field.`,
      })
    }
  })

export type Config = z.infer<typeof ConfigSchema>

// ---------------------------------------------------------------------------
// Default config seed
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Config = ConfigSchema.parse({ version: 1 })

// ---------------------------------------------------------------------------
// In-memory current config
// ---------------------------------------------------------------------------

let _currentConfig: Config = DEFAULT_CONFIG

// ---------------------------------------------------------------------------
// Atomic write helpers
// ---------------------------------------------------------------------------

function fsyncPath(targetPath: string): void {
  // Opening a directory fd for fsync is POSIX-only; skip silently on Windows
  // (rename is still atomic there via the NTFS journal).
  if (os.platform() === "win32") return
  const fd = fs.openSync(targetPath, "r")
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function saveConfig(config: Config, filePath = configPath()): void {
  // Validate before writing (throws on invalid input)
  const parsed = ConfigSchema.parse(config)
  const json = JSON.stringify(parsed, null, 2)
  // Use a PID + random-hex suffix to avoid collisions when saveConfig is
  // called concurrently and to prevent symlink-clobber TOCTOU attacks
  // (O_EXCL would also work but the random suffix is cross-platform).
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  const dir = path.dirname(filePath)

  // Ensure parent directory exists with restrictive permissions (0700 so
  // other local users cannot traverse into it and enumerate file paths).
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  // Write to .tmp atomically: open → write → fsync → close
  const fd = fs.openSync(tmpPath, "w", 0o600)
  try {
    fs.writeSync(fd, json)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }

  // Set mode explicitly (belt-and-suspenders on top of open flags)
  fs.chmodSync(tmpPath, 0o600)

  // Atomic rename over real path
  fs.renameSync(tmpPath, filePath)

  // Sync parent directory to persist the directory entry
  fsyncPath(dir)

  // Keep in-memory view consistent with what was just written to disk
  _currentConfig = parsed
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

export async function loadConfig(filePath = configPath()): Promise<Config> {
  const dir = path.dirname(filePath)
  await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 })

  let raw: string
  try {
    raw = await Bun.file(filePath).text()
  } catch {
    // File missing — seed defaults
    consola.info(`config.json not found, writing defaults to ${filePath}`)
    saveConfig(DEFAULT_CONFIG, filePath)
    _currentConfig = DEFAULT_CONFIG
    return DEFAULT_CONFIG
  }

  // Check file permissions
  try {
    const stat = fs.statSync(filePath)
    const mode = stat.mode & 0o777
    if (mode !== 0o600) {
      consola.warn(
        `config.json has mode 0${mode.toString(8)}, expected 0600. Consider running: chmod 600 ${filePath}`,
      )
    }
  } catch {
    // Ignore stat errors
  }

  // Parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${String(err)}`)
  }

  // Validate against schema
  const result = ConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `config.json schema validation failed: ${result.error.message}`,
    )
  }

  _currentConfig = result.data
  return result.data
}

// ---------------------------------------------------------------------------
// Runtime overrides
//
// Some settings (notably features.auth) can be flipped by CLI flags at startup
// and must win over whatever is persisted in config.json. We keep them in a
// separate slot so getConfig() always reflects them but watchConfig reloads
// don't clobber them.
// ---------------------------------------------------------------------------

interface RuntimeOverrides {
  authEnabled?: boolean
}

let _overrides: RuntimeOverrides = {}

/** Set a runtime override that wins over the persisted config until cleared. */
export function setRuntimeAuthOverride(value: boolean | undefined): void {
  if (value === undefined) {
    delete _overrides.authEnabled
  } else {
    _overrides.authEnabled = value
  }
}

/** Test-only: clear all runtime overrides. */
export function _resetRuntimeOverrides_TEST_ONLY(): void {
  _overrides = {}
}

function applyOverrides(cfg: Config): Config {
  if (_overrides.authEnabled === undefined) return cfg
  return {
    ...cfg,
    features: { ...cfg.features, auth: _overrides.authEnabled },
  }
}

// ---------------------------------------------------------------------------
// getConfig — deeply frozen snapshot
// ---------------------------------------------------------------------------

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj
  Object.freeze(obj)
  for (const key of Object.keys(obj as object)) {
    deepFreeze((obj as Record<string, unknown>)[key])
  }
  return obj
}

export function getConfig(): Readonly<Config> {
  return deepFreeze(applyOverrides(structuredClone(_currentConfig)))
}

// ---------------------------------------------------------------------------
// watchConfig — fs.watch on parent directory, 250ms debounce
// ---------------------------------------------------------------------------

export function watchConfig(
  onChange: (config: Config) => void,
  filePath = configPath(),
): () => void {
  const dir = path.dirname(filePath)
  const filename = path.basename(filePath)

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const watcher = fs.watch(dir, (_eventType, changedFile) => {
    // Guard against null filename (Linux can fire null for directory-level events)
    if (!changedFile || changedFile !== filename) return

    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void (async () => {
        let raw: string
        try {
          raw = await Bun.file(filePath).text()
        } catch (err) {
          consola.warn(
            `config.json reload failed (file unreadable), keeping previous config: ${String(err)}`,
          )
          return
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch (err) {
          consola.warn(
            `config.json reload failed (invalid JSON), keeping previous config: ${String(err)}`,
          )
          return
        }

        const result = ConfigSchema.safeParse(parsed)
        if (!result.success) {
          consola.warn(
            `config.json reload failed schema validation, keeping previous config: ${result.error.message}`,
          )
          return
        }

        _currentConfig = result.data
        // Pass a frozen snapshot with runtime overrides applied so subscribers
        // see the effective config, consistent with getConfig().
        onChange(deepFreeze(applyOverrides(structuredClone(result.data))))
      })().catch((err: unknown) => {
        consola.error(
          `config.json reload: unexpected error in onChange callback: ${String(err)}`,
        )
      })
    }, 250)
  })

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    watcher.close()
  }
}

// ---------------------------------------------------------------------------
// initConfig
// ---------------------------------------------------------------------------

export async function initConfig(
  onChange?: (config: Config) => void,
  filePath = configPath(),
): Promise<() => void> {
  await loadConfig(filePath)
  const dispose = watchConfig(onChange ?? (() => {}), filePath)
  return dispose
}
