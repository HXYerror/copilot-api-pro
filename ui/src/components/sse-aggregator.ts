/**
 * SSE → JSON aggregator for the Logs structured viewer.
 *
 * The trace writer captures Anthropic / OpenAI streaming responses as a
 * concatenated `event: X\ndata: {...}\n\n` blob.  The structured renderer
 * works on JSON objects, not on streams.  This module walks the captured
 * blob, reconstructs the final assistant message, and returns a synthetic
 * non-streaming response that the existing structured renderer can show.
 *
 * Two grammars are recognised:
 *
 *   1. **Anthropic Messages**: `message_start` → seed envelope; one or more
 *      `content_block_start` / `content_block_delta` / `content_block_stop`
 *      sequences; optional `message_delta` with final usage + stop_reason;
 *      `message_stop`.  Aggregation rules per block type:
 *        - `text`        — concatenate `delta.text`
 *        - `thinking`    — concatenate `delta.thinking` and keep
 *                          `delta.signature` if it ever arrives
 *        - `tool_use`    — concatenate `delta.partial_json` into `input`
 *                          and JSON-parse at block_stop (graceful fallback
 *                          to a raw string when JSON is malformed)
 *
 *   2. **OpenAI chat completion**: `data: { choices: [{ delta: ... }] }`
 *      stream.  We rebuild `choices[0].message.content` by concatenating
 *      `delta.content`, surface `finish_reason` from the last chunk, and
 *      pick up `usage` from the terminal chunk when present.
 *
 * Any failure (truncated stream, unknown event types) returns `null` so the
 * caller falls back to the raw-blob view.  We never throw — best-effort is
 * fine because a Raw JSON toggle stays available.
 */

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface AggregatedAnthropicMessage {
  type: "message"
  /** Anthropic message id when message_start carried one. */
  id?: string
  model?: string
  role: "assistant"
  content: Array<AnthropicBlock>
  stop_reason?: string
  stop_sequence?: string | null
  usage?: Record<string, unknown>
}

export interface AggregatedOpenAiChat {
  object: "chat.completion"
  id?: string
  model?: string
  choices: Array<{
    index: number
    message: { role: "assistant"; content: string }
    finish_reason: string | null
  }>
  usage?: Record<string, unknown>
}

export type AggregatedResponse =
  | AggregatedAnthropicMessage
  | AggregatedOpenAiChat

/**
 * Attempt to aggregate an SSE blob into a synthetic non-streaming response.
 * Returns `null` when the blob is empty / non-SSE / unrecognised — callers
 * should fall back to the raw-blob view in that case.
 */
export function aggregateSse(raw: string): AggregatedResponse | null {
  if (!raw || !raw.includes("data:")) return null
  const events = parseEventStream(raw)
  if (events.length === 0) return null

  // Anthropic streams always start with a "message_start" event.
  if (events.some((e) => e.event === "message_start")) {
    return aggregateAnthropicEvents(events)
  }
  // OpenAI chat completion streams have no `event:` field — just `data:`
  // chunks containing `{ choices: [{ delta: ... }] }`.
  if (events.some((e) => isOpenAiChatChunk(e.data))) {
    return aggregateOpenAiChatEvents(events)
  }
  return null
}

// ---------------------------------------------------------------------------
// Low-level event-stream parser
// ---------------------------------------------------------------------------

interface SseEvent {
  event?: string
  /** Already-JSON-decoded payload, or the raw string when not JSON. */
  data: unknown
  /** True iff the data line was the `[DONE]` sentinel. */
  done: boolean
}

function parseEventStream(raw: string): Array<SseEvent> {
  // SSE message boundary is a blank line.  We trim each block and keep only
  // ones that contain at least one data line.  We DON'T fail on malformed
  // chunks — they're silently skipped.
  const blocks = raw.split(/\n{2,}/)
  const out: Array<SseEvent> = []
  for (const block of blocks) {
    if (!block.trim()) continue
    let eventName: string | undefined
    const dataLines: Array<string> = []
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim()
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim())
      }
    }
    if (dataLines.length === 0) continue
    const joined = dataLines.join("\n")
    if (joined === "[DONE]") {
      out.push({ event: eventName, data: null, done: true })
      continue
    }
    let parsed: unknown = joined
    try {
      parsed = JSON.parse(joined)
    } catch {
      // keep raw string
    }
    out.push({ event: eventName, data: parsed, done: false })
  }
  return out
}

// ---------------------------------------------------------------------------
// Anthropic aggregator
// ---------------------------------------------------------------------------

export interface AnthropicBlock {
  type: string
  text?: string
  thinking?: string
  signature?: string
  id?: string
  name?: string
  input?: unknown
  /** Raw JSON-string accumulator used while streaming tool_use blocks. */
  _input_json?: string
}

function aggregateAnthropicEvents(
  events: Array<SseEvent>,
): AggregatedAnthropicMessage {
  const msg: AggregatedAnthropicMessage = {
    type: "message",
    role: "assistant",
    content: [],
  }
  const blocks: Array<AnthropicBlock> = []
  const state = { msg, blocks }

  for (const ev of events) {
    if (ev.done) continue
    const data = ev.data as Record<string, unknown> | null
    if (!data || typeof data !== "object") continue
    dispatchAnthropicEvent(ev.event, data, state)
  }

  msg.content = blocks.filter(Boolean)
  return msg
}

interface AnthropicAggState {
  msg: AggregatedAnthropicMessage
  blocks: Array<AnthropicBlock>
}

