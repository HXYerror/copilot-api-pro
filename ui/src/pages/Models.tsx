import { useQuery } from "@tanstack/react-query"
import { Badge, Button, Card, Grid, Text, Title } from "@tremor/react"
import { useState } from "react"

import type { ModelEntry, ModelsListResponse } from "~/api/types"

import { api } from "~/api/client"

const NUM_FMT = new Intl.NumberFormat("en", { notation: "compact" })

function fmt(n: number): string {
  return NUM_FMT.format(n)
}

function fmtTokens(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

function fmtRelative(ts: number | null): string {
  if (!ts) return "never"
  const age = Date.now() - ts
  if (age < 60_000) return `${Math.floor(age / 1000)}s ago`
  if (age < 3600_000) return `${Math.floor(age / 60_000)}m ago`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`
  return `${Math.floor(age / 86_400_000)}d ago`
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`
}

function vendorColor(
  vendor: string | undefined,
): "violet" | "indigo" | "blue" | "amber" | "slate" | "rose" {
  if (!vendor) return "slate"
  const v = vendor.toLowerCase()
  if (v.includes("openai")) return "blue"
  if (v.includes("anthropic") || v.includes("claude")) return "violet"
  if (v.includes("google") || v.includes("gemini")) return "indigo"
  if (v.includes("xai")) return "rose"
  if (v.includes("mistral")) return "amber"
  return "slate"
}

function RefreshHeader({
  isFetching,
  onRefetch,
}: {
  isFetching: boolean
  onRefetch: () => Promise<unknown>
}) {
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  async function handleRefresh() {
    setRefreshing(true)
    setRefreshError(null)
    try {
      await api<{ ok: boolean; catalog_size: number }>("/models/refresh", {
        method: "POST",
      })
      await onRefetch()
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <Text className="text-tremor-content-subtle">
        Upstream catalog cached at startup — refresh to pull the latest model
        list from Copilot.
      </Text>
      <div className="flex items-center gap-2">
        {refreshError && (
          <span className="text-xs text-rose-700">{refreshError}</span>
        )}
        <Button
          variant="secondary"
          loading={refreshing || isFetching}
          onClick={handleRefresh}
        >
          Refresh
        </Button>
      </div>
    </div>
  )
}

export function Models() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["models"],
    queryFn: () => api<ModelsListResponse>("/models"),
  })

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  if (isLoading || !data) {
    return <div className="text-tremor-content">Loading models…</div>
  }
  if (error) {
    return (
      <div className="rounded-tremor-small border border-rose-300 bg-rose-50 p-4 text-rose-700">
        Failed to load models: {error.message}
      </div>
    )
  }

  function toggle(alias: string) {
    setExpanded((p) => ({ ...p, [alias]: !p[alias] }))
  }

  return (
    <div className="space-y-4">
      <RefreshHeader isFetching={isFetching} onRefetch={refetch} />
      <Grid numItemsSm={2} numItemsLg={4} className="gap-4">
        <Card decoration="top" decorationColor="blue">
          <Text>Aliases configured</Text>
          <p className="mt-1 text-2xl font-semibold">
            {data.summary.total_aliases}
          </p>
        </Card>
        <Card decoration="top" decorationColor="emerald">
          <Text>In use (24h)</Text>
          <p className="mt-1 text-2xl font-semibold">
            {data.summary.aliases_in_use}
          </p>
        </Card>
        <Card
          decoration="top"
          decorationColor={
            data.summary.aliases_with_errors > 0 ? "rose" : "slate"
          }
        >
          <Text>With errors (24h)</Text>
          <p className="mt-1 text-2xl font-semibold">
            {data.summary.aliases_with_errors}
          </p>
        </Card>
        <Card decoration="top" decorationColor="violet">
          <Text>Upstream catalog</Text>
          <p className="mt-1 text-2xl font-semibold">
            {data.summary.catalog_size}
          </p>
          <Text className="mt-1 text-xs">models available from Copilot</Text>
        </Card>
      </Grid>

      <Card className="!p-0 overflow-hidden">
        <div className="border-b border-tremor-border p-4">
          <Title>Aliases</Title>
          <Text>
            Mapped in <span className="mono">config.models</span>. Click a row
            to view full Copilot capability metadata.
          </Text>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-tremor-border bg-tremor-background-muted text-left text-xs uppercase text-tremor-content-subtle">
                <th className="px-4 py-2 w-8"></th>
                <th className="px-4 py-2">Alias</th>
                <th className="px-4 py-2">Upstream</th>
                <th className="px-4 py-2">Vendor / family</th>
                <th className="px-4 py-2">Context / output</th>
                <th className="px-4 py-2">Endpoints</th>
                <th className="px-4 py-2">Thinking</th>
                <th className="px-4 py-2">Reasoning</th>
                <th className="px-4 py-2">Tools</th>
                <th className="px-4 py-2">Vision</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">24h req / err</th>
                <th className="px-4 py-2 text-right">Last used</th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 ?
                <tr>
                  <td
                    colSpan={13}
                    className="px-4 py-8 text-center text-tremor-content-subtle"
                  >
                    No aliases configured. Add one via Settings.
                  </td>
                </tr>
              : data.items.map((m: ModelEntry) => {
                  const caps = m.capabilities as
                    | (NonNullable<ModelEntry["capabilities"]>
                        & Record<string, unknown>)
                    | null
                  const limits = (caps?.limits ?? {}) as Record<string, unknown>
                  const supports = (caps?.supports ?? {}) as Record<
                    string,
                    unknown
                  >
                  const isOpen = Boolean(expanded[m.alias])
                  return (
                    <RowGroup
                      key={m.alias}
                      m={m}
                      caps={caps}
                      limits={limits}
                      supports={supports}
                      isOpen={isOpen}
                      onToggle={() => toggle(m.alias)}
                    />
                  )
                })
              }
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

