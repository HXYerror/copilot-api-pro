/**
 * Native Anthropic pass-through service.
 *
 * The GitHub Copilot upstream (`api.enterprise.githubcopilot.com`) natively
 * speaks the Anthropic Messages API for all Claude 4.5+ models.  Routing
 * requests directly to `/v1/messages` instead of translating them through
 * `/chat/completions` gives us:
 *
 *  - Real thinking blocks with `signature` field (multi-turn reasoning)
 *  - `cache_creation_input_tokens` in usage
 *  - `top_k` support
 *  - No lossy translation round-trip
 *
 * See research notes: ~/copilot-models-litellm/copilot_models.py
 */

import consola from "consola"
import { events } from "fetch-event-stream"
import fs from "node:fs"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"

import type { UpstreamCaptureFn } from "./create-chat-completions"

/**
 * Forward an Anthropic-format request directly to Copilot's native `/v1/messages`
 * endpoint, preserving all fields (thinking, signature, top_k, cache_control, …).
 *
 * Returns:
 *  - For non-streaming: the raw Anthropic JSON response object
 *  - For streaming: an async iterable of SSE events (fetch-event-stream)
 */
export const createMessagesNative = async (
  payload: AnthropicMessagesPayload,
  onUpstream?: UpstreamCaptureFn,
  clientAnthropicBeta?: string,
  defaultEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "",
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  // When we're about to inject default_effort AND the client didn't send
  // their own thinking, we MUST also request the `effort-2025-11-24`
  // anthropic-beta flag from upstream — that beta is what gates
  // `output_config.effort`. Without it, Copilot silently drops the
  // field and our injection becomes a no-op (verified empirically:
  // thinking_tokens=0 across all effort levels when the beta is absent,
  // but rises monotonically once it's included).
  const willInjectEffort =
    !payload.thinking && !!defaultEffort && defaultEffort !== ""

  const hasVision = messageHasImages(payload)
  const headers = buildNativeHeaders(
    hasVision,
    Boolean(payload.stream),
    clientAnthropicBeta,
    willInjectEffort,
  )
  // X-Initiator parity with /chat/completions and /responses: tells upstream
  // whether this turn is operator-initiated ("user") or part of an
  // automated/agent loop. Detected from the message history.
  headers["X-Initiator"] = isAgentMessagesCall(payload) ? "agent" : "user"

  const upstream = `${copilotBaseUrl(state)}/v1/messages`
  consola.debug("Native Anthropic upstream:", upstream)

  // Strip fields that are Copilot-API–specific or unsupported by upstream
  const body = buildUpstreamPayload(payload, defaultEffort)

  // `sentHeaders` is the header map that ACTUALLY went out on the wire for
  // the response we'll forward. It diverges from the initially-built
  // `headers` only when the auto-learn retry path below rewrites
  // `anthropic-beta`. The trace upstream-leg capture downstream must use
  // this — recording the pre-retry header set on a retried request would
  // make traces lie about what we sent.
  let sentHeaders: Record<string, string> = headers
  let response = await fetch(upstream, {
    method: "POST",
    headers: sentHeaders,
    body: JSON.stringify(body),
  })

  // ──────────────────────────────────────────────────────────────────────
  // Auto-learn unsupported beta flags.
  //
  // Copilot's Anthropic endpoint returns 400 with body
  // `{"error":{"message":"unsupported beta header(s): X, Y, ..."}}`
  // when we forward a flag it hasn't implemented. We don't want to
  // maintain that deny-list by hand for every new flag Claude Code
  // adopts — so on this specific 400 shape we:
  //   1. parse the flag names out of the error body
  //   2. add them to `learnedUnsupportedBeta` (process-lifetime)
  //   3. rebuild the header WITHOUT those flags
  //   4. retry the request ONCE
  //
  // Only retry once: if it still 400s, real upstream failure — surface it.
  // Stream responses are retried the same way (the failure happens before
  // any body is consumed since 400 short-circuits).
  // ──────────────────────────────────────────────────────────────────────
  if (response.status === 400) {
    // Use clone() so the original body stays readable for forwardError()
    // downstream when this turns out not to be an unsupported-beta shape.
    // The 400 body is small (~hundreds of bytes of JSON) so the tee cost
    // is negligible and there's no risk of back-pressuring a streaming
    // source — error responses never stream.
    const errBody = await response.clone().text()
    const newlyUnsupported = parseUnsupportedBetaFromError(errBody)
    if (newlyUnsupported.length > 0) {
      const denyList = ensureLearnedSet()
      // Determine which flags are TRULY new (not in deny-list yet) BEFORE
      // mutating the set. Concurrent requests that hit the same unknown
      // flag won't both persist it — the second one sees it already in
      // the Set after the first one added it.
      const newToProcess: Array<string> = []
      for (const f of newlyUnsupported) {
        if (!denyList.has(f)) {
          denyList.add(f)
          newToProcess.push(f)
        }
      }
      // Persist NEW flags (not seed, not already in file) so future
      // process restarts skip them from the start AND devs can see what
      // accumulated by reading the file.
      for (const f of newToProcess) {
        if (!SEEDED_UNSUPPORTED_BETA.includes(f)) {
          persistLearnedBetaFlag(f)
          unseededFlagsFromFile.push(f)
        }
      }
      consola.warn(
        `[anthropic-beta] upstream rejected ${JSON.stringify(newlyUnsupported)}`
          + ` — added to deny-list${newToProcess.length > 0 ? " (new, persisted)" : ""}, retrying`,
      )
      // Rebuild the anthropic-beta header against the now-updated deny-list.
      // If the rebuild yields an empty value, drop the header entirely:
      // forwarding `anthropic-beta: ""` would either be a no-op or get
      // rejected as a malformed value depending on upstream's parser.
      sentHeaders = { ...headers }
      const rebuiltBeta = mergeAnthropicBeta(
        clientAnthropicBeta,
        willInjectEffort,
      )
      if (rebuiltBeta === "") {
        delete sentHeaders["anthropic-beta"]
      } else {
        sentHeaders["anthropic-beta"] = rebuiltBeta
      }
      response = await fetch(upstream, {
        method: "POST",
        headers: sentHeaders,
        body: JSON.stringify(body),
      })
    }
  }

  // Trace upstream-leg capture (task #25). Error bodies are captured too —
  // they're small and tell us why upstream rejected the request.
  //
  // Streaming responses: we tee the body so we can both forward the live
  // SSE to the client AND accumulate the bytes for the trace. The trace
  // fires only after the upstream stream closes (or aborts), so the body
  // we record matches exactly what the client received.
  if (onUpstream && !payload.stream) {
    try {
      const responseBody = await response.clone().text()
      onUpstream({
        req: { method: "POST", url: upstream, headers: sentHeaders, body },
        res: {
          status: response.status,
          headers: response.headers,
          body: responseBody,
        },
      })
    } catch (err) {
      consola.warn(`[trace] upstream capture failed: ${String(err)}`)
    }
  } else if (onUpstream && payload.stream && response.body) {
    // Streaming path. Replace `response` with a synthetic Response whose
    // body is a tee'd ReadableStream — the SSE forwarder reads one half,
    // we accumulate the other into a buffer. The trace middleware awaits
    // `res_pending` (with a 30s safety timeout) before writing the JSONL
    // so the upstream_res.body field is populated.
    try {
      const [forForwarder, forCapture] = response.body.tee()
      // Snapshot upstream metadata BEFORE replacing `response`. The new
      // Response copies headers/status either way, but reading the
      // originals removes any doubt about which fields we're recording.
      const upstreamResHeaders = response.headers
      const upstreamResStatus = response.status
      response = new Response(forForwarder, {
        status: upstreamResStatus,
        statusText: response.statusText,
        headers: upstreamResHeaders,
      })
      const MAX_CAPTURE = 256 * 1024
      const resPending = (async () => {
        const reader = forCapture.getReader()
        const decoder = new TextDecoder()
        let buf = ""
        let bytes = 0
        let truncated = false
        let streamErr: unknown
        try {
          while (true) {
            const r = (await reader.read()) as {
              value?: Uint8Array
              done: boolean
            }
            if (r.done) break
            const v = r.value
            if (!v) break
            if (bytes < MAX_CAPTURE) {
              // Still capturing into the buffer.
              const room = MAX_CAPTURE - bytes
              if (v.byteLength <= room) {
                buf += decoder.decode(v, { stream: true })
                bytes += v.byteLength
              } else {
                buf += decoder.decode(v.slice(0, room), { stream: true })
                bytes = MAX_CAPTURE
                truncated = true
              }
            }
            // After hitting MAX_CAPTURE we KEEP READING but discard the
            // bytes. Stopping here would back-pressure the tee — the
            // forwarder half (going to the client) would stall waiting
            // for us to consume. Same bug class as the telemetry-clone
            // hang fixed earlier; don't reintroduce it.
          }
        } catch (err) {
          // Stash the failure so it surfaces on the trace leg rather
          // than being silently swallowed. The forwarder half sees the
          // same error and propagates to the client; we mirror it here
          // so operators reading the trace can see WHY the body is
          // truncated.
          streamErr = err
        }
        // Suffix the body so the trace makes the failure obvious.
        // Format-compatible with the existing [TRUNCATED] marker so
        // downstream tooling that splits on `[` keeps working.
        let resBody = buf
        if (truncated) resBody += "[TRUNCATED]"
        if (streamErr !== undefined) {
          const msg =
            streamErr instanceof Error ? streamErr.message : String(streamErr)
          resBody += `[STREAM_ERROR: ${msg}]`
        }
        return {
          status: upstreamResStatus,
          headers: upstreamResHeaders,
          body: resBody,
        } as const
      })()
      onUpstream({
        req: { method: "POST", url: upstream, headers: sentHeaders, body },
        res_pending: resPending,
      })
    } catch (err) {
      consola.warn(`[trace] upstream tee failed: ${String(err)}`)
    }
  }

  if (!response.ok) {
    consola.error("Native Anthropic upstream error", response.status)
    throw new HTTPError("Native Anthropic upstream error", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return response.json()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Auto-learning deny-list of beta flags upstream rejects.
 *
 * Layered state:
 *   1. **Seed** — hard-coded values committed to the repo. Things we've
 *      already observed in production. Avoids the cold-start retry penalty
 *      on every brand-new install.
 *   2. **File** — `~/.local/share/copilot-api-pro/learned-unsupported-beta.txt`
 *      Per-line ASCII flag names. Read once on first use, appended to when a
 *      new flag is learned. Persists across restarts. Operators can edit it
 *      manually to revert / extend the deny-list.
 *   3. **Process** — the live `Set<string>` mutated when auto-learn fires.
 *
 * When a NEW flag (not in seed + not in file) is learned, we ALSO log a
 * loud warning at startup of subsequent processes so operators / devs
 * notice and can promote it into the seed via a code commit.
 */
const SEEDED_UNSUPPORTED_BETA: ReadonlyArray<string> = [
  "context-1m-2025-08-07", // observed 2026-05-19
]

/** Lazily-initialised on first call. Stays empty until the file is read. */
let learnedUnsupportedBeta: Set<string> | undefined

/** Flags present in the file but NOT in the seed — surface at startup. */
const unseededFlagsFromFile: Array<string> = []

function ensureLearnedSet(): Set<string> {
  if (learnedUnsupportedBeta) return learnedUnsupportedBeta
  const s = new Set<string>(SEEDED_UNSUPPORTED_BETA)
  try {
    const raw = fs.readFileSync(PATHS.LEARNED_BETA_PATH, "utf8")
    for (const line of raw.split("\n")) {
      const flag = line.trim()
      if (!flag || flag.startsWith("#")) continue
      if (!/^[\w.-]+$/.test(flag)) continue
      if (!SEEDED_UNSUPPORTED_BETA.includes(flag)) {
        unseededFlagsFromFile.push(flag)
      }
      s.add(flag)
    }
  } catch {
    // File doesn't exist yet — that's fine, just use the seed.
  }
  learnedUnsupportedBeta = s
  return s
}

/**
 * Get the set of flags discovered at runtime that are NOT in the source
 * seed. Used by start.ts to surface them in the boot banner so the next
 * developer notices and bumps the seed.
 */
export function unseededLearnedBetaFlags(): Array<string> {
  ensureLearnedSet()
  return [...unseededFlagsFromFile]
}

/**
 * Append a newly-learned flag to the persistent file with a timestamped
 * comment line. Best-effort: a write failure logs but doesn't propagate
 * (the in-memory Set still works for this process).
 */
function persistLearnedBetaFlag(flag: string): void {
  try {
    const ts = new Date().toISOString()
    const line = `# learned ${ts}\n${flag}\n`
    fs.appendFileSync(PATHS.LEARNED_BETA_PATH, line, { mode: 0o600 })
  } catch (err) {
    consola.warn(
      `[anthropic-beta] failed to persist learned flag "${flag}": ${String(err)}`,
    )
  }
}

function mergeAnthropicBeta(
  clientBeta: string | undefined,
  requireEffortBeta = false,
): string {
  const ours = ["interleaved-thinking-2025-05-14", "prompt-caching-2024-07-31"]
  if (requireEffortBeta) {
    // `effort-2025-11-24` unlocks `output_config.effort` on Anthropic
    // upstream. Only add it when the request is going to carry effort —
    // adding it unconditionally would surface as an unsupported-flag
    // warning on models / endpoints that don't accept it, and would
    // eventually land the flag in the auto-learned deny-list.
    ours.push("effort-2025-11-24")
  }
  const fromClient = (clientBeta ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const merged = [...new Set([...fromClient, ...ours])]
  // Strip flags we've previously learned upstream rejects.
  const denyList = ensureLearnedSet()
  return merged.filter((flag) => !denyList.has(flag)).join(",")
}

/**
 * Parse upstream 400 body for `unsupported beta header(s): X, Y` and
 * return the flag names. Returns empty array when the body isn't a
 * recognised "unsupported beta" error.
 */
function parseUnsupportedBetaFromError(body: string): Array<string> {
  // Body may be raw upstream error OR doubly-encoded by our forward layer.
  // We just regex-extract from the raw string — either way the substring
  // we want is in there.
  const m = /unsupported beta header\(s\):\s*([^"\\}]+)/i.exec(body)
  if (!m || !m[1]) return []
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^[\w.-]+$/.test(s))
}

/**
 * Build headers for the Anthropic native endpoint.
 *
 * The upstream requires `anthropic-version` and does NOT want an `openai-intent`
 * header.  We reuse `copilotHeaders()` for auth/agent headers and then layer the
 * Anthropic-specific ones on top.
 */
function buildNativeHeaders(
  vision: boolean,
  stream: boolean,
  clientBeta?: string,
  requireEffortBeta = false,
): Record<string, string> {
  const base = copilotHeaders(state, vision)

  // Remove headers that are OpenAI-specific and not expected by Anthropic endpoint
  const { "openai-intent": _dropped, ...anthropicBase } = base

  // Build the beta-flag value. When the merged list is empty (the deny-list
  // could legitimately strip every flag we'd otherwise send — interleaved
  // -thinking + prompt-caching are seeded as defaults today, but a future
  // version of upstream could reject both), DROP the header entirely
  // rather than forwarding `anthropic-beta: ""` which is a malformed value
  // some HTTP parsers reject.
  const beta = mergeAnthropicBeta(clientBeta, requireEffortBeta)
  return {
    ...anthropicBase,
    "anthropic-version": "2023-06-01",
    // Forward client beta flags + our defaults. Crucial for Claude Code's
    // `effort-2025-11-24` flag which enables `output_config.effort`.
    ...(beta === "" ? {} : { "anthropic-beta": beta }),
    // Only request SSE streaming format when the caller is streaming
    ...(stream ? { accept: "text/event-stream" } : {}),
  }
}

/**
 * Map a legacy Anthropic `budget_tokens` value to a Copilot effort level
 * for adaptive thinking. The buckets mirror Claude Code's preset budgets
 * so a client that selects "Think hard" upstream lands on Copilot's "high"
 * (etc).
 *
 *   budget ≥ 50K → "xhigh"      (Ultrathink-equivalent)
 *   25K–50K      → "high"       (Think harder)
 *   5K–25K       → "medium"     (Think hard)
 *   < 5K         → "low"        (small explicit budget)
 *
 * When the caller didn't send a budget at all, default to "medium" — the
 * model's adaptive controller will still ramp up if the task warrants it.
 */
function budgetToEffort(
  budget: number | undefined,
): "low" | "medium" | "high" | "xhigh" {
  if (typeof budget !== "number" || budget <= 0) return "medium"
  if (budget >= 50_000) return "xhigh"
  if (budget >= 25_000) return "high"
  if (budget >= 5_000) return "medium"
  return "low"
}

/**
 * Some Copilot models restrict `reasoning_effort` to a single value
 * (e.g. claude-opus-4.7-high → ["high"], claude-opus-4.7 → ["medium"]).
 * Sending a value outside that allow-list 400s upstream.
 *
 * Strategy when the caller's effort isn't in the supported list: **take
 * the highest supported level** (xhigh > high > medium > low). Rationale:
 *
 *   - Single-value models like `claude-opus-4.7-high` carry their level
 *     in the name; the user contract is "this model thinks at that level".
 *     Falling back to the only allowed value matches the model's purpose.
 *   - When the list has multiple values, picking the highest matches the
 *     caller's likely intent ("they asked for thinking — give them more
 *     not less"). If they wanted "minimal thinking" they wouldn't have
 *     picked the high model variant.
 *
 * Returns the original effort if it's supported, the highest supported
 * level otherwise, or undefined when the model has no reasoning_effort
 * declared (effort field will be dropped by caller).
 */
const EFFORT_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
}

export function clampEffortForModel(
  effort: string | undefined,
  modelId: string,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const entry = state.models?.data.find((m) => m.id === modelId)
  const supported = (
    entry?.capabilities?.supports as
      | { reasoning_effort?: Array<string> }
      | undefined
  )?.reasoning_effort
  if (!Array.isArray(supported) || supported.length === 0) {
    // Model didn't advertise reasoning_effort — pass through whatever the
    // caller had. Caller will decide whether to include the field.
    return effort as "low" | "medium" | "high" | "xhigh" | "max" | undefined
  }
  if (effort && supported.includes(effort)) {
    return effort as "low" | "medium" | "high" | "xhigh" | "max"
  }
  // Pick the highest-ranked supported level.
  const best = supported
    .filter(
      (s): s is "low" | "medium" | "high" | "xhigh" | "max" => s in EFFORT_RANK,
    )
    .sort((a, b) => (EFFORT_RANK[b] ?? 0) - (EFFORT_RANK[a] ?? 0))[0]
  if (best && effort && best !== effort) {
    consola.debug(
      `[effort-clamp] model ${modelId} supports ${JSON.stringify(supported)}, `
        + `caller asked for "${effort}" → forwarded as "${best}"`,
    )
  }
  return best
}

/**
 * Produce the payload forwarded to upstream.
 *
 * We pass through almost everything verbatim.  The only transformation is that
 * `claude-opus-4.7+` requires the new adaptive thinking format
 * (`thinking: { type: "adaptive" }` + `output_config.effort`) rather than the
 * legacy `{ type: "enabled", budget_tokens: N }`.  If the caller already sent
 * the correct format we leave it alone; if they sent the old format and the
 * model requires adaptive, we upgrade automatically — and we **map the
 * budget size to a Copilot effort level** (low/medium/high/xhigh) so the
 * caller's intent isn't flattened to "medium" regardless of input.
 *
 * Additionally: we scrub empty content blocks before forwarding. Copilot
 * routes some Anthropic requests through Google Vertex AI (the response
 * `request_id` starts with `req_vrtx_`); Vertex enforces a stricter
 * "messages: text content blocks must be non-empty" rule that the
 * Anthropic-direct backend does not. Claude Code occasionally emits
 * `{type:"text", text:""}` blocks (e.g. after a tool_use turn with no
 * assistant prose); leaving them in makes upstream 400 unpredictably
 * depending on which backend gets the request. See sanitiseMessages.
 */
export function buildUpstreamPayload(
  payload: AnthropicMessagesPayload,
  defaultEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "",
): AnthropicMessagesPayload {
  const { thinking, output_config, messages, ...rest } = payload
  const sanitisedMessages = sanitiseMessages(messages)

  // Anthropic enforces `max_tokens > thinking.budget_tokens`. Some clients
  // (observed: Claude Code 2.x against claude-opus-4-6) pair a high budget
  // (e.g. 31999 / 63999) with the default max_tokens=4096 and upstream 400s
  // with the documented message. Bump max_tokens to budget+1024 in that
  // case so the request goes through. We never SHRINK max_tokens; only
  // grow it to satisfy the invariant.
  const adjustedMaxTokens = adjustMaxTokensForBudget(
    rest.max_tokens,
    thinking,
    payload.model,
  )
  const restWithMaxTokens =
    adjustedMaxTokens !== undefined && adjustedMaxTokens !== rest.max_tokens ?
      { ...rest, max_tokens: adjustedMaxTokens }
    : rest

  // Per-alias default effort: when the client didn't ask for thinking at
  // all AND the alias config provides a default, synthesise an adaptive
  // thinking request with that effort. Never overrides what the client
  // explicitly sent — purely a fill-in. Empty string ("" or undefined)
  // means no default for this alias.
  if (!thinking && defaultEffort && defaultEffort !== "") {
    const clamped =
      clampEffortForModel(defaultEffort, payload.model) ?? defaultEffort
    consola.debug(
      `[alias-effort] injecting default effort=${defaultEffort} (clamped=${clamped}) for model=${payload.model}`,
    )
    return {
      ...restWithMaxTokens,
      messages: sanitisedMessages,
      thinking: { type: "adaptive" },
      output_config: { effort: clamped },
    }
  }

  if (!thinking) {
    // output_config only valid alongside thinking — drop it.
    return { ...restWithMaxTokens, messages: sanitisedMessages }
  }

  if (isAdaptiveThinkingModel(payload.model)) {
    // Upgrade legacy enabled → adaptive if needed.  Map budget_tokens to a
    // Copilot effort level when the caller didn't already supply one. Then
    // clamp to whatever this specific model variant supports — e.g.
    // claude-opus-4.7-high only accepts effort:"high", so caller's "xhigh"
    // or "low" gets quietly rewritten instead of letting upstream 400.
    if (thinking.type === "enabled") {
      const rawEffort =
        output_config?.effort ?? budgetToEffort(thinking.budget_tokens)
      const effort = clampEffortForModel(rawEffort, payload.model) ?? rawEffort
      consola.debug(
        `Upgrading thinking format to adaptive for model ${payload.model} (budget=${thinking.budget_tokens} → effort=${effort})`,
      )
      return {
        ...restWithMaxTokens,
        messages: sanitisedMessages,
        thinking: { type: "adaptive" },
        output_config: { effort },
      }
    }
    // Already adaptive — clamp effort to model-supported level too.
    const callerEffort = output_config?.effort
    const clamped = clampEffortForModel(callerEffort, payload.model)
    return {
      ...restWithMaxTokens,
      messages: sanitisedMessages,
      thinking,
      output_config: clamped ? { effort: clamped } : output_config,
    }
  }

  // Non-adaptive model — forward legacy format, drop output_config
  return { ...restWithMaxTokens, messages: sanitisedMessages, thinking }
}

/**
 * Anthropic's invariant: `max_tokens > thinking.budget_tokens`. When the
 * caller violates this (Claude Code occasionally pairs a generous budget
 * with the default 4096 max_tokens), we silently grow `max_tokens` to
 * `budget + headroom` so the request goes through.
 *
 * Only applies when:
 *   - thinking is the legacy `{type:"enabled", budget_tokens: N}` shape
 *     (adaptive thinking has no budget_tokens to clash with)
 *   - the model is not in the adaptive-thinking family (those get the
 *     thinking field rewritten anyway, no budget_tokens reaches upstream)
 *
 * Returns `undefined` to mean "no change"; the caller compares and only
 * overwrites when this differs from the input.
 *
 * Headroom of 1024 matches Anthropic's example in the docs error message
 * and stays well under any model's max_output_tokens.
 */
function adjustMaxTokensForBudget(
  maxTokens: number | undefined,
  thinking: AnthropicMessagesPayload["thinking"],
  modelId: string,
): number | undefined {
  if (
    !thinking
    || thinking.type !== "enabled"
    || typeof thinking.budget_tokens !== "number"
  ) {
    return undefined
  }
  // Adaptive models discard budget_tokens entirely in the upgrade path
  // below, so they can't hit the upstream invariant.
  if (isAdaptiveThinkingModel(modelId)) return undefined
  if (typeof maxTokens !== "number") return undefined
  if (maxTokens > thinking.budget_tokens) return undefined

  const HEADROOM = 1024
  const bumped = thinking.budget_tokens + HEADROOM
  consola.warn(
    `[max-tokens-fix] max_tokens=${maxTokens} <= budget_tokens=${thinking.budget_tokens} for ${modelId}; bumping max_tokens to ${bumped} (budget + ${HEADROOM} headroom)`,
  )
  return bumped
}

/**
 * Strip content blocks that Copilot's Vertex-routed Anthropic backend
 * rejects with "messages: text content blocks must be non-empty".
 *
 * Observed in the wild from Claude Code: after a tool_use turn the
 * assistant sometimes emits an empty `{type:"text", text:""}` block; same
 * shape from translated requests when a `content` array had whitespace
 * stripped to nothing. Anthropic-direct accepts these silently, Vertex
 * 400s. Routing decision is made by Copilot per-request and not under our
 * control, so we always scrub.
 *
 * Rules:
 *   - text blocks where `text` is empty/whitespace → drop the block
 *   - tool_result with `content` array → recurse into nested text blocks
 *   - tool_result with empty string content → coerce to a single-space
 *     placeholder (tool_result MUST have content per Anthropic spec; we
 *     can't just drop the whole block without orphaning the tool_use_id)
 *   - if a message's content array becomes entirely empty → coerce to a
 *     single-space text block (Anthropic requires non-empty content per
 *     message; dropping the whole message would desync tool_use/result
 *     pairing)
 *   - message.content as a plain string with empty/whitespace value →
 *     coerce to a single space too
 *
 * Pure function; does NOT mutate the input payload.
 */
function sanitiseMessages(
  messages: AnthropicMessagesPayload["messages"],
): AnthropicMessagesPayload["messages"] {
  const PLACEHOLDER = " "
  let modified = false
  const out = messages.map((msg) => {
    if (typeof msg.content === "string") {
      if (msg.content.trim().length === 0) {
        modified = true
        return { ...msg, content: PLACEHOLDER }
      }
      return msg
    }
    if (!Array.isArray(msg.content)) return msg

    const cleaned = msg.content
      .map((block) => {
        if (block.type === "text") {
          if (typeof block.text !== "string" || block.text.length === 0) {
            return null
          }
          return block
        }
        if (block.type === "tool_result") {
          // tool_result content can be a string OR an array of blocks.
          if (typeof block.content === "string") {
            if (block.content.length === 0) {
              return { ...block, content: PLACEHOLDER }
            }
            return block
          }
          if (Array.isArray(block.content)) {
            const nestedCleaned = block.content.filter((nested) => {
              if (nested.type === "text") {
                return typeof nested.text === "string" && nested.text.length > 0
              }
              return true
            })
            if (nestedCleaned.length === 0) {
              return { ...block, content: PLACEHOLDER }
            }
            if (nestedCleaned.length !== block.content.length) {
              return { ...block, content: nestedCleaned }
            }
            return block
          }
          return block
        }
        return block
      })
      .filter((b): b is NonNullable<typeof b> => b !== null)

    if (cleaned.length !== msg.content.length) modified = true

    if (cleaned.length === 0) {
      // Anthropic requires non-empty content. Coerce rather than drop the
      // whole message, since dropping desyncs tool_use/tool_result pairing.
      modified = true
      return {
        ...msg,
        content: [{ type: "text" as const, text: PLACEHOLDER }],
      }
    }
    return { ...msg, content: cleaned }
  })

  if (modified) {
    consola.debug(
      "[sanitise] scrubbed empty content blocks (Vertex compatibility)",
    )
  }
  // Cast back to the original union: each branch above preserves either
  // the user or assistant shape exactly (we only touch content blocks).
  return out as AnthropicMessagesPayload["messages"]
}

/**
 * Returns true for models that require the adaptive thinking API
 * (`{ type: "adaptive" }` + `output_config.effort`) rather than the
 * legacy `{ type: "enabled", budget_tokens: N }`.
 * Currently: claude-opus-4.7 and later.
 */
function isAdaptiveThinkingModel(model: string): boolean {
  // claude-opus-4.7 and above use adaptive thinking
  const match = model.match(/^claude-opus-4[.-](\d+)/)
  if (match) {
    const minor = Number.parseInt(match[1], 10)
    // claude-opus-4.7 and later use the new adaptive thinking API (not legacy budget_tokens)
    return minor >= 7
  }
  return false
}

/**
 * Check whether the request contains any image blocks (to set vision headers).
 */
function messageHasImages(payload: AnthropicMessagesPayload): boolean {
  for (const msg of payload.messages) {
    if (typeof msg.content === "string") continue
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "image") return true
      }
    }
  }
  return false
}

/**
 * Heuristic for X-Initiator: returns true when the message history makes this
 * look like an automated agent loop rather than the first turn of a manual
 * conversation. Mirrors `isAgentCall` in create-responses.ts and the inline
 * detector in create-chat-completions.ts:
 *
 *  - any prior assistant message → multi-turn → "agent"
 *  - any tool_result block in user content → tool-driven → "agent"
 *  - any tool_use in assistant content → "agent"
 *  - otherwise → "user"
 */
function isAgentMessagesCall(payload: AnthropicMessagesPayload): boolean {
  for (const msg of payload.messages) {
    if (msg.role === "assistant") return true
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result" || block.type === "tool_use") {
          return true
        }
      }
    }
  }
  return false
}
