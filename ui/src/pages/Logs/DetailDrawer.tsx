import { useQuery } from "@tanstack/react-query"
import { Badge, Button, Card, Text } from "@tremor/react"
import { useState } from "react"
import { Link } from "react-router-dom"

import type { FullTraceResponse, LogEntry, TraceLeg } from "~/api/types"

import { api } from "~/api/client"
import {
  extractKeyMetrics,
  KpiBar,
  parseBody,
  TraceLegStructured,
} from "~/components/TraceStructured"

import {
  extractErrorDetail,
  fmt,
  fmtAbsolute,
  fmtRelative,
  STATUS_COLOR,
  thinkingBadgeColor,
  thinkingLabel,
} from "./helpers"

interface DetailDrawerProps {
  entry: LogEntry
  onClose: () => void
}

type TabKey = "summary" | "request" | "response" | "metadata"

interface NoCaptureBody {
  reason?: string
  key_diagnosis?: string
  diagnostics?: Record<string, unknown>
}

function extractNoCaptureBody(
  traceError: unknown,
  noCapture: boolean,
): NoCaptureBody | null {
  if (!noCapture) return null
  return (traceError as { body?: NoCaptureBody } | null)?.body ?? null
}

export function DetailDrawer({ entry, onClose }: DetailDrawerProps) {
  const [tab, setTab] = useState<TabKey>("summary")
  const [copied, setCopied] = useState<string | null>(null)

  const {
    data: traceData,
    isLoading: traceLoading,
    error: traceError,
  } = useQuery({
    queryKey: ["logs", entry.id, "trace"],
    queryFn: () => api<FullTraceResponse>(`/logs/${entry.id}/trace`),
    retry: false,
  })

  const trace = traceData?.trace
  const noCapture =
    traceError !== null && (traceError as { status?: number }).status === 404
  // The 404 body carries diagnostic context (key still on debug?
  // wrong server? key revoked?) — pull it out for the drawer.
  const noCaptureBody = extractNoCaptureBody(traceError, noCapture)

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(tag)
      globalThis.setTimeout(() => setCopied(null), 1500)
    } catch {
      // ignore
    }
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
        <DrawerHeader entry={entry} onClose={onClose} />
        <TabStrip tab={tab} setTab={setTab} noCapture={noCapture} />
        {tab === "summary" && (
          <SummaryTab
            entry={entry}
            trace={trace}
            noCapture={noCapture}
            noCaptureReason={noCaptureBody?.reason ?? null}
            noCaptureKeyDiag={noCaptureBody?.key_diagnosis ?? null}
            noCaptureDiag={noCaptureBody?.diagnostics ?? null}
            copied={copied}
            onCopyCurl={(s) => void copy(s, "curl")}
          />
        )}
        {(tab === "request" || tab === "response" || tab === "metadata") && (
          <LegsTab
            tab={tab}
            trace={trace}
            traceData={traceData}
            traceLoading={traceLoading}
            noCapture={noCapture}
            noCaptureReason={noCaptureBody?.reason ?? null}
            copied={copied}
            onCopy={(s, t) => void copy(s, t)}
          />
        )}
      </div>
    </div>
  )
}

function DrawerHeader({
  entry,
  onClose,
}: {
  entry: LogEntry
  onClose: () => void
}) {
  return (
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
  )
}

function TabStrip({
  tab,
  setTab,
  noCapture,
}: {
  tab: TabKey
  setTab: (t: TabKey) => void
  noCapture: boolean
}) {
  return (
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
            + (tab === k ?
              "border-tremor-brand text-tremor-brand-emphasis"
            : "border-transparent text-tremor-content hover:text-tremor-content-strong")
          }
        >
          {label}
          {k !== "summary" && noCapture && (
            <span className="ml-1 text-xs text-tremor-content-subtle">·</span>
          )}
        </button>
      ))}
    </div>
  )
}

interface FullTrace {
  trace_id?: string
  ts?: number
  key_id?: string
  route?: string
  req?: TraceLeg
  upstream_req?: TraceLeg
  upstream_res?: TraceLeg
  res?: TraceLeg
  latency_ms?: number
}