interface RowGroupProps {
  m: ModelEntry
  caps: Record<string, unknown> | null
  limits: Record<string, unknown>
  supports: Record<string, unknown>
  isOpen: boolean
  onToggle: () => void
}

function RowGroup({
  m,
  caps,
  limits,
  supports,
  isOpen,
  onToggle,
}: RowGroupProps) {
  const ctx = limits.max_context_window_tokens as number | undefined
  const out = limits.max_output_tokens as number | undefined
  const nonStreamOut = limits.max_non_streaming_output_tokens as
    | number
    | undefined
  const promptCap = limits.max_prompt_tokens as number | undefined

  const minThink = supports.min_thinking_budget as number | undefined
  const maxThink = supports.max_thinking_budget as number | undefined
  const adaptiveThink = supports.adaptive_thinking === true
  const reasoning =
    Array.isArray(supports.reasoning_effort) ?
      (supports.reasoning_effort as Array<string>)
    : null
  const visionObj = limits.vision as Record<string, unknown> | undefined

  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-tremor-border last:border-b-0 align-top hover:bg-tremor-background-muted/60"
      >
        <td className="px-4 py-2 text-tremor-content-subtle">
          {isOpen ? "▾" : "▸"}
        </td>
        <td className="px-4 py-2 font-medium text-tremor-content-strong">
          {m.alias}
        </td>
        <td className="px-4 py-2 mono text-xs text-tremor-content">
          {m.upstream}
          {caps?.preview === true && (
            <Badge className="ml-1" color="amber">
              preview
            </Badge>
          )}
        </td>
        <td className="px-4 py-2 text-xs">
          {caps ?
            <div className="space-y-1">
              <Badge color={vendorColor(caps.vendor as string | undefined)}>
                {(caps.vendor as string) ?? "—"}
              </Badge>
              <div className="text-tremor-content">{caps.family as string}</div>
            </div>
          : <span className="text-tremor-content-subtle">—</span>}
        </td>
        <td className="px-4 py-2 text-xs text-tremor-content">
          {caps ?
            <>
              <div>
                <span className="text-tremor-content-subtle">ctx</span>{" "}
                {fmtTokens(ctx)}
              </div>
              <div>
                <span className="text-tremor-content-subtle">out</span>{" "}
                {fmtTokens(out)}
              </div>
              {promptCap !== undefined && (
                <div className="text-tremor-content-subtle">
                  prompt {fmtTokens(promptCap)}
                </div>
              )}
            </>
          : "—"}
        </td>
        <td className="px-4 py-2 text-xs">
          {(
            Array.isArray(caps?.supported_endpoints)
            && (caps?.supported_endpoints as Array<string>).length > 0
          ) ?
            <div className="flex flex-wrap gap-1">
              {(caps?.supported_endpoints as Array<string>)
                .filter((p) => !p.startsWith("ws:"))
                .map((p) => (
                  <Badge key={p} color={p === "/responses" ? "violet" : "blue"}>
                    {p}
                  </Badge>
                ))}
            </div>
          : <span className="text-tremor-content-subtle">—</span>}
        </td>
        <td className="px-4 py-2 text-xs">
          {maxThink !== undefined ?
            <>
              <Badge color="cyan">
                {minThink ?? "?"}–{fmtTokens(maxThink)}
              </Badge>
              {adaptiveThink && (
                <div className="mt-1 text-tremor-content">adaptive</div>
              )}
            </>
          : <span className="text-tremor-content-subtle">—</span>}
        </td>
        <td className="px-4 py-2 text-xs">
          {reasoning ?
            <div className="flex flex-wrap gap-1">
              {reasoning.map((eff) => (
                <Badge key={eff} color="indigo">
                  {eff}
                </Badge>
              ))}
            </div>
          : <span className="text-tremor-content-subtle">—</span>}
        </td>
        <td className="px-4 py-2 text-xs">
          {supports.tool_calls === true ?
            <div className="flex flex-wrap gap-1">
              <Badge color="emerald">yes</Badge>
              {supports.parallel_tool_calls === true && (
                <Badge color="emerald">parallel</Badge>
              )}
              {supports.structured_outputs === true && (
                <Badge color="violet">structured</Badge>
              )}
            </div>
          : <span className="text-tremor-content-subtle">no</span>}
        </td>
        <td className="px-4 py-2 text-xs">
          {supports.vision === true ?
            <div>
              <Badge color="indigo">yes</Badge>
              {visionObj && (
                <div className="mt-1 text-tremor-content-subtle">
                  {String(visionObj.max_prompt_images ?? "?")} imgs
                </div>
              )}
            </div>
          : <span className="text-tremor-content-subtle">—</span>}
        </td>
        <td className="px-4 py-2">
          {m.enabled ?
            <Badge color="emerald">enabled</Badge>
          : <Badge color="slate">disabled</Badge>}
        </td>
        <td className="px-4 py-2 text-right text-tremor-content">
          <div>{fmt(m.requests_24h)}</div>
          <div className="text-xs">
            {m.errors_24h === 0 ?
              <span className="text-tremor-content-subtle">no errors</span>
            : <span className="text-rose-700">
                {m.errors_24h} ({fmtPct(m.error_rate_24h)})
              </span>
            }
          </div>
        </td>
        <td className="px-4 py-2 text-right text-xs text-tremor-content">
          {fmtRelative(m.last_used)}
          {nonStreamOut !== undefined && (
            <div className="text-tremor-content-subtle">
              ns-out {fmtTokens(nonStreamOut)}
            </div>
          )}
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-tremor-border">
          <td></td>
          <td colSpan={11} className="px-4 py-3 bg-tremor-background-muted/40">
            <RowDetails caps={caps} m={m} />
          </td>
        </tr>
      )}
    </>
  )
}