// Dispatch table for the Anthropic SSE event grammar. Kept as separate
// per-event helpers so each one stays under the complexity lint limit and
// is independently testable.
function dispatchAnthropicEvent(
  eventName: string | undefined,
  data: Record<string, unknown>,
  state: AnthropicAggState,
): void {
  switch (eventName) {
    case "message_start": {
      applyMessageStart(data, state.msg)
      break
    }
    case "content_block_start": {
      applyContentBlockStart(data, state.blocks)
      break
    }
    case "content_block_delta": {
      applyContentBlockDelta(data, state.blocks)
      break
    }
    case "content_block_stop": {
      finaliseToolUseBlock(data, state.blocks)
      break
    }
    case "message_delta": {
      applyMessageDelta(data, state.msg)
      break
    }
    default: {
      // message_stop / unknown — nothing to do.
      break
    }
  }
}

function applyMessageStart(
  data: Record<string, unknown>,
  msg: AggregatedAnthropicMessage,
): void {
  const m = data["message"] as Record<string, unknown> | undefined
  if (!m) return
  msg.id = strOrUndef(m["id"])
  msg.model = strOrUndef(m["model"])
  if (m["usage"] && typeof m["usage"] === "object") {
    msg.usage = m["usage"] as Record<string, unknown>
  }
}

function applyContentBlockStart(
  data: Record<string, unknown>,
  blocks: Array<AnthropicBlock>,
): void {
  const idx = numOrZero(data["index"])
  const cb = data["content_block"] as
    | (AnthropicBlock & Record<string, unknown>)
    | undefined
  if (!cb) return
  blocks[idx] = {
    ...cb,
    ...(cb.type === "text" && { text: cb.text ?? "" }),
    ...(cb.type === "thinking" && { thinking: cb.thinking ?? "" }),
    ...(cb.type === "tool_use" && { _input_json: "" }),
  }
}

function applyContentBlockDelta(
  data: Record<string, unknown>,
  blocks: Array<AnthropicBlock>,
): void {
  const block = blocks[numOrZero(data["index"])] as AnthropicBlock | undefined
  if (!block) return
  const delta = data["delta"] as Record<string, unknown> | undefined
  if (!delta) return
  applyDeltaToBlock(block, delta)
}

function finaliseToolUseBlock(
  data: Record<string, unknown>,
  blocks: Array<AnthropicBlock>,
): void {
  const block = blocks[numOrZero(data["index"])] as AnthropicBlock | undefined
  if (!block) return
  if (block.type !== "tool_use" || block._input_json === undefined) return
  const json = block._input_json
  try {
    block.input = json.trim() ? JSON.parse(json) : {}
  } catch {
    block.input = json
  }
  delete block._input_json
}

function applyMessageDelta(
  data: Record<string, unknown>,
  msg: AggregatedAnthropicMessage,
): void {
  const delta = data["delta"] as Record<string, unknown> | undefined
  if (delta) {
    const sr = strOrUndef(delta["stop_reason"])
    if (sr) msg.stop_reason = sr
    if ("stop_sequence" in delta) {
      msg.stop_sequence = delta["stop_sequence"] as string | null
    }
  }
  // Final usage often arrives here with totals (vs partial in message_start).
  if (data["usage"] && typeof data["usage"] === "object") {
    msg.usage = {
      ...msg.usage,
      ...(data["usage"] as Record<string, unknown>),
    }
  }
}

function applyDeltaToBlock(
  block: AnthropicBlock,
  delta: Record<string, unknown>,
): void {
  const dtype = strOrUndef(delta["type"]) ?? ""
  if (dtype === "text_delta" && typeof delta["text"] === "string") {
    block.text = (block.text ?? "") + delta["text"]
    return
  }
  if (dtype === "thinking_delta" && typeof delta["thinking"] === "string") {
    block.thinking = (block.thinking ?? "") + delta["thinking"]
    return
  }
  if (dtype === "signature_delta" && typeof delta["signature"] === "string") {
    block.signature = (block.signature ?? "") + delta["signature"]
    return
  }
  if (
    dtype === "input_json_delta"
    && typeof delta["partial_json"] === "string"
  ) {
    block._input_json = (block._input_json ?? "") + delta["partial_json"]
    return
  }
  // Unknown delta types: silently ignore so future Anthropic shapes don't
  // crash the viewer.
}

// ---------------------------------------------------------------------------
// OpenAI chat-completion aggregator
// ---------------------------------------------------------------------------

function isOpenAiChatChunk(data: unknown): boolean {
  return (
    typeof data === "object"
    && data !== null
    && Array.isArray((data as { choices?: unknown }).choices)
    && typeof (data as { object?: unknown }).object === "string"
  )
}

function aggregateOpenAiChatEvents(
  events: Array<SseEvent>,
): AggregatedOpenAiChat {
  let id: string | undefined
  let model: string | undefined
  let content = ""
  let finish_reason: string | null = null
  let usage: Record<string, unknown> | undefined

  for (const ev of events) {
    if (ev.done) continue
    const data = ev.data
    if (!data || typeof data !== "object") continue
    const d = data as Record<string, unknown>
    id = id ?? strOrUndef(d["id"])
    model = model ?? strOrUndef(d["model"])
    if (d["usage"] && typeof d["usage"] === "object") {
      usage = d["usage"] as Record<string, unknown>
    }
    const choices = d["choices"]
    if (!Array.isArray(choices) || choices.length === 0) continue
    const c0 = choices[0] as {
      delta?: { content?: unknown }
      finish_reason?: string | null
    }
    if (typeof c0.delta?.content === "string") {
      content += c0.delta.content
    }
    if (c0.finish_reason !== undefined && c0.finish_reason !== null) {
      finish_reason = c0.finish_reason
    }
  }

  return {
    object: "chat.completion",
    id,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason,
      },
    ],
    usage,
  }
}

// ---------------------------------------------------------------------------
// Tiny narrowing helpers
// ---------------------------------------------------------------------------

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}
function numOrZero(v: unknown): number {
  return typeof v === "number" ? v : 0
}