function SummaryTab({
  entry,
  trace,
  noCapture,
  noCaptureReason,
  noCaptureKeyDiag,
  noCaptureDiag,
  copied,
  onCopyCurl,
}: {
  entry: LogEntry
  trace: FullTrace | undefined
  noCapture: boolean
  noCaptureReason: string | null
  noCaptureKeyDiag: string | null
  noCaptureDiag: Record<string, unknown> | null
  copied: string | null
  onCopyCurl: (curl: string) => void
}) {
  const reqBody = parseBody(trace?.req?.body).parsed
  const resBody = parseBody(trace?.res?.body).parsed
  const metrics = extractKeyMetrics(reqBody, resBody)

  return (
    <div className="mt-4 space-y-4">
      <KpiBar metrics={metrics} />
      <SummaryFields entry={entry} trace={trace} />
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
              const curl = buildCurl(trace)
              if (curl) onCopyCurl(curl)
            }}
            disabled={!trace.req}
          >
            {copied === "curl" ? "Copied!" : "Copy cURL"}
          </Button>
        </Card>
      )}
      {noCapture && (
        <Card decoration="top" decorationColor="amber">
          <Text className="font-medium text-tremor-content-strong">
            No captured request/response for this event.
          </Text>
          {noCaptureKeyDiag && (
            <Text className="mt-1.5">{noCaptureKeyDiag}</Text>
          )}
          {noCaptureReason && noCaptureReason !== noCaptureKeyDiag && (
            <Text className="mt-1.5 text-xs text-tremor-content-subtle">
              {noCaptureReason}
            </Text>
          )}
          {noCaptureDiag && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-tremor-content-subtle hover:text-tremor-content-strong">
                Trace lookup diagnostics
              </summary>
              <pre className="mt-2 mono text-xs whitespace-pre-wrap break-words rounded bg-tremor-background-muted p-2">
                {JSON.stringify(noCaptureDiag, null, 2)}
              </pre>
            </details>
          )}
        </Card>
      )}
    </div>
  )
}

function SummaryFields({
  entry,
  trace,
}: {
  entry: LogEntry
  trace: FullTrace | undefined
}) {
  return (
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
        <Badge color={STATUS_COLOR(entry.status)}>{entry.status}</Badge>
      </dd>
      <dt className="text-tremor-content-subtle">Latency</dt>
      <dd className="text-tremor-content-strong">{entry.latency_ms} ms</dd>
      <dt className="text-tremor-content-subtle">Tokens p/c</dt>
      <dd className="text-tremor-content-strong">
        {fmt(entry.prompt_tokens)}/{fmt(entry.completion_tokens)}
      </dd>
      <OptionalTokenFields entry={entry} />
      {entry.thinking_level && (
        <>
          <dt className="text-tremor-content-subtle">Thinking</dt>
          <dd>
            <Badge color={thinkingBadgeColor(entry.thinking_level)}>
              {thinkingLabel(entry.thinking_level)}
            </Badge>
          </dd>
        </>
      )}
      {entry.error && <ErrorField entry={entry} trace={trace} />}
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
  )
}

function OptionalTokenFields({ entry }: { entry: LogEntry }) {
  return (
    <>
      {(entry.reasoning_tokens ?? 0) > 0 && (
        <>
          <dt className="text-tremor-content-subtle">Thinking tokens</dt>
          <dd className="text-violet-700">{fmt(entry.reasoning_tokens)}</dd>
        </>
      )}
      {(entry.cache_read_tokens ?? 0) > 0 && (
        <>
          <dt className="text-tremor-content-subtle">Cache hit</dt>
          <dd className="text-emerald-700">{fmt(entry.cache_read_tokens)}</dd>
        </>
      )}
      {(entry.cache_creation_tokens ?? 0) > 0 && (
        <>
          <dt className="text-tremor-content-subtle">Cache write</dt>
          <dd className="text-violet-700">
            {fmt(entry.cache_creation_tokens)}
          </dd>
        </>
      )}
    </>
  )
}

function ErrorField({
  entry,
  trace,
}: {
  entry: LogEntry
  trace: FullTrace | undefined
}) {
  const detail = extractErrorDetail(trace)
  return (
    <>
      <dt className="text-tremor-content-subtle">Error</dt>
      <dd className="text-rose-700 whitespace-pre-wrap break-words">
        <div className="font-medium">{entry.error}</div>
        {detail && (
          <div className="mt-1 text-xs font-normal text-rose-800">{detail}</div>
        )}
      </dd>
    </>
  )
}

