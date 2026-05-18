import {
  AreaChart,
  BadgeDelta,
  BarList,
  Card,
  Color,
  DonutChart,
  Grid,
  List,
  ListItem,
  Metric,
  Text,
  Title,
} from "@tremor/react"
import { useQuery } from "@tanstack/react-query"

import { api } from "~/api/client"
import type { OverviewResponse } from "~/api/types"

const NUM_FMT = new Intl.NumberFormat("en", { notation: "compact" })

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—"
  return NUM_FMT.format(n)
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`
}

function fmtRelative(ts: number): string {
  const age = Date.now() - ts
  if (age < 60_000) return `${Math.floor(age / 1000)}s ago`
  if (age < 3600_000) return `${Math.floor(age / 60_000)}m ago`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`
  return `${Math.floor(age / 86_400_000)}d ago`
}

/**
 * Bucket per-minute model points into a wide-format Tremor AreaChart series
 * (one column per model). We cap distinct models to 6 — anything beyond
 * lumps into "other" so the legend stays readable.
 */
function buildSeriesChart(
  points: OverviewResponse["series_requests_24h"],
): {
  data: Array<Record<string, number | string>>
  categories: Array<string>
} {
  if (points.length === 0) return { data: [], categories: [] }

  // Group totals to pick top N models
  const totals = new Map<string, number>()
  for (const p of points) {
    totals.set(p.model, (totals.get(p.model) ?? 0) + p.count)
  }
  const topModels = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([m]) => m)
  const top = new Set(topModels)

  const byBucket = new Map<number, Record<string, number | string>>()
  for (const p of points) {
    const key = p.model && top.has(p.model) ? p.model : "other"
    let row = byBucket.get(p.ts)
    if (!row) {
      row = { ts: p.ts, time: new Date(p.ts).toLocaleTimeString() }
      byBucket.set(p.ts, row)
    }
    row[key] = ((row[key] as number) ?? 0) + p.count
  }
  const data = [...byBucket.values()].sort(
    (a, b) => (a.ts as number) - (b.ts as number),
  )
  const categories = [...topModels]
  if (data.some((d) => "other" in d)) categories.push("other")
  return { data, categories }
}

const CHART_COLORS: Array<Color> = [
  "blue",
  "cyan",
  "indigo",
  "violet",
  "fuchsia",
  "rose",
  "slate",
]

const STATUS_COLOR = (status: number): Color => {
  if (status >= 500) return "rose"
  if (status >= 400) return "amber"
  if (status >= 200 && status < 300) return "emerald"
  return "slate"
}

