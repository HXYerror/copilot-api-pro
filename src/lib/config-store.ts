import { consola } from "consola"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
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
  upstream: z.string(),
  enabled: z.boolean().default(true),
  allowed_keys: z.array(z.string()).default(["*"]),
})

const RetentionSchema = z.object({
  events_days: z.number().int().min(0).default(90),
  traces_days: z.number().int().min(0).default(7),
  traces_max_bytes: z.number().int().min(0).default(104857600), // 100MB
})

const FeaturesSchema = z.object({
  auth: z.boolean().default(false),
  telemetry: z.boolean().default(false),
  debug: z.boolean().default(false),
})

export const ConfigSchema = z.object({
  version: z.literal(1),
  models: z.preprocess((v) => v ?? {}, z.record(z.string(), ModelEntrySchema)),
  retention: z.preprocess((v) => v ?? {}, RetentionSchema),
  features: z.preprocess((v) => v ?? {}, FeaturesSchema),
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
  const tmpPath = `${filePath}.tmp`
  const dir = path.dirname(filePath)

  // Ensure parent directory exists
  fs.mkdirSync(dir, { recursive: true })

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
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

export async function loadConfig(filePath = configPath()): Promise<Config> {
  const dir = path.dirname(filePath)
  await fsPromises.mkdir(dir, { recursive: true })

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
  return deepFreeze(structuredClone(_currentConfig))
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
    if (changedFile !== filename) return

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
        onChange(result.data)
      })()
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