function LegsTab({
  tab,
  trace,
  traceData,
  traceLoading,
  noCapture,
  noCaptureReason,
  copied,
  onCopy,
}: {
  tab: "request" | "response" | "metadata"
  trace: FullTrace | undefined
  traceData: FullTraceResponse | undefined
  traceLoading: boolean
  noCapture: boolean
  noCaptureReason: string | null
  copied: string | null
  onCopy: (s: string, tag: string) => void
}) {
  return (
    <div className="mt-4">
      {traceLoading && (
        <Text className="text-tremor-content-subtle">Loading trace…</Text>
      )}
      {noCapture && (
        <Card decoration="top" decorationColor="amber">
          <Text>
            {noCaptureReason
              ?? `No captured trace for this event. Enable debug on the key`
                + ` and re-run the request to capture future calls.`}
          </Text>
        </Card>
      )}
      {tab === "request" && trace && (
        <RequestPanels trace={trace} copied={copied} onCopy={onCopy} />
      )}
      {tab === "response" && trace && (
        <ResponsePanels trace={trace} copied={copied} onCopy={onCopy} />
      )}
      {tab === "metadata" && trace && (
        <MetadataPre trace={trace} file={traceData?.file ?? ""} />
      )}
    </div>
  )
}

function RequestPanels({
  trace,
  copied,
  onCopy,
}: {
  trace: FullTrace
  copied: string | null
  onCopy: (s: string, tag: string) => void
}) {
  return (
    <>
      <TraceLegPanel
        title="Inbound request (from client to copilot-api)"
        leg={trace.req}
        onCopy={(s) => onCopy(s, "req")}
        copied={copied === "req"}
      />
      {trace.upstream_req && (
        <div className="mt-4">
          <TraceLegPanel
            title="Outbound request (copilot-api → Copilot upstream)"
            leg={trace.upstream_req}
            onCopy={(s) => onCopy(s, "ureq")}
            copied={copied === "ureq"}
          />
        </div>
      )}
    </>
  )
}

function ResponsePanels({
  trace,
  copied,
  onCopy,
}: {
  trace: FullTrace
  copied: string | null
  onCopy: (s: string, tag: string) => void
}) {
  return (
    <>
      {trace.upstream_res && (
        <TraceLegPanel
          title="Upstream response (Copilot → copilot-api)"
          leg={trace.upstream_res}
          onCopy={(s) => onCopy(s, "ures")}
          copied={copied === "ures"}
        />
      )}
      {trace.res && (
        <div className="mt-4">
          <TraceLegPanel
            title="Final response (copilot-api → client)"
            leg={trace.res}
            onCopy={(s) => onCopy(s, "res")}
            copied={copied === "res"}
          />
        </div>
      )}
    </>
  )
}

function MetadataPre({ trace, file }: { trace: FullTrace; file: string }) {
  return (
    <pre className="rounded bg-tremor-background-muted p-3 mono text-xs whitespace-pre-wrap break-words">
      {JSON.stringify(
        {
          trace_id: trace.trace_id,
          ts: trace.ts,
          key_id: trace.key_id,
          route: trace.route,
          latency_ms: trace.latency_ms,
          file,
        },
        null,
        2,
      )}
    </pre>
  )
}

function buildCurl(trace: FullTrace): string | null {
  if (!trace.req) return null
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
    lines.push(`  -H '${k}: ${v.replaceAll("'", `'\\''`)}' \\`)
  }
  if (req.body !== undefined && req.body !== null) {
    const bodyStr =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body)
    lines.push(`  -d '${bodyStr.replaceAll("'", `'\\''`)}'`)
  } else {
    // trim trailing backslash
    const last = lines.at(-1)
    if (last) lines[lines.length - 1] = last.replace(/ \\$/, "")
  }
  return lines.join("\n")
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
                {
                  method: leg.method,
                  url: leg.url,
                  status: leg.status,
                  headers,
                  body: leg.body,
                },
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
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n")}
        </pre>
      </details>
      <TraceLegStructured body={leg.body} />
    </div>
  )
}