export function Overview() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<OverviewResponse>("/overview"),
    refetchInterval: 15_000,
  })

  if (isLoading || !data) {
    return <div className="text-tremor-content">Loading overview…</div>
  }
  if (error) {
    return (
      <div className="rounded-tremor-small border border-rose-300 bg-rose-50 p-4 text-rose-700">
        Failed to load overview: {(error as Error).message}
      </div>
    )
  }

  const { kpis, top_models_24h, top_keys_24h, recent_calls, system } = data
  const series = buildSeriesChart(data.series_requests_24h)

  const donutData = top_models_24h.slice(0, 5).map((m) => ({
    name: m.model || "(unknown)",
    requests: m.requests,
  }))
  if (top_models_24h.length > 5) {
    const otherSum = top_models_24h
      .slice(5)
      .reduce((acc, m) => acc + m.requests, 0)
    if (otherSum > 0) donutData.push({ name: "other", requests: otherSum })
  }

  const barListData = top_keys_24h.map((k) => ({
    name: k.label || k.key_id.slice(-8),
    value: k.prompt_tokens + k.completion_tokens,
  }))

  return (
    <div className="space-y-6">
      {/* System status banner */}
      <Card className="!p-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-tremor-content">
          <span>
            <span className="text-tremor-content-subtle">Auth: </span>
            <strong>{system.auth_mode_label}</strong>
          </span>
          <span>
            <span className="text-tremor-content-subtle">Bind: </span>
            <span className="mono">{system.bind_address}</span>
          </span>
          {system.vscode_version && (
            <span>
              <span className="text-tremor-content-subtle">VS Code: </span>
              <span className="mono">{system.vscode_version}</span>
            </span>
          )}
          {system.copilot_chat_version && (
            <span>
              <span className="text-tremor-content-subtle">Copilot Chat: </span>
              <span className="mono">{system.copilot_chat_version}</span>
            </span>
          )}
        </div>
      </Card>

      {/* KPI cards */}
      <Grid numItemsSm={2} numItemsLg={6} className="gap-4">
        <KpiCard label="Requests 24h" value={fmt(kpis.total_requests_24h)} />
        <KpiCard
          label="Prompt tokens 24h"
          value={fmt(kpis.total_prompt_tokens_24h)}
          accent="cyan"
        />
        <KpiCard
          label="Completion tokens 24h"
          value={fmt(kpis.total_completion_tokens_24h)}
          accent="indigo"
        />
        <KpiCard
          label="Error rate 24h"
          value={fmtPct(kpis.error_rate_24h)}
          delta={kpis.errors_24h}
          deltaLabel="errors"
          accent={kpis.error_rate_24h > 0.01 ? "rose" : "emerald"}
        />
        <KpiCard
          label="p95 latency 24h"
          value={kpis.p95_latency_ms_24h ? `${kpis.p95_latency_ms_24h} ms` : "—"}
          accent="violet"
        />
        <KpiCard
          label="Active keys"
          value={`${kpis.active_keys}/${kpis.total_keys}`}
          delta={kpis.debug_keys}
          deltaLabel="debug on"
          accent={kpis.debug_keys > 0 ? "amber" : "slate"}
        />
      </Grid>

      {/* Activity + donut */}
      <Grid numItemsLg={3} className="gap-4">
        <Card className="lg:col-span-2">
          <Title>Requests last 24h</Title>
          <Text>By model (top 6)</Text>
          {series.data.length === 0 ?
            <EmptyChart />
          : <AreaChart
              className="h-72 mt-4"
              data={series.data}
              index="time"
              categories={series.categories}
              colors={CHART_COLORS}
              stack
              showAnimation={false}
              valueFormatter={(v: number) => NUM_FMT.format(v)}
              yAxisWidth={48}
            />
          }
        </Card>
        <Card>
          <Title>Model mix 24h</Title>
          <Text>Top 5 + other</Text>
          {donutData.length === 0 ?
            <EmptyChart />
          : <DonutChart
              className="h-72 mt-4"
              data={donutData}
              category="requests"
              index="name"
              colors={CHART_COLORS}
              valueFormatter={(v: number) => NUM_FMT.format(v)}
            />
          }
        </Card>
      </Grid>

      {/* Top keys + recent calls */}
      <Grid numItemsLg={3} className="gap-4">
        <Card>
          <Title>Top keys by tokens 24h</Title>
          {barListData.length === 0 ?
            <EmptyChart />
          : <BarList
              className="mt-4"
              data={barListData}
              valueFormatter={(v: number) => NUM_FMT.format(v)}
            />
          }
        </Card>
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between">
            <Title>Recent calls</Title>
            <a
              href="/admin/logs"
              className="text-xs font-medium text-tremor-brand-emphasis hover:underline"
            >
              Open Logs →
            </a>
          </div>
          {recent_calls.length === 0 ?
            <EmptyChart />
          : <List className="mt-4">
              {recent_calls.map((c) => (
                <ListItem key={c.id}>
                  <a
                    href={`/admin/logs?event=${c.id}`}
                    className="flex flex-col flex-1 hover:underline"
                  >
                    <span className="text-xs text-tremor-content-subtle">
                      {fmtRelative(c.ts)}
                    </span>
                    <span className="text-sm text-tremor-content-strong">
                      {c.model}{" "}
                      <span className="text-tremor-content-subtle mono">
                        {c.key_label || c.key_id.slice(-8)}
                      </span>
                    </span>
                  </a>
                  <div className="flex items-center gap-3">
                    <BadgeDelta
                      deltaType={c.status < 400 ? "increase" : "decrease"}
                    >
                      {c.status}
                    </BadgeDelta>
                    <span className="text-xs text-tremor-content">
                      {c.latency_ms} ms
                    </span>
                    <span className="text-xs text-tremor-content">
                      {c.prompt_tokens ?? "?"}/{c.completion_tokens ?? "?"}
                    </span>
                  </div>
                </ListItem>
              ))}
            </List>
          }
        </Card>
      </Grid>
    </div>
  )
}

interface KpiCardProps {
  label: string
  value: string
  delta?: number | null
  deltaLabel?: string
  accent?: Color
}

function KpiCard({ label, value, delta, deltaLabel, accent }: KpiCardProps) {
  return (
    <Card decoration={accent ? "top" : undefined} decorationColor={accent}>
      <Text>{label}</Text>
      <Metric className="mt-1">{value}</Metric>
      {delta !== undefined && delta !== null && (
        <Text className="mt-1 text-xs">
          {delta} {deltaLabel}
        </Text>
      )}
    </Card>
  )
}

function EmptyChart() {
  return (
    <div className="mt-6 flex h-48 items-center justify-center text-sm text-tremor-content-subtle">
      No data in the selected window yet.
    </div>
  )
}

// Keep the lint-ignore happy: STATUS_COLOR is reserved for the day we color
// rows by status. Re-export so tree-shaking doesn't fight us, even though
// it's unused for now.
export { STATUS_COLOR }
