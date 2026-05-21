/**
 * Shared formatting / colouring / error-extraction helpers used across the
 * Logs page (table rows, detail drawer, trace legs).
 */

const NUM_FMT = new Intl.NumberFormat("en", { notation: "compact" })

export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—"
  return NUM_FMT.format(n)
}

export function fmtRelative(ts: number): string {
  const age = Date.now() - ts
  if (age < 60_000) return `${Math.floor(age / 1000)}s ago`
  if (age < 3600_000) return `${Math.floor(age / 60_000)}m ago`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`
  return `${Math.floor(age / 86_400_000)}d ago`
}

export function fmtAbsolute(ts: number): string {
  return new Date(ts).toLocaleString()
}

export const STATUS_COLOR = (
  status: number,
): "rose" | "amber" | "emerald" | "slate" => {
  if (status >= 500) return "rose"
  if (status >= 400) return "amber"
  if (status >= 200 && status < 300) return "emerald"
  return "slate"
}

/**
 * Render the raw thinking_level enum string from the events table verbatim,
 * with a tiny bit of polish for the well-known shapes:
 *
 *   - "low" / "medium" / "high" / "xhigh"  → as-is (Claude Code v2.x effort)
 *   - "adaptive" / "enabled"               → as-is (Anthropic mode flag alone)
 *   - "effort:high"                        → "high" (OpenAI reasoning effort)
 *   - "10000"                              → "10K" (legacy budget, K-formatted)
 *   - anything else                        → as-is (forward-compat)
 *
 * The intent is to show the **raw** signal the client sent so operators can
 * spot exactly what level the request asked for.
 */
export function thinkingLabel(level: string | null): string {
  if (!level) return "—"
  if (level.startsWith("effort:")) return level.slice("effort:".length)
  const n = Number.parseInt(level, 10)
  if (Number.isFinite(n) && String(n) === level) {
    return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
  }
  return level
}

export function thinkingBadgeColor(
  level: string | null,
): "violet" | "indigo" | "blue" | "slate" {
  if (!level) return "slate"
  // Claude Code v2.x effort enum
  if (level === "xhigh" || level === "effort:xhigh") return "violet"
  if (level === "high" || level === "effort:high") return "violet"
  if (level === "medium" || level === "effort:medium") return "indigo"
  if (level === "low" || level === "effort:low") return "blue"
  // Budget values: bigger budget → warmer colour
  const n = Number.parseInt(level, 10)
  if (Number.isFinite(n) && String(n) === level) {
    if (n >= 50_000) return "violet"
    if (n >= 25_000) return "indigo"
    return "blue"
  }
  return "blue"
}

/**
 * Pull the human-readable error message out of a trace's response bodies.
 *
 * The events table only stores a short tag (`bad_request`, `forbidden`, …)
 * — useful for filtering, useless for diagnosing the actual failure. The
 * full upstream message lives in trace.upstream_res.body (when present) or
 * trace.res.body (what we returned to the client). Both can be:
 *   - a plain object: { error: { message: "..." } }
 *   - a JSON string of the above
 *   - DOUBLE-encoded: { error: { message: "{\"error\":{\"message\":\"...\"}}" } }
 *     (forwardError stringifies the upstream error into the outer message)
 *
 * Returns a single-line summary or null when no error detail is locatable.
 */
export function extractErrorDetail(
  trace:
    | {
        upstream_res?: { body?: unknown }
        res?: { body?: unknown }
      }
    | undefined,
): string | null {
  if (!trace) return null

  const candidates: Array<unknown> = []
  if (trace.upstream_res?.body !== undefined) {
    candidates.push(trace.upstream_res.body)
  }
  if (trace.res?.body !== undefined) {
    candidates.push(trace.res.body)
  }

  for (const raw of candidates) {
    const msg = digErrorMessage(raw)
    if (msg) return msg
  }
  return null
}

function digStringMessage(raw: string, depth: number): string | null {
  if (raw.length === 0) return null
  try {
    return digErrorMessage(JSON.parse(raw), depth + 1)
  } catch {
    // Not JSON; only return as-is when short enough to be a real msg.
    return raw.length < 400 ? raw : null
  }
}

function digErrorField(err: unknown, depth: number): string | null {
  if (typeof err === "string") return digErrorMessage(err, depth + 1)
  if (typeof err !== "object" || err === null) return null
  const m = (err as Record<string, unknown>)["message"]
  if (typeof m !== "string") return null
  // m may itself be a stringified inner error envelope.
  return digErrorMessage(m, depth + 1) ?? m
}

function digErrorMessage(raw: unknown, depth = 0): string | null {
  if (depth > 4 || raw === undefined || raw === null) return null

  // String — try to parse as JSON, else treat as the message itself if it
  // looks like one (contains `error` substring).
  if (typeof raw === "string") return digStringMessage(raw, depth)
  if (typeof raw !== "object") return null

  const obj = raw as Record<string, unknown>

  // Shape 1: { error: { message: "..." } } or { error: { message: "..." , type: "..." } }
  if (obj["error"] !== undefined) {
    const fromErr = digErrorField(obj["error"], depth)
    if (fromErr) return fromErr
  }

  // Shape 2: { message: "..." } at top level
  const topMsg = obj["message"]
  if (typeof topMsg === "string") {
    return digErrorMessage(topMsg, depth + 1) ?? topMsg
  }

  return null
}

export type StatusFilter = "all" | "ok" | "error"
export type KindFilter = "messages" | "other" | "all"
