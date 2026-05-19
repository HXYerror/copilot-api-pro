/**
 * Structured trace body rendering for the Logs detail drawer.
 *
 * Replaces the raw `JSON.stringify` blob with semantic cards for the two
 * dominant request/response shapes we see in this proxy:
 *
 *   - Anthropic Messages   (request: messages[] with content blocks;
 *                           response: content[] with text/thinking/
 *                           tool_use blocks + usage)
 *   - OpenAI ChatCompletion (request: messages[] of role/content;
 *                            response: choices[].message + usage)
 *
 * The Responses API uses a similar shape (output[].content[]) which the
 * Anthropic-style renderer handles fine.
 *
 * Anything that doesn't match those patterns falls back to a compact JSON
 * <pre>.  All sections collapse via <details>.  A "Raw JSON" toggle on the
 * outer TraceLegStructured switches the whole leg back to the unstructured
 * view for debugging.
 */

import { Badge, Text } from "@tremor/react"
import { useMemo, useState } from "react"

import { aggregateSse } from "./sse-aggregator"

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

/**
 * Try to coerce the captured body into a JS object.  Bodies arrive as either
 * the raw string captured off the wire (the common case), an already-parsed
 * object (when the trace-writer chose to keep it structured), or `null`.
 *
 * SSE bodies (`event: ... data: ...` blocks) get a second chance: we run
 * them through `aggregateSse()` to reconstruct the final non-streaming
 * response shape.  When that succeeds, `parsed` is the synthetic message
 * and `isSse` is set so the renderer can show an "Aggregated" badge.  When
 * aggregation fails (truncated stream / unknown grammar), we keep `parsed:
 * null` and the renderer falls back to the raw view.
 */
export function parseBody(body: unknown): {
  parsed: unknown
  raw: string
  /** Source was an SSE stream — regardless of whether aggregation worked. */
  isSse: boolean
  /** True when we successfully aggregated the SSE stream into `parsed`. */
  sseAggregated: boolean
} {
  if (body === null || body === undefined) {
    return { parsed: null, raw: "", isSse: false, sseAggregated: false }
  }
  if (typeof body === "object") {
    return {
      parsed: body,
      raw: JSON.stringify(body, null, 2),
      isSse: false,
      sseAggregated: false,
    }
  }
  // At this point body is a primitive; narrow to the only sensible case
  // (string) and force everything else through JSON.stringify so we never
  // call String() on a {} that yields "[object Object]".
  const str = typeof body === "string" ? body : JSON.stringify(body)
  // SSE detection — `event: ` lines + `data: ` lines.
  if (str.includes("event:") && str.includes("data:")) {
    const aggregated = aggregateSse(str)
    return {
      parsed: aggregated,
      raw: str,
      isSse: true,
      sseAggregated: aggregated !== null,
    }
  }
  // Some SSE streams (OpenAI chat completion) have no `event:` lines —
  // just `data:` chunks. Try aggregating those too.
  if (str.includes("data:")) {
    const aggregated = aggregateSse(str)
    if (aggregated !== null) {
      return { parsed: aggregated, raw: str, isSse: true, sseAggregated: true }
    }
  }
  if (!str.trim()) {
    return { parsed: null, raw: str, isSse: false, sseAggregated: false }
  }
  try {
    return {
      parsed: JSON.parse(str),
      raw: str,
      isSse: false,
      sseAggregated: false,
    }
  } catch {
    return { parsed: null, raw: str, isSse: false, sseAggregated: false }
  }
}

// ---------------------------------------------------------------------------
// Key metrics extraction (the top KPI bar in the drawer)
// ---------------------------------------------------------------------------