function RowDetails({
  caps,
  m,
}: {
  caps: Record<string, unknown> | null
  m: ModelEntry
}) {
  if (!caps) {
    return (
      <Text className="text-tremor-content-subtle">
        No capability metadata available — model is not in the upstream catalog
        (may have been retired).
      </Text>
    )
  }
  return (
    <div className="space-y-3 text-xs">
      <div className="grid gap-3 sm:grid-cols-3">
        <KvCard
          title="Identity"
          rows={{
            alias: m.alias,
            upstream: m.upstream,
            version: caps.version,
            family: caps.family,
            type: caps.type,
            tokenizer: caps.tokenizer,
            vendor: caps.vendor,
            preview: caps.preview,
            model_picker_enabled: caps.model_picker_enabled,
          }}
        />
        <KvCard
          title="Limits"
          rows={(caps.limits as Record<string, unknown>) ?? {}}
        />
        <KvCard
          title="Supports"
          rows={(caps.supports as Record<string, unknown>) ?? {}}
        />
      </div>
      <details>
        <summary className="cursor-pointer text-tremor-content-subtle hover:text-tremor-content-strong">
          Raw JSON
        </summary>
        <pre className="mt-2 mono text-xs whitespace-pre-wrap break-words rounded bg-tremor-background p-3">
          {JSON.stringify(caps, null, 2)}
        </pre>
      </details>
    </div>
  )
}

function KvCard({
  title,
  rows,
}: {
  title: string
  rows: Record<string, unknown>
}) {
  const entries = Object.entries(rows)
  return (
    <div className="rounded-tremor-small border border-tremor-border bg-tremor-background p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-tremor-content-subtle">
        {title}
      </div>
      {entries.length === 0 ?
        <div className="text-tremor-content-subtle">—</div>
      : <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          {entries.map(([k, v]) => (
            <RenderKv key={k} k={k} v={v} />
          ))}
        </dl>
      }
    </div>
  )
}

function RenderKv({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <dt className="text-tremor-content-subtle">{k}</dt>
      <dd className="text-tremor-content-strong break-all">{renderValue(v)}</dd>
    </>
  )
}

function renderValue(v: unknown): React.ReactNode {
  if (v === null || v === undefined) {
    return <span className="text-tremor-content-subtle">—</span>
  }
  if (typeof v === "boolean") return v ? "true" : "false"
  if (typeof v === "number") return v.toString()
  if (typeof v === "string") return v
  if (Array.isArray(v)) {
    return (
      <div className="flex flex-wrap gap-1">
        {v.map((item, i) => (
          <Badge key={i} color="slate">
            {typeof item === "string" || typeof item === "number" ?
              String(item)
            : JSON.stringify(item)}
          </Badge>
        ))}
      </div>
    )
  }
  // Nested object: render inline pretty JSON
  return (
    <pre className="mono text-xs whitespace-pre-wrap break-words">
      {JSON.stringify(v, null, 2)}
    </pre>
  )
}
