import { Badge, Button, Card, TextInput, Text } from "@tremor/react"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"

import { api } from "~/api/client"
import type {
  FullTraceResponse,
  LogEntry,
  LogsListResponse,
  TraceFilesResponse,
  TraceLeg,
} from "~/api/types"

const NUM_FMT = new Intl.NumberFormat("en", { notation: "compact" })

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—"
  return NUM_FMT.format(n)
}

function fmtRelative(ts: number): string {
  const age = Date.now() - ts
  if (age < 60_000) return `${Math.floor(age / 1000)}s ago`
  if (age < 3600_000) return `${Math.floor(age / 60_000)}m ago`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`
  return `${Math.floor(age / 86_400_000)}d ago`
}

function fmtAbsolute(ts: number): string {
  return new Date(ts).toLocaleString()
}

const STATUS_COLOR = (status: number) => {
  if (status >= 500) return "rose" as const
  if (status >= 400) return "amber" as const
  if (status >= 200 && status < 300) return "emerald" as const
  return "slate" as const
}

type StatusFilter = "all" | "ok" | "error"

interface SsePayload {
  ts?: number
  request?: unknown
  response?: unknown
  metadata?: unknown
  [key: string]: unknown
}

export function Logs() {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [modelFilter, setModelFilter] = useState("")
  const [liveTail, setLiveTail] = useState(false)
  const [livePayloads, setLivePayloads] = useState<Array<SsePayload>>([])
  const [selected, setSelected] = useState<LogEntry | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const sseRef = useRef<EventSource | null>(null)

  const params = useMemo(() => {
    const sp = new URLSearchParams()
    if (search) sp.set("q", search)
    if (statusFilter !== "all") sp.set("status", statusFilter)
    if (modelFilter) sp.set("model", modelFilter)
    sp.set("limit", "100")
    return sp.toString()
  }, [search, statusFilter, modelFilter])

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["logs", params],
    queryFn: () => api<LogsListResponse>(`/logs?${params}`),
    refetchInterval: liveTail ? false : 15_000,
  })

  // Deep-link support: ?event=NNN opens the drawer for that event id. Lets
  // Overview / Keys / Models pages link directly into a specific trace.
  useEffect(() => {
    const idStr = searchParams.get("event")
    if (!idStr) return
    const id = Number.parseInt(idStr, 10)
    if (!Number.isFinite(id) || id <= 0) return
    // If the event is already in the loaded page, open it immediately.
    const hit = data?.items.find((it) => it.id === id)
    if (hit) {
      setSelected(hit)
      // Drop the param so closing the drawer doesn't reopen it on rerender.
      searchParams.delete("event")
      setSearchParams(searchParams, { replace: true })
      return
    }
    // Fall back to an API fetch so deep-link works even if the event isn't
    // in the current filtered list.
    api<LogsListResponse>(`/logs?limit=1&offset=0&q=`)
      .then(() => {
        // Use the dedicated single-event endpoint if it exists; otherwise
        // synthesize a stub from the deep-link so the drawer can still load
        // the trace via /logs/:id/trace.
        const stub: LogEntry = {
          id,
          ts: Date.now(),
          key_id: "",
          key_label: null,
          model: "",
          upstream_model: "",
          prompt_tokens: null,
          completion_tokens: null,
          status: 0,
          latency_ms: 0,
          error: null,
          usage_unknown: 0,
        }
        setSelected(stub)
        searchParams.delete("event")
        setSearchParams(searchParams, { replace: true })
      })
      .catch(() => {})
  }, [data?.items, searchParams, setSearchParams])

  const { data: traceFiles } = useQuery({
    queryKey: ["logs", "traces"],
    queryFn: () => api<TraceFilesResponse>("/logs/traces"),
    staleTime: 60_000,
  })

  // SSE live tail wiring
  useEffect(() => {
    if (!liveTail) {
      sseRef.current?.close()
      sseRef.current = null
      return
    }
    const es = new EventSource("/admin/traces/stream", {
      withCredentials: true,
    })
    sseRef.current = es
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data) as SsePayload
        setLivePayloads((prev) => [payload, ...prev].slice(0, 50))
      } catch {
        // ignore malformed
      }
    }
    es.onerror = () => {
      // EventSource auto-reconnects; surface only if it stays broken
    }
    return () => {
      es.close()
      sseRef.current = null
    }
  }, [liveTail])

  if (isLoading || !data) {
    return <div className="text-tremor-content">Loading logs…</div>
  }
  if (error) {
    return (
      <div className="rounded-tremor-small border border-rose-300 bg-rose-50 p-4 text-rose-700">
        Failed to load logs: {(error as Error).message}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <Card className="!p-3">
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            placeholder="Search key, model, error…"
            value={search}
            onValueChange={setSearch}
            className="max-w-xs"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="rounded-tremor-small border border-tremor-border bg-tremor-background px-3 py-2 text-sm"
          >
            <option value="all">All status</option>
            <option value="ok">OK (2xx/3xx)</option>
            <option value="error">Errors (4xx/5xx)</option>
          </select>
          <select
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            className="rounded-tremor-small border border-tremor-border bg-tremor-background px-3 py-2 text-sm"
          >
            <option value="">All models</option>
            {data.all_models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <label className="ml-auto flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={liveTail}
              onChange={(e) => setLiveTail(e.target.checked)}
            />
            <span>
              Live tail
              {liveTail && livePayloads.length > 0 && (
                <span className="ml-1 text-xs text-tremor-content-subtle">
                  ({livePayloads.length})
                </span>
              )}
            </span>
          </label>
          <Button variant="secondary" onClick={() => refetch()}>
            Refresh
          </Button>
        </div>
      </Card>

      {/* Live tail panel */}
      {liveTail && (
        <Card>
          <h3 className="text-sm font-semibold text-tremor-content-strong">
            Live trace stream
          </h3>
          <Text>
            Captures only fire for keys with debug mode on. The 50 most recent
            redacted payloads stay in memory; refresh keeps the historical
            table fresh.
          </Text>
          <div className="mt-3 max-h-64 overflow-y-auto rounded-tremor-small border border-tremor-border bg-tremor-background-muted p-2">
            {livePayloads.length === 0 ?
              <div className="py-4 text-center text-xs text-tremor-content-subtle">
                Waiting for events…
              </div>
            : <ul className="space-y-1 text-xs">
                {livePayloads.map((p, i) => (
                  <li
                    key={i}
                    className="rounded bg-tremor-background p-2 mono"
                  >
                    {JSON.stringify(p).slice(0, 240)}
                    {JSON.stringify(p).length > 240 && "…"}
                  </li>
                ))}
              </ul>
            }
          </div>
        </Card>
      )}

      {/* Logs table */}
      <Card className="!p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-tremor-border bg-tremor-background-muted text-left text-xs uppercase text-tremor-content-subtle">
                <th className="px-4 py-2">Time</th>
                <th className="px-4 py-2">Key</th>
                <th className="px-4 py-2">Model</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Latency</th>
                <th className="px-4 py-2">Tokens (p/c)</th>
                <th className="px-4 py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 ?
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-tremor-content-subtle"
                  >
                    No events match the current filters.
                  </td>
                </tr>
              : data.items.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setSelected(row)}
                    className="cursor-pointer border-b border-tremor-border last:border-b-0 hover:bg-tremor-background-muted/60"
                  >
                    <td className="px-4 py-2 text-xs text-tremor-content">
                      <span title={fmtAbsolute(row.ts)}>
                        {fmtRelative(row.ts)}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-tremor-content-strong">
                      <span className="mono text-xs">
                        {row.key_label || row.key_id.slice(-8)}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-tremor-content">
                      {row.model}
                    </td>
                    <td className="px-4 py-2">
                      <Badge color={STATUS_COLOR(row.status)}>
                        {row.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-xs text-tremor-content">
                      {row.latency_ms} ms
                    </td>
                    <td className="px-4 py-2 text-xs text-tremor-content">
                      {fmt(row.prompt_tokens)}/{fmt(row.completion_tokens)}
                    </td>
                    <td className="px-4 py-2 text-xs text-rose-700">
                      {row.error
                        ? row.error.slice(0, 60)
                          + (row.error.length > 60 ? "…" : "")
                        : "—"}
                    </td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
        <div className="border-t border-tremor-border px-4 py-2 text-xs text-tremor-content-subtle">
          Showing {data.items.length} of {data.total} matching events
        </div>
      </Card>

      {/* Captured trace files */}
      {traceFiles && traceFiles.items.length > 0 && (
        <Card>
          <h3 className="text-sm font-semibold text-tremor-content-strong">
            Captured trace files
          </h3>
          <Text>
            Persisted on disk for debug-enabled keys (kept according to
            retention.traces_days). Download to inspect full request/response
            bodies.
          </Text>
          <ul className="mt-3 space-y-1 text-sm">
            {traceFiles.items.map((f) => (
              <li
                key={f.name}
                className="flex items-center justify-between rounded border border-tremor-border px-3 py-2"
              >
                <span className="mono text-xs">{f.name}</span>
                <span className="text-xs text-tremor-content-subtle">
                  {fmt(f.size)} bytes ·{" "}
                  {new Date(f.mtime).toLocaleDateString()}
                </span>
                <a
                  href={`/admin/traces/${f.name.replace(/^traces-/, "").replace(/\.jsonl$/, "")}.jsonl`}
                  className="text-xs font-medium text-tremor-brand-emphasis hover:underline"
                  download
                >
                  Download
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {selected && (
        <DetailDrawer entry={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}

interface DetailDrawerProps {
  entry: LogEntry
  onClose: () => void
}

type TabKey = "summary" | "request" | "response" | "metadata"

function DetailDrawer({ entry, onClose }: DetailDrawerProps) {
  const [tab, setTab] = useState<TabKey>("summary")
  const [copied, setCopied] = useState<string | null>(null)

  const { data: traceData, isLoading: traceLoading, error: traceError } =
    useQuery({
      queryKey: ["logs", entry.id, "trace"],
      queryFn: () => api<FullTraceResponse>(`/logs/${entry.id}/trace`),
      retry: false,
    })

  const trace = traceData?.trace
  const noCapture =
    traceError !== null
    && traceError !== undefined
    && (traceError as { status?: number }).status === 404

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(tag)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      // ignore
    }
  }

  function buildCurl(): string | null {
    if (!trace?.req) return null
    const req = trace.req
    const method = req.method ?? "POST"
    const url = req.url ?? `(unknown — ${trace.route ?? "/"})`
    const headers = req.headers ?? {}
    const lines: Array<string> = [`curl -X ${method} '${url}' \\`]
    // skip CSRF / cookie / authorization on output — show placeholder
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase()
      if (lk === "authorization") {
        lines.push(`  -H 'Authorization: Bearer $COPILOT_API_KEY' \\`)
        continue
      }
      if (lk === "cookie" || lk === "x-csrf-token") continue
      lines.push(`  -H '${k}: ${String(v).replaceAll("'", `'\\''`)}' \\`)
    }
    if (req.body !== undefined && req.body !== null) {
      const bodyStr =
        typeof req.body === "string" ? req.body : JSON.stringify(req.body)
      lines.push(`  -d '${bodyStr.replaceAll("'", `'\\''`)}'`)
    } else {
      // trim trailing backslash
      const last = lines[lines.length - 1]
      lines[lines.length - 1] = last.replace(/ \\$/, "")
    }
    return lines.join("\n")
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30"
      onClick={onClose}
    >
      <div
        className="h-full w-full max-w-3xl overflow-y-auto bg-tremor-background p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-tremor-content-strong">
            Event #{entry.id}
          </h2>
          <button
            onClick={onClose}
            className="text-tremor-content-subtle hover:text-tremor-content-strong"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Tab strip */}
        <div className="mt-4 flex gap-1 border-b border-tremor-border">
          {(
            [
              ["summary", "Summary"],
              ["request", "Request"],
              ["response", "Response"],
              ["metadata", "Metadata"],
            ] as Array<[TabKey, string]>
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={
                "border-b-2 px-3 py-2 text-sm font-medium "
                + (tab === k
                  ? "border-tremor-brand text-tremor-brand-emphasis"
                  : "border-transparent text-tremor-content hover:text-tremor-content-strong")
              }
            >
              {label}
              {k !== "summary"
                && noCapture
                && <span className="ml-1 text-xs text-tremor-content-subtle">·</span>}
            </button>
          ))}
        </div>

        {tab === "summary" && (
          <div className="mt-4 space-y-4">
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-tremor-content-subtle">Time</dt>
              <dd className="text-tremor-content-strong">
                {fmtAbsolute(entry.ts)}{" "}
                <span className="text-tremor-content-subtle">
                  ({fmtRelative(entry.ts)})
                </span>
              </dd>
              <dt className="text-tremor-content-subtle">Key</dt>
              <dd>
                <Link
                  to={`/keys/${entry.key_id}`}
                  className="text-tremor-brand-emphasis hover:underline"
                >
                  {entry.key_label || entry.key_id}
                </Link>
              </dd>
              <dt className="text-tremor-content-subtle">Model (request)</dt>
              <dd className="text-tremor-content-strong">{entry.model}</dd>
              <dt className="text-tremor-content-subtle">Upstream model</dt>
              <dd className="text-tremor-content-strong mono text-xs">
                {entry.upstream_model}
              </dd>
              <dt className="text-tremor-content-subtle">Status</dt>
              <dd>
                <Badge color={STATUS_COLOR(entry.status)}>
                  {entry.status}
                </Badge>
              </dd>
              <dt className="text-tremor-content-subtle">Latency</dt>
              <dd className="text-tremor-content-strong">
                {entry.latency_ms} ms
              </dd>
              <dt className="text-tremor-content-subtle">Tokens p/c</dt>
              <dd className="text-tremor-content-strong">
                {fmt(entry.prompt_tokens)}/{fmt(entry.completion_tokens)}
              </dd>
              {entry.error && (
                <>
                  <dt className="text-tremor-content-subtle">Error</dt>
                  <dd className="text-rose-700 whitespace-pre-wrap break-words">
                    {entry.error}
                  </dd>
                </>
              )}
              {trace?.route && (
                <>
                  <dt className="text-tremor-content-subtle">Route</dt>
                  <dd className="mono text-xs text-tremor-content-strong">
                    {trace.route}
                  </dd>
                </>
              )}
              {trace?.trace_id && (
                <>
                  <dt className="text-tremor-content-subtle">Trace id</dt>
                  <dd className="mono text-xs text-tremor-content-strong">
                    {trace.trace_id}
                  </dd>
                </>
              )}
            </dl>

            {!noCapture && trace && (
              <Card>
                <h3 className="text-sm font-semibold text-tremor-content-strong">
                  Reproduce as cURL
                </h3>
                <Text>
                  Built from the captured upstream request (redacted headers).
                </Text>
                <Button
                  className="mt-3"
                  onClick={() => {
                    const curl = buildCurl()
                    if (curl) void copy(curl, "curl")
                  }}
                  disabled={!trace.req}
                >
                  {copied === "curl" ? "Copied!" : "Copy cURL"}
                </Button>
              </Card>
            )}
            {noCapture && (
              <Card decoration="top" decorationColor="amber">
                <Text>
                  No captured request/response for this event. Enable debug
                  mode on the key (Keys → {entry.key_label || entry.key_id.slice(-8)} → Enable debug)
                  to capture future calls into a JSONL trace file.
                </Text>
              </Card>
            )}
          </div>
        )}

        {(tab === "request" || tab === "response" || tab === "metadata") && (
          <div className="mt-4">
            {traceLoading && (
              <Text className="text-tremor-content-subtle">
                Loading trace…
              </Text>
            )}
            {noCapture && (
              <Card decoration="top" decorationColor="amber">
                <Text>
                  No captured trace for this event — the key was not in debug
                  mode when the request fired, or the trace file was swept.
                  Enable debug on this key and re-run the request to see full
                  bodies here.
                </Text>
              </Card>
            )}
            {tab === "request" && trace && (
              <TraceLegPanel
                title="Inbound request (from client to copilot-api)"
                leg={trace.req}
                onCopy={(s) => void copy(s, "req")}
                copied={copied === "req"}
              />
            )}
            {tab === "request" && trace?.upstream_req && (
              <div className="mt-4">
                <TraceLegPanel
                  title="Outbound request (copilot-api → Copilot upstream)"
                  leg={trace.upstream_req}
                  onCopy={(s) => void copy(s, "ureq")}
                  copied={copied === "ureq"}
                />
              </div>
            )}
            {tab === "response" && trace?.upstream_res && (
              <TraceLegPanel
                title="Upstream response (Copilot → copilot-api)"
                leg={trace.upstream_res}
                onCopy={(s) => void copy(s, "ures")}
                copied={copied === "ures"}
              />
            )}
            {tab === "response" && trace?.res && (
              <div className="mt-4">
                <TraceLegPanel
                  title="Final response (copilot-api → client)"
                  leg={trace.res}
                  onCopy={(s) => void copy(s, "res")}
                  copied={copied === "res"}
                />
              </div>
            )}
            {tab === "metadata" && trace && (
              <pre className="rounded bg-tremor-background-muted p-3 mono text-xs whitespace-pre-wrap break-words">
                {JSON.stringify(
                  {
                    trace_id: trace.trace_id,
                    ts: trace.ts,
                    key_id: trace.key_id,
                    route: trace.route,
                    latency_ms: trace.latency_ms,
                    file: traceData?.file,
                  },
                  null,
                  2,
                )}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface TraceLegPanelProps {
  title: string
  leg: TraceLeg | undefined
  onCopy: (s: string) => void
  copied: boolean
}

function TraceLegPanel({ title, leg, onCopy, copied }: TraceLegPanelProps) {
  if (!leg) {
    return (
      <Text className="text-tremor-content-subtle">
        No data captured for this leg.
      </Text>
    )
  }
  const bodyStr =
    leg.body === null || leg.body === undefined
      ? ""
      : typeof leg.body === "string"
        ? leg.body
        : JSON.stringify(leg.body, null, 2)
  const headers = leg.headers ?? {}

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-tremor-content-strong">
          {title}
        </h3>
        <Button
          variant="secondary"
          onClick={() =>
            onCopy(
              JSON.stringify(
                { method: leg.method, url: leg.url, status: leg.status, headers, body: leg.body },
                null,
                2,
              ),
            )
          }
        >
          {copied ? "Copied!" : "Copy JSON"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {leg.method && <Badge color="blue">{leg.method}</Badge>}
        {leg.status !== undefined && (
          <Badge color={STATUS_COLOR(leg.status)}>{leg.status}</Badge>
        )}
        {leg.url && (
          <span className="mono text-tremor-content break-all">{leg.url}</span>
        )}
      </div>
      <details className="rounded border border-tremor-border bg-tremor-background-muted p-2">
        <summary className="cursor-pointer text-xs font-medium text-tremor-content-strong">
          Headers ({Object.keys(headers).length})
        </summary>
        <pre className="mt-2 mono text-xs whitespace-pre-wrap break-words">
          {Object.entries(headers)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join("\n")}
        </pre>
      </details>
      <div>
        <div className="mb-1 text-xs font-medium text-tremor-content-strong">
          Body
        </div>
        {bodyStr.length === 0 ?
          <div className="text-xs text-tremor-content-subtle">(empty)</div>
        : <pre className="rounded bg-tremor-background-muted p-3 mono text-xs whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
            {bodyStr}
          </pre>
        }
      </div>
    </div>
  )
}