export interface KeyMetrics {
  /** Input/prompt tokens (Anthropic input_tokens || OpenAI prompt_tokens). */
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
  /** Anthropic stop_reason or OpenAI finish_reason. */
  stop_reason?: string
  /**
   * Raw thinking config from the request (e.g. "adaptive", "enabled · 10K",
   * "high"). Empty string when the request didn't ask for thinking.
   */
  thinking?: string
  /** OpenAI reasoning effort (low/medium/high). */
  reasoning_effort?: string
  /** True iff the request body included tools[]. */
  has_tools?: boolean
  /** Count of messages in the request. */
  message_count?: number
  /**
   * Per-response thinking summary, populated from the response content:
   *   - block_count: number of `thinking` blocks the model emitted (0 when
   *     thinking was requested but nothing came back)
   *   - char_count:  total chars of `block.thinking` text across all blocks
   *
   * Anthropic doesn't break out `thinking_tokens` in `usage`, so chars is
   * the best signal we have for "how much did the model actually think".
   */
  thinking_blocks?: number
  thinking_chars?: number
  /** Count of thinking blocks whose plaintext was empty but signature was
   * present (Copilot's Anthropic endpoint encrypts the reasoning).  Lets
   * the KpiBar say "1 blk (encrypted)" instead of "1 blk · 0 ch". */
  thinking_encrypted?: number
  /** OpenAI /responses-only: `usage.output_tokens_details.reasoning_tokens`.
   * Subset of `output_tokens` spent on internal reasoning. Anthropic
   * doesn't expose this — stays undefined for Claude. */
  reasoning_tokens?: number
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/**
 * Extracts metrics from request + response bodies.  Both inputs are the
 * already-parsed JS objects (or null when the body wasn't JSON).  We grab
 * whatever fields exist; absence is silently OK and the KpiBar hides empty
 * cells.
 */
export function extractKeyMetrics(
  request: unknown,
  response: unknown,
): KeyMetrics {
  return {
    ...extractRequestMetrics(request),
    ...extractResponseMetrics(response),
  }
}

/**
 * Map Anthropic thinking config to Claude Code's user-visible level name.
 *
 * Real-world values observed in captured traces and confirmed against the
 * Claude Code source:
 *   - `{ type: "adaptive" }`              → "Auto" (model decides)
 *   - `{ type: "enabled", budget: 10000 }` → "Think hard"
 *   - `{ type: "enabled", budget: 31999 }` → "Think harder"
 *   - `{ type: "enabled", budget: 63999 }` → "Ultrathink"
 *
 * We bucket by range rather than exact value so future Claude Code tweaks
 * (e.g. bumping Ultrathink to 65535) still resolve to the right label. A
 * budget that doesn't fit any bucket falls through as "Custom (NK)" so
 * direct-API users with bespoke budgets still see something meaningful.
 */
/**
 * Render the raw thinking config the client sent as a short label.
 *
 *   {type: "adaptive"}                       → "adaptive"
 *   {type: "enabled", budget_tokens: 10000} → "enabled · 10K"
 *   {budget_tokens: 8000}                   → "8K"
 *   {max_thinking_tokens: 4000}             → "4K"
 *   no thinking field                       → "" (KpiBar hides it)
 *
 * No bucket renaming to Claude Code preset names — operators want the raw
 * signal so they can spot a client sending "low" / "medium" / etc. exactly.
 */
function formatThinkingLevel(
  type: string | undefined,
  budget: number | undefined,
  effort: string | undefined,
): string {
  // output_config.effort is Claude Code's primary signal — show it verbatim
  // ("low" / "medium" / "high" / "xhigh"). When the request also carried a
  // thinking.type, prefix it: "adaptive · xhigh".
  if (effort) return type ? `${type} · ${effort}` : effort
  const budgetLabel =
    budget !== undefined && budget > 0 ?
      budget >= 1000 ?
        `${Math.round(budget / 1000)}K`
      : String(budget)
    : ""
  if (type && budgetLabel) return `${type} · ${budgetLabel}`
  if (type) return type
  return budgetLabel
}

function extractRequestMetrics(request: unknown): KeyMetrics {
  if (!request || typeof request !== "object") return {}
  const r = request as Record<string, unknown>
  const out: KeyMetrics = {}
  // Anthropic thinking can take five real-world shapes:
  //   1. {type:"adaptive"} + output_config:{effort:"low|medium|high|xhigh"}
  //      (Claude Code v2.x — the modern format; effort is the level)
  //   2. {type:"enabled", budget_tokens: N}                    (older clients)
  //   3. {budget_tokens: N}                                    (direct API)
  //   4. {type:"adaptive"} alone                               (model decides)
  //   5. legacy top-level {max_thinking_tokens: N}
  // The label we show is whichever signal the client sent — output_config.
  // effort takes priority because it's the field Copilot actually gates on.
  const thinking = r["thinking"] as
    | { type?: string; budget_tokens?: number }
    | undefined
  const outputConfig = r["output_config"] as { effort?: string } | undefined
  const thinkType = asString(thinking?.type)
  const thinkBudget =
    asNumber(thinking?.budget_tokens) ?? asNumber(r["max_thinking_tokens"])
  const effort = asString(outputConfig?.effort)
  const level = formatThinkingLevel(thinkType, thinkBudget, effort)
  if (level) out.thinking = level
  // OpenAI Responses: `reasoning: { effort: 'low' | ... }`.
  const reasoning = r["reasoning"] as { effort?: string } | undefined
  out.reasoning_effort = asString(reasoning?.effort)
  out.has_tools = Array.isArray(r["tools"]) && r["tools"].length > 0
  if (Array.isArray(r["messages"])) {
    out.message_count = r["messages"].length
  } else if (Array.isArray(r["input"])) {
    out.message_count = r["input"].length
  }
  return out
}

function extractResponseMetrics(response: unknown): KeyMetrics {
  if (!response || typeof response !== "object") return {}
  const r = response as Record<string, unknown>
  const out: KeyMetrics = {}

  // **Primary source**: `copilot_usage.token_details` — Copilot stamps every
  // response (all 3 routes: /v1/messages, /v1/chat/completions, /v1/responses)
  // with a uniform array of { token_type, token_count }. Token types we've
  // observed: input / output / cache_read / cache_write. Reading from here
  // gives us a consistent view regardless of upstream API format.
  const copilot = r["copilot_usage"] as
    | { token_details?: Array<{ token_type?: string; token_count?: number }> }
    | undefined
  if (copilot && Array.isArray(copilot.token_details)) {
    for (const td of copilot.token_details) {
      const n = asNumber(td.token_count)
      if (n === undefined) continue
      switch (td.token_type) {
        case "input": {
          out.input_tokens = n
          break
        }
        case "output": {
          out.output_tokens = n
          break
        }
        case "cache_read": {
          out.cache_read_tokens = n
          break
        }
        case "cache_write": {
          out.cache_creation_tokens = n
          break
        }
        // Forward-compat: future token_types (e.g. thinking) fall through
        // silently — they'll surface in the Raw JSON tab until we surface
        // them here.
      }
    }
  }

  // Fallback: when copilot_usage isn't present (direct API, mock responses,
  // older proxies), fall back to the native shape. Anthropic uses
  // `usage.input_tokens` / `usage.output_tokens`; OpenAI uses
  // `usage.prompt_tokens` / `usage.completion_tokens`.
  const usage = r["usage"] as Record<string, unknown> | undefined
  if (usage) {
    if (out.input_tokens === undefined) {
      out.input_tokens =
        asNumber(usage["input_tokens"]) ?? asNumber(usage["prompt_tokens"])
    }
    if (out.output_tokens === undefined) {
      out.output_tokens =
        asNumber(usage["output_tokens"]) ?? asNumber(usage["completion_tokens"])
    }
    if (out.cache_read_tokens === undefined) {
      out.cache_read_tokens =
        asNumber(usage["cache_read_input_tokens"])
        ?? asNumber(usage["cache_read_tokens"])
    }
    if (out.cache_creation_tokens === undefined) {
      out.cache_creation_tokens =
        asNumber(usage["cache_creation_input_tokens"])
        ?? asNumber(usage["cache_creation_tokens"])
    }
    // OpenAI /responses surfaces reasoning tokens here. Anthropic doesn't.
    const otd = usage["output_tokens_details"] as
      | { reasoning_tokens?: number }
      | undefined
    out.reasoning_tokens = asNumber(otd?.reasoning_tokens)
  }

  out.stop_reason = asString(r["stop_reason"])
  if (!out.stop_reason && Array.isArray(r["choices"])) {
    const first = r["choices"][0] as { finish_reason?: string } | undefined
    out.stop_reason = asString(first?.finish_reason)
  }
  // Anthropic-style content array: count thinking blocks + total chars so
  // the KpiBar can show "thinking: 5 blk · 1.2K chars" even though the
  // Messages API doesn't break out a separate thinking_tokens field.
  //
  // Note: Copilot's Anthropic-compatible endpoint returns thinking blocks
  // with `signature` (an opaque encrypted blob) and an EMPTY `thinking`
  // text. We treat a non-empty signature as evidence that thinking did
  // happen even when no plaintext came back — surface block count anyway.
  const content = r["content"]
  if (Array.isArray(content)) {
    let blocks = 0
    let chars = 0
    let encrypted = 0
    for (const b of content) {
      if (
        b
        && typeof b === "object"
        && (b as { type?: string }).type === "thinking"
      ) {
        blocks += 1
        const t = (b as { thinking?: string }).thinking
        const sig = (b as { signature?: string }).signature
        if (typeof t === "string" && t.length > 0) {
          chars += t.length
        } else if (typeof sig === "string" && sig.length > 0) {
          encrypted += 1
        }
      }
    }
    if (blocks > 0) {
      out.thinking_blocks = blocks
      out.thinking_chars = chars
      out.thinking_encrypted = encrypted
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// KpiBar — top metrics row
// ---------------------------------------------------------------------------

interface KpiBarProps {
  metrics: KeyMetrics
}

const NUM = new Intl.NumberFormat("en", { notation: "compact" })

export function KpiBar({ metrics }: KpiBarProps) {
  const cells: Array<
    [
      string,
      string,
      "blue" | "cyan" | "violet" | "amber" | "emerald" | "rose" | "slate",
    ]
  > = []
  if (metrics.input_tokens !== undefined) {
    cells.push(["Input", NUM.format(metrics.input_tokens), "blue"])
  }
  if (metrics.output_tokens !== undefined) {
    cells.push(["Output", NUM.format(metrics.output_tokens), "cyan"])
  }
  if (metrics.cache_read_tokens !== undefined) {
    cells.push(["Cache hit", NUM.format(metrics.cache_read_tokens), "emerald"])
  }
  if (metrics.cache_creation_tokens !== undefined) {
    cells.push([
      "Cache write",
      NUM.format(metrics.cache_creation_tokens),
      "violet",
    ])
  }
  if (metrics.stop_reason) cells.push(["Stop", metrics.stop_reason, "amber"])
  if (metrics.thinking) cells.push(["Thinking", metrics.thinking, "violet"])
  if (metrics.reasoning_effort) {
    cells.push(["Effort", metrics.reasoning_effort, "violet"])
  }
  // Per-response thinking summary. Anthropic doesn't break out
  // thinking_tokens in usage, so we show block count + char total — useful
  // to spot "thinking was enabled but the model produced 0 blocks" or
  // "thinking budget was 64K but only 50 chars came back". For Copilot's
  // encrypted-thinking responses, surface "encrypted" instead of "0 ch".
  if (metrics.thinking_blocks !== undefined) {
    const encrypted = metrics.thinking_encrypted ?? 0
    const allEncrypted =
      encrypted === metrics.thinking_blocks && metrics.thinking_blocks > 0
    let detail: string
    if (allEncrypted) {
      detail = "encrypted"
    } else if (metrics.thinking_chars !== undefined) {
      detail =
        metrics.thinking_chars >= 1000 ?
          `${(metrics.thinking_chars / 1000).toFixed(1)}K ch`
        : `${metrics.thinking_chars} ch`
    } else {
      detail = "?"
    }
    cells.push([
      "Think out",
      `${metrics.thinking_blocks} blk · ${detail}`,
      "violet",
    ])
  } else if (metrics.thinking) {
    // Thinking was requested but no thinking blocks came back — surface
    // that as an explicit hint instead of hiding the cell entirely.
    cells.push(["Think out", "0 blocks", "slate"])
  }
  // Thinking-tokens count (OpenAI /responses only — Anthropic doesn't
  // separate it out, those rows stay null).
  if (metrics.reasoning_tokens !== undefined && metrics.reasoning_tokens > 0) {
    cells.push(["Think tokens", NUM.format(metrics.reasoning_tokens), "violet"])
  }
  if (metrics.has_tools) cells.push(["Tools", "yes", "blue"])

  if (cells.length === 0) return null

  // Map our tone palette to Tailwind text colours so the value can carry
  // the colour signal directly (instead of an empty <Badge> stub next to
  // it that looked like an alignment dot).
  const TONE_TEXT: Record<(typeof cells)[number][2], string> = {
    blue: "text-blue-700",
    cyan: "text-cyan-700",
    violet: "text-violet-700",
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    slate: "text-tremor-content-strong",
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cells.map(([label, value, tone]) => (
        <div
          key={label}
          className="rounded border border-tremor-border bg-tremor-background-muted px-3 py-2"
        >
          <div className="text-[10px] uppercase tracking-wide text-tremor-content-subtle">
            {label}
          </div>
          <div className={`mt-0.5 text-sm font-semibold ${TONE_TEXT[tone]}`}>
            {value}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ExpandableText — truncate long strings with click-to-expand
// ---------------------------------------------------------------------------

interface ExpandableTextProps {
  text: string
  /** Truncate after this many chars. */
  threshold?: number
  className?: string
}

export function ExpandableText({
  text,
  threshold = 400,
  className,
}: ExpandableTextProps) {
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > threshold
  const shown = expanded || !isLong ? text : text.slice(0, threshold)

  return (
    <span className={className ?? ""}>
      <span className="whitespace-pre-wrap break-words">{shown}</span>
      {isLong && !expanded && (
        <>
          <span className="text-tremor-content-subtle">…</span>
          <button
            onClick={() => setExpanded(true)}
            className="ml-2 text-xs text-tremor-brand-emphasis hover:underline"
          >
            Show {text.length - threshold} more chars
          </button>
        </>
      )}
      {isLong && expanded && (
        <button
          onClick={() => setExpanded(false)}
          className="ml-2 text-xs text-tremor-content-subtle hover:underline"
        >
          Collapse
        </button>
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Content block rendering (Anthropic-style)
// ---------------------------------------------------------------------------

interface AnthropicBlock {
  type: string
  text?: string
  thinking?: string
  signature?: string
  /** tool_use */
  id?: string
  name?: string
  input?: unknown
  /** tool_result */
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function ContentBlock({ block }: { block: AnthropicBlock }) {
  switch (block.type) {
    case "text": {
      return (
        <div className="rounded border border-tremor-border bg-tremor-background px-3 py-2 text-sm">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-tremor-content-subtle">
            text
          </div>
          <ExpandableText text={block.text ?? ""} />
        </div>
      )
    }
    case "thinking": {
      const hasText = (block.thinking ?? "").length > 0
      const sigPreview =
        block.signature ? `${block.signature.slice(0, 12)}…` : null
      return (
        <div className="rounded border border-violet-200 bg-violet-50 px-3 py-2 text-sm">
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-violet-700">
            <span>thinking</span>
            {sigPreview && (
              <span className="mono text-[9px] text-violet-500">
                (signed: {sigPreview})
              </span>
            )}
            {!hasText && sigPreview && (
              <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-violet-700">
                encrypted
              </span>
            )}
          </div>
          {hasText ?
            <ExpandableText text={block.thinking ?? ""} />
          : sigPreview ?
            <span className="text-xs text-violet-700/70">
              Upstream returned this thinking block encrypted — only the
              signature ({block.signature?.length ?? 0} bytes) is exposed, not
              the reasoning text.
            </span>
          : <span className="text-xs text-tremor-content-subtle">(empty)</span>}
        </div>
      )
    }
    case "tool_use": {
      return (
        <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-blue-700">
            <span>tool_use</span>
            <span className="mono text-[10px] font-medium text-blue-900">
              {block.name}
            </span>
            {block.id && (
              <span className="mono text-[9px] text-blue-500">
                {block.id.slice(-8)}
              </span>
            )}
          </div>
          <pre className="mono text-xs whitespace-pre-wrap break-words">
            {JSON.stringify(block.input, null, 2)}
          </pre>
        </div>
      )
    }
    case "tool_result": {
      const contentStr =
        typeof block.content === "string" ?
          block.content
        : JSON.stringify(block.content, null, 2)
      return (
        <div
          className={
            "rounded border px-3 py-2 text-sm "
            + (block.is_error ?
              "border-rose-200 bg-rose-50"
            : "border-emerald-200 bg-emerald-50")
          }
        >
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide">
            <span
              className={block.is_error ? "text-rose-700" : "text-emerald-700"}
            >
              tool_result{block.is_error ? " · error" : ""}
            </span>
            {block.tool_use_id && (
              <span className="mono text-[9px] text-tremor-content-subtle">
                ↳ {block.tool_use_id.slice(-8)}
              </span>
            )}
          </div>
          <ExpandableText text={contentStr} />
        </div>
      )
    }
    default: {
      return (
        <div className="rounded border border-tremor-border bg-tremor-background-muted px-3 py-2 text-sm">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-tremor-content-subtle">
            {block.type}
          </div>
          <pre className="mono text-xs whitespace-pre-wrap break-words">
            {JSON.stringify(block, null, 2)}
          </pre>
        </div>
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Message card (renders one role + its content blocks)
// ---------------------------------------------------------------------------

const ROLE_TONE: Record<string, string> = {
  system: "border-slate-300 bg-slate-50",
  user: "border-blue-200 bg-blue-50",
  assistant: "border-emerald-200 bg-emerald-50",
  tool: "border-amber-200 bg-amber-50",
  developer: "border-violet-200 bg-violet-50",
}

interface Message {
  role: string
  content: unknown
}

function MessageCard({ message }: { message: Message }) {
  const tone =
    ROLE_TONE[message.role] ?? "border-tremor-border bg-tremor-background"
  // content can be: string, array of content blocks, or null.
  let blocks: Array<AnthropicBlock> = []
  if (typeof message.content === "string") {
    blocks = [{ type: "text", text: message.content }]
  } else if (Array.isArray(message.content)) {
    blocks = message.content as Array<AnthropicBlock>
  }

  return (
    <div className={"rounded border-l-4 p-3 " + tone}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-tremor-content-strong">
          {message.role}
        </span>
        <span className="text-[10px] text-tremor-content-subtle">
          {blocks.length} block{blocks.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="space-y-2">
        {blocks.map((b, i) => (
          <ContentBlock key={i} block={b} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tools list (request.tools[])
// ---------------------------------------------------------------------------

interface ToolSchema {
  name?: string
  description?: string
  input_schema?: unknown
  /** OpenAI function-tool shape. */
  function?: { name?: string; description?: string; parameters?: unknown }
}

function ToolsList({ tools }: { tools: Array<ToolSchema> }) {
  return (
    <details className="rounded border border-tremor-border bg-tremor-background">
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tremor-content-strong">
        Tools ({tools.length})
      </summary>
      <div className="space-y-2 border-t border-tremor-border p-3">
        {tools.map((t, i) => {
          const name = t.name ?? t.function?.name ?? `(tool ${i})`
          const desc = t.description ?? t.function?.description
          const schema = t.input_schema ?? t.function?.parameters
          return (
            <details
              key={i}
              className="rounded border border-tremor-border bg-tremor-background-muted"
            >
              <summary className="cursor-pointer px-3 py-2 text-sm">
                <span className="mono font-medium text-tremor-content-strong">
                  {name}
                </span>
                {desc && (
                  <span className="ml-2 text-xs text-tremor-content">
                    — {desc.slice(0, 80)}
                    {desc.length > 80 ? "…" : ""}
                  </span>
                )}
              </summary>
              <pre className="mono px-3 pb-2 pt-1 text-[11px] whitespace-pre-wrap break-words">
                {JSON.stringify(schema, null, 2)}
              </pre>
            </details>
          )
        })}
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// Top-level: structured renderer for a parsed body
// ---------------------------------------------------------------------------

interface StructuredBodyProps {
  body: unknown
}

export function StructuredBody({ body }: StructuredBodyProps) {
  if (!body || typeof body !== "object") {
    return (
      <Text className="text-tremor-content-subtle">
        (body has no structure — toggle to Raw)
      </Text>
    )
  }

  const b = body as Record<string, unknown>

  // ---- Request shape: { model, messages: [...], system?, tools? } -------
  if (Array.isArray(b["messages"])) {
    return <RequestView body={b} />
  }

  // ---- Anthropic response: { content: [...], stop_reason, usage } -----
  if (Array.isArray(b["content"])) {
    return (
      <ResponseView
        contentBlocks={b["content"] as Array<AnthropicBlock>}
        stop_reason={asString(b["stop_reason"])}
        usage={b["usage"]}
        model={asString(b["model"])}
        id={asString(b["id"])}
      />
    )
  }

  // ---- OpenAI chat completion response: { choices: [{ message }], usage } ----
  if (Array.isArray(b["choices"])) {
    const choices = b["choices"] as Array<{
      message?: { role?: string; content?: unknown }
      finish_reason?: string
    }>
    const blocks: Array<AnthropicBlock> = []
    for (const c of choices) {
      const content = c.message?.content
      if (typeof content === "string") {
        blocks.push({ type: "text", text: content })
      } else if (Array.isArray(content)) {
        blocks.push(...(content as Array<AnthropicBlock>))
      }
    }
    return (
      <ResponseView
        contentBlocks={blocks}
        stop_reason={asString(choices[0]?.finish_reason)}
        usage={b["usage"]}
        model={asString(b["model"])}
        id={asString(b["id"])}
      />
    )
  }

  // ---- Responses API non-stream: { output: [...] } ---------------------
  if (Array.isArray(b["output"])) {
    // Flatten output items' .content arrays into a single block stream.
    const blocks: Array<AnthropicBlock> = []
    for (const item of b["output"] as Array<{
      type?: string
      content?: Array<AnthropicBlock>
    }>) {
      if (Array.isArray(item.content)) blocks.push(...item.content)
    }
    return (
      <ResponseView
        contentBlocks={blocks}
        stop_reason={asString(b["status"])}
        usage={b["usage"]}
        model={asString(b["model"])}
        id={asString(b["id"])}
      />
    )
  }

  return (
    <Text className="text-tremor-content-subtle">
      (unrecognised shape — toggle to Raw)
    </Text>
  )
}

// ---------------------------------------------------------------------------
// RequestView — system + tools + messages
// ---------------------------------------------------------------------------

function normaliseSystem(system: unknown): Array<AnthropicBlock> {
  if (typeof system === "string") return [{ type: "text", text: system }]
  if (Array.isArray(system)) return system as Array<AnthropicBlock>
  return []
}

function formatParamValue(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return JSON.stringify(v)
}

function RequestView({ body }: { body: Record<string, unknown> }) {
  const messages = body["messages"] as Array<Message>
  const tools = body["tools"] as Array<ToolSchema> | undefined
  const systemBlocks = normaliseSystem(body["system"])

  // Capture additional top-level params so power-users can see them at a glance.
  const params: Array<[string, unknown]> = []
  for (const k of [
    "model",
    "max_tokens",
    "temperature",
    "top_p",
    "top_k",
    "stream",
  ]) {
    if (k in body) params.push([k, body[k]])
  }

  return (
    <div className="space-y-3">
      {params.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {params.map(([k, v]) => (
            <span
              key={k}
              className="rounded border border-tremor-border bg-tremor-background px-2 py-0.5"
            >
              <span className="text-tremor-content-subtle">{k}:</span>{" "}
              <span className="mono text-tremor-content-strong">
                {formatParamValue(v)}
              </span>
            </span>
          ))}
        </div>
      )}

      {systemBlocks.length > 0 && (
        <details className="rounded border border-slate-300 bg-slate-50">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-700">
            System prompt ({systemBlocks.length} block
            {systemBlocks.length === 1 ? "" : "s"})
          </summary>
          <div className="space-y-2 border-t border-slate-200 p-3">
            {systemBlocks.map((b, i) => (
              <ContentBlock key={i} block={b} />
            ))}
          </div>
        </details>
      )}

      {tools && tools.length > 0 && <ToolsList tools={tools} />}

      <div className="space-y-2">
        {messages.map((m, i) => (
          <MessageCard key={i} message={m} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ResponseView — content blocks + usage + stop_reason
// ---------------------------------------------------------------------------

interface ResponseViewProps {
  contentBlocks: Array<AnthropicBlock>
  stop_reason?: string
  usage?: unknown
  model?: string
  id?: string
}

function ResponseView({
  contentBlocks,
  stop_reason,
  usage,
  model,
  id,
}: ResponseViewProps) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        {model && (
          <span className="rounded border border-tremor-border bg-tremor-background px-2 py-0.5">
            <span className="text-tremor-content-subtle">model:</span>{" "}
            <span className="mono text-tremor-content-strong">{model}</span>
          </span>
        )}
        {stop_reason && (
          <Badge color="amber" size="xs">
            stop: {stop_reason}
          </Badge>
        )}
        {id && (
          <span className="mono text-[10px] text-tremor-content-subtle">
            id: {id}
          </span>
        )}
      </div>

      <div className="space-y-2">
        {contentBlocks.length === 0 ?
          <Text className="text-tremor-content-subtle">
            (no content blocks)
          </Text>
        : contentBlocks.map((b, i) => <ContentBlock key={i} block={b} />)}
      </div>

      {usage !== undefined && usage !== null && (
        <details className="rounded border border-tremor-border bg-tremor-background-muted">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tremor-content-strong">
            Usage
          </summary>
          <pre className="mono px-3 pb-2 pt-1 text-[11px] whitespace-pre-wrap break-words">
            {JSON.stringify(usage, null, 2)}
          </pre>
        </details>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TraceLegStructured — drop-in replacement for the body section of TraceLegPanel
// ---------------------------------------------------------------------------

interface TraceLegStructuredProps {
  /** Raw body as captured by the trace writer (string | object | null). */
  body: unknown
}

function SseBadge({ aggregated }: { aggregated: boolean }) {
  return aggregated ?
      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-emerald-700">
        SSE aggregated
      </span>
    : <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-700">
        SSE (raw)
      </span>
}

export function TraceLegStructured({ body }: TraceLegStructuredProps) {
  const [view, setView] = useState<"structured" | "raw">("structured")
  const { parsed, raw, isSse, sseAggregated } = useMemo(
    () => parseBody(body),
    [body],
  )

  // Disable Structured only when the body IS an SSE stream and aggregation
  // failed (truncated stream / unrecognised grammar). Successfully aggregated
  // streams behave like normal JSON bodies for the renderer.
  const structuredAvailable = !isSse || sseAggregated
  const effective = structuredAvailable ? view : "raw"

  if (!raw && parsed === null) {
    return (
      <div className="text-xs text-tremor-content-subtle">(empty body)</div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-medium text-tremor-content-strong">
          Body
          {isSse && <SseBadge aggregated={sseAggregated} />}
        </div>
        <div className="flex rounded border border-tremor-border text-xs">
          <button
            onClick={() => setView("structured")}
            disabled={!structuredAvailable}
            className={
              "px-2 py-0.5 "
              + (effective === "structured" ?
                "bg-tremor-brand text-white"
              : "text-tremor-content hover:bg-tremor-background-muted")
              + (structuredAvailable ? "" : " cursor-not-allowed opacity-50")
            }
          >
            Structured
          </button>
          <button
            onClick={() => setView("raw")}
            className={
              "border-l border-tremor-border px-2 py-0.5 "
              + (effective === "raw" ?
                "bg-tremor-brand text-white"
              : "text-tremor-content hover:bg-tremor-background-muted")
            }
          >
            Raw {isSse ? "SSE" : "JSON"}
          </button>
        </div>
      </div>
      {effective === "structured" && <StructuredBody body={parsed} />}
      {effective === "raw" && (
        <pre className="rounded bg-tremor-background-muted p-3 mono text-xs whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
          {raw}
        </pre>
      )}
      {isSse && !sseAggregated && (
        <div className="text-[10px] text-tremor-content-subtle">
          SSE aggregation didn't recognise this stream — showing raw events.
        </div>
      )}
    </div>
  )
}

// Re-export Card to keep imports neat from Logs.tsx

export { Card } from "@tremor/react"
