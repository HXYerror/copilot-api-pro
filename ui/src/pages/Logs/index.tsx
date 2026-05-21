import { useQuery } from "@tanstack/react-query"
import { Badge, Button, Card, TextInput, Text } from "@tremor/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"

import type {
  LogEntry,
  LogsListResponse,
  TraceFilesResponse,
} from "~/api/types"

import { api } from "~/api/client"

import { DetailDrawer } from "./DetailDrawer"
import {
  fmt,
  fmtAbsolute,
  fmtRelative,
  STATUS_COLOR,
  thinkingBadgeColor,
  thinkingLabel,
  type KindFilter,
  type StatusFilter,
} from "./helpers"

const PAGE_SIZE = 50

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
  const [kindFilter, setKindFilter] = useState<KindFilter>("messages")
  const [modelFilter, setModelFilter] = useState("")
  const [liveTail, setLiveTail] = useState(false)
  const [selected, setSelected] = useState<LogEntry | null>(null)
  const [page, setPage] = useState(0)

  useEffect(() => {
    setPage(0)
  }, [search, statusFilter, kindFilter, modelFilter])

  const params = useMemo(() => {
    const sp = new URLSearchParams()
    if (search) sp.set("q", search)
    if (statusFilter !== "all") sp.set("status", statusFilter)
    if (kindFilter !== "all") sp.set("kind", kindFilter)
    if (modelFilter) sp.set("model", modelFilter)
    sp.set("limit", String(PAGE_SIZE))
    sp.set("offset", String(page * PAGE_SIZE))
    return sp.toString()
  }, [search, statusFilter, kindFilter, modelFilter, page])

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["logs", params],
    queryFn: () => api<LogsListResponse>(`/logs?${params}`),
    refetchInterval: liveTail ? false : 15_000,
  })

  useDeepLinkSelection(data?.items, setSelected)

  const { data: traceFiles } = useQuery({
    queryKey: ["logs", "traces"],
    queryFn: () => api<TraceFilesResponse>("/logs/traces"),
    staleTime: 60_000,
  })

  const livePayloads = useLiveTailStream(liveTail)

  if (isLoading || !data) {
    return <div className="text-tremor-content">Loading logs…</div>
  }
  if (error) {
    return (
      <div className="rounded-tremor-small border border-rose-300 bg-rose-50 p-4 text-rose-700">
        Failed to load logs: {error.message}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <KindTabs
        kindFilter={kindFilter}
        setKindFilter={setKindFilter}
        kindCounts={data.kind_counts ?? { messages: 0, other: 0 }}
      />
      <FilterBar
        search={search}
        setSearch={setSearch}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        modelFilter={modelFilter}
        setModelFilter={setModelFilter}
        allModels={data.all_models}
        liveTail={liveTail}
        setLiveTail={setLiveTail}
        livePayloadCount={livePayloads.length}
        onRefresh={() => refetch()}
      />
      {liveTail && <LiveTailPanel payloads={livePayloads} />}
      <LogsTableCard
        items={data.items}
        total={data.total}
        page={page}
        setPage={setPage}
        onSelect={setSelected}
      />
      {traceFiles && traceFiles.items.length > 0 && (
        <TraceFilesCard items={traceFiles.items} />
      )}
      {selected && (
        <DetailDrawer entry={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Deep-link / live-tail hooks
// ---------------------------------------------------------------------------

function useDeepLinkSelection(
  items: Array<LogEntry> | undefined,
  setSelected: (e: LogEntry) => void,
) {
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const idStr = searchParams.get("event")
    if (!idStr) return
    const id = Number.parseInt(idStr, 10)
    if (!Number.isFinite(id) || id <= 0) return
    const hit = items?.find((it) => it.id === id)
    if (hit) {
      setSelected(hit)
      searchParams.delete("event")
      setSearchParams(searchParams, { replace: true })
      return
    }
    // Synthesize a stub so the drawer can still load the trace via /logs/:id/trace.
    api<LogsListResponse>(`/logs?limit=1&offset=0&q=`)
      .then(() => {
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
          thinking_level: null,
          cache_read_tokens: null,
          cache_creation_tokens: null,
          reasoning_tokens: null,
        }
        setSelected(stub)
        searchParams.delete("event")
        setSearchParams(searchParams, { replace: true })
      })
      .catch(() => {})
  }, [items, searchParams, setSearchParams, setSelected])
}

function useLiveTailStream(enabled: boolean): Array<SsePayload> {
  const [payloads, setPayloads] = useState<Array<SsePayload>>([])
  const sseRef = useRef<EventSource | null>(null)
  useEffect(() => {
    if (!enabled) {
      sseRef.current?.close()
      sseRef.current = null
      return
    }
    const es = new EventSource("/admin/traces/stream", {
      withCredentials: true,
    })
    sseRef.current = es
    const onMessage = (ev: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(ev.data) as SsePayload
        setPayloads((prev) => [payload, ...prev].slice(0, 50))
      } catch {
        // ignore malformed
      }
    }
    const onError = () => {
      // EventSource auto-reconnects; surface only if it stays broken
    }
    es.addEventListener("message", onMessage)
    es.addEventListener("error", onError)
    return () => {
      es.removeEventListener("message", onMessage)
      es.removeEventListener("error", onError)
      es.close()
      sseRef.current = null
    }
  }, [enabled])
  return payloads
}

// ---------------------------------------------------------------------------
// Top-of-page controls
// ---------------------------------------------------------------------------

function KindTabs({
  kindFilter,
  setKindFilter,
  kindCounts,
}: {
  kindFilter: KindFilter
  setKindFilter: (k: KindFilter) => void
  kindCounts: { messages: number; other: number }
}) {
  const tabs: Array<[KindFilter, string, number]> = [
    ["messages", "Messages", kindCounts.messages],
    ["other", "Other", kindCounts.other],
    ["all", "All", kindCounts.messages + kindCounts.other],
  ]
  return (
    <div className="flex gap-1 border-b border-tremor-border">
      {tabs.map(([k, label, count]) => (
        <button
          key={k}
          onClick={() => setKindFilter(k)}
          className={
            "border-b-2 px-3 py-2 text-sm font-medium "
            + (kindFilter === k ?
              "border-tremor-brand text-tremor-brand-emphasis"
            : "border-transparent text-tremor-content hover:text-tremor-content-strong")
          }
        >
          {label}
          <span className="ml-1.5 text-xs text-tremor-content-subtle">
            {fmt(count)}
          </span>
        </button>
      ))}
    </div>
  )
}

function FilterBar({
  search,
  setSearch,
  statusFilter,
  setStatusFilter,
  modelFilter,
  setModelFilter,
  allModels,
  liveTail,
  setLiveTail,
  livePayloadCount,
  onRefresh,
}: {
  search: string
  setSearch: (s: string) => void
  statusFilter: StatusFilter
  setStatusFilter: (s: StatusFilter) => void
  modelFilter: string
  setModelFilter: (s: string) => void
  allModels: Array<string>
  liveTail: boolean
  setLiveTail: (v: boolean) => void
  livePayloadCount: number
  onRefresh: () => void
}) {
  return (
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
          {allModels.map((m) => (
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
            {liveTail && livePayloadCount > 0 && (
              <span className="ml-1 text-xs text-tremor-content-subtle">
                ({livePayloadCount})
              </span>
            )}
          </span>
        </label>
        <Button variant="secondary" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
    </Card>
  )
}

function LiveTailPanel({ payloads }: { payloads: Array<SsePayload> }) {
  return (
    <Card>
      <h3 className="text-sm font-semibold text-tremor-content-strong">
        Live trace stream
      </h3>
      <Text>
        Captures only fire for keys with debug mode on. The 50 most recent
        redacted payloads stay in memory; refresh keeps the historical table
        fresh.
      </Text>
      <div className="mt-3 max-h-64 overflow-y-auto rounded-tremor-small border border-tremor-border bg-tremor-background-muted p-2">
        {payloads.length === 0 ?
          <div className="py-4 text-center text-xs text-tremor-content-subtle">
            Waiting for events…
          </div>
        : <ul className="space-y-1 text-xs">
            {payloads.map((p, i) => (
              <li key={i} className="rounded bg-tremor-background p-2 mono">
                {JSON.stringify(p).slice(0, 240)}
                {JSON.stringify(p).length > 240 && "…"}
              </li>
            ))}
          </ul>
        }
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Logs table
// ---------------------------------------------------------------------------

function LogsTableCard({
  items,
  total,
  page,
  setPage,
  onSelect,
}: {
  items: Array<LogEntry>
  total: number
  page: number
  setPage: (updater: (p: number) => number) => void
  onSelect: (e: LogEntry) => void
}) {
  return (
    <Card className="!p-0 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-tremor-border bg-tremor-background-muted text-left text-xs uppercase text-tremor-content-subtle">
              <th className="px-4 py-2">Time</th>
              <th className="px-4 py-2">Key</th>
              <th className="px-4 py-2">Model</th>
              <th className="px-4 py-2">Thinking</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Latency</th>
              <th className="px-4 py-2">Tokens (p/c)</th>
              <th className="px-4 py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ?
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-tremor-content-subtle"
                >
                  No events match the current filters.
                </td>
              </tr>
            : items.map((row) => (
                <LogRow key={row.id} row={row} onClick={() => onSelect(row)} />
              ))
            }
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        setPage={setPage}
        total={total}
        count={items.length}
      />
    </Card>
  )
}

function LogRow({ row, onClick }: { row: LogEntry; onClick: () => void }) {
  return (
    <tr
      onClick={onClick}
      className="cursor-pointer border-b border-tremor-border last:border-b-0 hover:bg-tremor-background-muted/60"
    >
      <td className="px-4 py-2 text-xs text-tremor-content">
        <span title={fmtAbsolute(row.ts)}>{fmtRelative(row.ts)}</span>
      </td>
      <td className="px-4 py-2 text-tremor-content-strong">
        <span className="mono text-xs">
          {row.key_label || row.key_id.slice(-8)}
        </span>
      </td>
      <td className="px-4 py-2 text-tremor-content">
        <ModelOrEndpoint value={row.model} />
      </td>
      <td className="px-4 py-2 text-xs">
        {row.thinking_level ?
          <Badge color={thinkingBadgeColor(row.thinking_level)}>
            {thinkingLabel(row.thinking_level)}
          </Badge>
        : <span className="text-tremor-content-subtle">—</span>}
      </td>
      <td className="px-4 py-2">
        <Badge color={STATUS_COLOR(row.status)}>{row.status}</Badge>
      </td>
      <td className="px-4 py-2 text-xs text-tremor-content">
        {row.latency_ms} ms
      </td>
      <TokenCell row={row} />
      <td className="px-4 py-2 text-xs text-rose-700">
        {row.error ?
          row.error.slice(0, 60) + (row.error.length > 60 ? "…" : "")
        : "—"}
      </td>
    </tr>
  )
}

function methodColor(method: string): "blue" | "emerald" | "rose" | "slate" {
  if (method === "GET") return "blue"
  if (method === "POST") return "emerald"
  if (method === "DELETE") return "rose"
  return "slate"
}

function ModelOrEndpoint({ value }: { value: string }) {
  // Telemetry stores non-message routes as "<METHOD> <path>" (the path
  // always contains a "/", real model names never do). Detect that and
  // render the method as a coloured pill so the Other tab clearly shows
  // which endpoint each row is for.
  const m = /^([A-Z]+)\s+(\/.*)$/.exec(value)
  if (!m) return <span>{value}</span>
  const method = m[1]
  const path = m[2]
  return (
    <div className="flex items-center gap-1.5">
      <Badge color={methodColor(method)}>{method}</Badge>
      <span className="mono text-xs">{path}</span>
    </div>
  )
}

function TokenCell({ row }: { row: LogEntry }) {
  return (
    <td className="px-4 py-2 text-xs text-tremor-content">
      {fmt(row.prompt_tokens)}/{fmt(row.completion_tokens)}
      {(row.reasoning_tokens ?? 0) > 0 && (
        <span className="ml-1 text-[10px] text-violet-600">
          ·think {fmt(row.reasoning_tokens)}
        </span>
      )}
      {(row.cache_read_tokens ?? 0) > 0 && (
        <span className="ml-1 text-[10px] text-emerald-600">
          ·hit {fmt(row.cache_read_tokens)}
        </span>
      )}
      {(row.cache_creation_tokens ?? 0) > 0 && (
        <span className="ml-1 text-[10px] text-violet-600">
          ·wr {fmt(row.cache_creation_tokens)}
        </span>
      )}
    </td>
  )
}

function Pagination({
  page,
  setPage,
  total,
  count,
}: {
  page: number
  setPage: (updater: (p: number) => number) => void
  total: number
  count: number
}) {
  const atLast = (page + 1) * PAGE_SIZE >= total
  return (
    <div className="flex items-center justify-between border-t border-tremor-border px-4 py-2 text-xs text-tremor-content-subtle">
      <span>
        Showing{" "}
        {total === 0 ?
          "0"
        : `${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + count}`}{" "}
        of {total} matching events
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
          className={
            "rounded border border-tremor-border px-2 py-0.5 "
            + (page === 0 ?
              "cursor-not-allowed opacity-40"
            : "hover:bg-tremor-background-muted")
          }
        >
          ‹ Prev
        </button>
        <span className="mono text-tremor-content">
          Page {page + 1}
          {total > 0 && <> / {Math.max(1, Math.ceil(total / PAGE_SIZE))}</>}
        </span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={atLast}
          className={
            "rounded border border-tremor-border px-2 py-0.5 "
            + (atLast ?
              "cursor-not-allowed opacity-40"
            : "hover:bg-tremor-background-muted")
          }
        >
          Next ›
        </button>
      </div>
    </div>
  )
}

function TraceFilesCard({ items }: { items: TraceFilesResponse["items"] }) {
  return (
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
        {items.map((f) => (
          <li
            key={f.name}
            className="flex items-center justify-between rounded border border-tremor-border px-3 py-2"
          >
            <span className="mono text-xs">{f.name}</span>
            <span className="text-xs text-tremor-content-subtle">
              {fmt(f.size)} bytes · {new Date(f.mtime).toLocaleDateString()}
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
  )
}
