import { useQuery } from "@tanstack/react-query"
import {
  AreaChart,
  Badge,
  BarChart,
  BarList,
  Button,
  Card,
  Color,
  DonutChart,
  Grid,
  Tab,
  TabGroup,
  TabList,
  TabPanel,
  TabPanels,
  Text,
  Title,
} from "@tremor/react"
import { useMemo, useState } from "react"

import type {
  UsageRange,
  UsageResponse,
  UsageRpmPoint,
  UsageTopKey,
} from "~/api/types"

import { api } from "~/api/client"

const NUM_FMT = new Intl.NumberFormat("en", { notation: "compact" })

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—"
  return NUM_FMT.format(n)
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`
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

const RANGES: Array<{ label: string; value: UsageRange }> = [
  { label: "1h", value: "1h" },
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
]

/**
 * Format a bucket timestamp for the X-axis label, picking the granularity
 * that makes sense for the bucket size:
 *   - sub-hour buckets  → "HH:MM" (no date — same day)
 *   - sub-day buckets   → "MMM DD HH"
 *   - day-and-up buckets → "MMM DD"
 */
function formatBucketTime(ts: number, bucketMs: number): string {
  const d = new Date(ts)
  if (bucketMs < 3_600_000) {
    return d.toLocaleTimeString("en", {
      hour: "2-digit",
      minute: "2-digit",
    })
  }
  if (bucketMs < 86_400_000) {
    return d.toLocaleString("en", {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
    })
  }
  return d.toLocaleDateString("en", { month: "short", day: "2-digit" })
}

function regroupByBucket(
  points: Array<UsageRpmPoint>,
  bucketMs: number,
): {
  data: Array<Record<string, number | string>>
  categories: Array<string>
} {
  if (points.length === 0) return { data: [], categories: [] }
  const totals = new Map<string, number>()
  for (const p of points) {
    totals.set(p.model, (totals.get(p.model) ?? 0) + p.count)
  }
  const top = new Set(
    [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([m]) => m),
  )
  const byBucket = new Map<number, Record<string, number | string>>()
  for (const p of points) {
    const key = p.model && top.has(p.model) ? p.model : "other"
    let row = byBucket.get(p.ts)
    if (!row) {
      row = { ts: p.ts, time: formatBucketTime(p.ts, bucketMs) }
      byBucket.set(p.ts, row)
    }
    row[key] = ((row[key] as number) ?? 0) + p.count
  }
  const data = [...byBucket.values()].sort(
    (a, b) => (a.ts as number) - (b.ts as number),
  )
  const categories = [...top]
  if (data.some((d) => "other" in d)) categories.push("other")
  return { data, categories }
}

export function Usage() {
  const [range, setRange] = useState<UsageRange>("24h")
  const [keyFilter, setKeyFilter] = useState<string>("")
  const [modelFilter, setModelFilter] = useState<string>("")

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set("range", range)
    if (keyFilter) params.set("key_id", keyFilter)
    if (modelFilter) params.set("model", modelFilter)
    return params.toString()
  }, [range, keyFilter, modelFilter])

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["usage", queryString],
    queryFn: () => api<UsageResponse>(`/usage?${queryString}`),
    refetchInterval: 30_000,
  })

  if (isLoading || !data) {
    return <div className="text-tremor-content">Loading usage…</div>
  }
  if (error) {
    return (
      <div className="rounded-tremor-small border border-rose-300 bg-rose-50 p-4 text-rose-700">
        Failed to load usage: {error.message}
      </div>
    )
  }

  // Server-chosen bucket size (defaults preserve the old minute granularity
  // for callers that haven't been redeployed). The chart titles, X-axis time
  // format, and Tokens/Latency bucket labels all read from this so 1h/24h/7d
  // /30d render with appropriate granularity instead of always saying "per
  // minute" / "per hour" (#6).
  const bucketMs = data.activity.bucket_ms ?? 60_000
  const bucketLabel = data.activity.bucket_label ?? "per minute"

  const activity = regroupByBucket(data.activity.rpm, bucketMs)
  // Force the Tremor charts to remount when the filter changes. Tremor's
  // <AreaChart> caches SVG paths via Recharts and doesn't always re-render
  // when the `categories` array shape changes (e.g. 1h → 24h often adds
  // models to the stack). A `key` derived from the active filter is the
  // cheapest way to guarantee a fresh chart on every range switch.
  const chartKey = queryString
  const tokensData = data.activity.tokens.map((t) => ({
    time: formatBucketTime(t.ts, bucketMs),
    Prompt: t.prompt_tokens,
    Completion: t.completion_tokens,
  }))
  const latencyData = data.activity.latency.map((p) => ({
    time: formatBucketTime(p.ts, bucketMs),
    p50: p.p50,
    p95: p.p95,
    p99: p.p99,
  }))

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <Card className="!p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-tremor-small border border-tremor-border p-1">
            {RANGES.map((r) => (
              <button
                key={r.value}
                onClick={() => setRange(r.value)}
                className={
                  "rounded px-3 py-1 text-xs font-medium "
                  + (range === r.value ?
                    "bg-tremor-brand text-white"
                  : "text-tremor-content hover:bg-tremor-background-muted")
                }
              >
                {r.label}
              </button>
            ))}
          </div>
          <select
            value={keyFilter}
            onChange={(e) => setKeyFilter(e.target.value)}
            className="rounded-tremor-small border border-tremor-border bg-tremor-background px-3 py-2 text-sm"
          >
            <option value="">All keys</option>
            {data.all_keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label || k.id.slice(-8)}
              </option>
            ))}
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
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={() => refetch()}>
              Refresh
            </Button>
            <a
              href={`/admin/api/usage/export.csv?${queryString}`}
              className="inline-flex items-center rounded-tremor-default bg-tremor-brand px-3 py-2 text-xs font-medium text-white hover:bg-tremor-brand-emphasis"
              download
            >
              Export CSV
            </a>
          </div>
        </div>
      </Card>

      {/* KPI row */}
      <Grid numItemsSm={2} numItemsLg={4} className="gap-4">
        <KpiBox
          label={`Requests (${range})`}
          value={fmt(data.stats.total_requests)}
          tone="blue"
        />
        <KpiBox
          label={`Tokens (${range})`}
          value={fmt(data.stats.total_tokens)}
          tone="cyan"
        />
        <KpiBox
          label="Error rate"
          value={fmtPct(data.stats.error_rate)}
          tone={data.stats.error_rate > 0.01 ? "rose" : "emerald"}
          delta={`${data.stats.errors} errors`}
        />
        <KpiBox
          label="p95 latency"
          value={
            data.stats.p95_latency_ms ? `${data.stats.p95_latency_ms} ms` : "—"
          }
          tone="violet"
        />
      </Grid>

      {/* Tabs */}
      <Card className="!p-0">
        <TabGroup>
          <TabList className="border-b border-tremor-border">
            <Tab>Activity</Tab>
            <Tab>Models</Tab>
            <Tab>Top keys</Tab>
            <Tab>Errors</Tab>
          </TabList>
          <TabPanels>
            <TabPanel>
              <div className="space-y-6 p-4">
                <div>
                  <Title>Requests {bucketLabel}</Title>
                  <Text>Stacked by model (top 6 + other)</Text>
                  {activity.data.length === 0 ?
                    <Empty />
                  : <AreaChart
                      key={`rpm-${chartKey}`}
                      className="mt-4 h-72"
                      data={activity.data}
                      index="time"
                      categories={activity.categories}
                      colors={CHART_COLORS}
                      stack
                      showAnimation={false}
                      valueFormatter={(v: number) => NUM_FMT.format(v)}
                      yAxisWidth={48}
                    />
                  }
                </div>
                <div>
                  <Title>Tokens {bucketLabel}</Title>
                  <Text>Prompt vs completion</Text>
                  {tokensData.length === 0 ?
                    <Empty />
                  : <BarChart
                      key={`tokens-${chartKey}`}
                      className="mt-4 h-64"
                      data={tokensData}
                      index="time"
                      categories={["Prompt", "Completion"]}
                      colors={["cyan", "indigo"]}
                      stack
                      showAnimation={false}
                      valueFormatter={(v: number) => NUM_FMT.format(v)}
                      yAxisWidth={64}
                    />
                  }
                </div>
                <div>
                  <Title>Latency {bucketLabel}</Title>
                  <Text>p50 / p95 / p99</Text>
                  {latencyData.length === 0 ?
                    <Empty />
                  : <AreaChart
                      key={`latency-${chartKey}`}
                      className="mt-4 h-64"
                      data={latencyData}
                      index="time"
                      categories={["p50", "p95", "p99"]}
                      colors={["emerald", "violet", "rose"]}
                      showAnimation={false}
                      valueFormatter={(v: number) => `${v} ms`}
                      yAxisWidth={64}
                    />
                  }
                </div>
              </div>
            </TabPanel>

            <TabPanel>
              <div className="p-4">
                <Title>Top models</Title>
                <Text>Ranked by request count</Text>
                {data.top_models.length === 0 ?
                  <Empty />
                : <>
                    <BarList
                      className="mt-4"
                      data={data.top_models.map((m) => ({
                        name: m.model || "(unknown)",
                        value: m.count,
                      }))}
                      valueFormatter={(v: number) => NUM_FMT.format(v)}
                    />
                    <table className="mt-6 w-full text-sm">
                      <thead>
                        <tr className="border-b border-tremor-border text-left text-xs uppercase text-tremor-content-subtle">
                          <th className="px-2 py-2">Model</th>
                          <th className="px-2 py-2 text-right">Requests</th>
                          <th className="px-2 py-2 text-right">Share</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const total =
                            data.top_models.reduce((a, m) => a + m.count, 0)
                            || 1
                          return data.top_models.map((m) => (
                            <tr
                              key={m.model}
                              className="border-b border-tremor-border last:border-b-0"
                            >
                              <td className="px-2 py-2 text-tremor-content-strong">
                                {m.model || "(unknown)"}
                              </td>
                              <td className="px-2 py-2 text-right text-tremor-content">
                                {fmt(m.count)}
                              </td>
                              <td className="px-2 py-2 text-right text-tremor-content">
                                {fmtPct(m.count / total)}
                              </td>
                            </tr>
                          ))
                        })()}
                      </tbody>
                    </table>
                  </>
                }
              </div>
            </TabPanel>

            <TabPanel>
              <div className="p-4">
                <Title>Top keys</Title>
                <Text>Ranked by token consumption</Text>
                {data.top_keys.length === 0 ?
                  <Empty />
                : <>
                    <BarList
                      className="mt-4"
                      data={data.top_keys.map((k) => ({
                        name: k.label || k.key_id.slice(-8),
                        value: k.tokens,
                      }))}
                      valueFormatter={(v: number) => NUM_FMT.format(v)}
                    />
                    <table className="mt-6 w-full text-sm">
                      <thead>
                        <tr className="border-b border-tremor-border text-left text-xs uppercase text-tremor-content-subtle">
                          <th className="px-2 py-2">Key</th>
                          <th className="px-2 py-2 text-right">Requests</th>
                          <th className="px-2 py-2 text-right">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.top_keys.map((k: UsageTopKey) => (
                          <tr
                            key={k.key_id}
                            className="border-b border-tremor-border last:border-b-0"
                          >
                            <td className="px-2 py-2 text-tremor-content-strong">
                              <a
                                href={`/admin/keys/${k.key_id}`}
                                className="text-tremor-brand-emphasis hover:underline"
                              >
                                {k.label || k.key_id.slice(-8)}
                              </a>
                            </td>
                            <td className="px-2 py-2 text-right text-tremor-content">
                              {fmt(k.requests)}
                            </td>
                            <td className="px-2 py-2 text-right text-tremor-content">
                              {fmt(k.tokens)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                }
              </div>
            </TabPanel>

            <TabPanel>
              <div className="p-4">
                <Title>Errors</Title>
                <Text>HTTP status breakdown</Text>
                {data.errors_by_status.length === 0 ?
                  <Empty />
                : <>
                    <DonutChart
                      key={`errors-${chartKey}`}
                      className="mt-4 h-64"
                      data={data.errors_by_status.map((e) => ({
                        name: `HTTP ${e.status}`,
                        value: e.count,
                      }))}
                      category="value"
                      index="name"
                      colors={["rose", "amber", "violet", "indigo", "slate"]}
                      valueFormatter={(v: number) => NUM_FMT.format(v)}
                    />
                    <table className="mt-6 w-full text-sm">
                      <thead>
                        <tr className="border-b border-tremor-border text-left text-xs uppercase text-tremor-content-subtle">
                          <th className="px-2 py-2">Status</th>
                          <th className="px-2 py-2 text-right">Count</th>
                          <th className="px-2 py-2">Sample error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.errors_by_status.map((e) => (
                          <tr
                            key={e.status}
                            className="border-b border-tremor-border last:border-b-0"
                          >
                            <td className="px-2 py-2">
                              <Badge
                                color={
                                  e.status >= 500 ? "rose"
                                  : e.status >= 400 ?
                                    "amber"
                                  : "slate"
                                }
                              >
                                {e.status}
                              </Badge>
                            </td>
                            <td className="px-2 py-2 text-right text-tremor-content">
                              {fmt(e.count)}
                            </td>
                            <td className="px-2 py-2 text-tremor-content text-xs">
                              {e.sample_error ?
                                e.sample_error.slice(0, 120)
                                + (e.sample_error.length > 120 ? "…" : "")
                              : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                }
              </div>
            </TabPanel>
          </TabPanels>
        </TabGroup>
      </Card>
    </div>
  )
}

interface KpiBoxProps {
  label: string
  value: string
  tone?: Color
  delta?: string
}

function KpiBox({ label, value, tone = "slate", delta }: KpiBoxProps) {
  return (
    <Card decoration="top" decorationColor={tone}>
      <Text>{label}</Text>
      <p className="mt-1 text-2xl font-semibold text-tremor-content-strong">
        {value}
      </p>
      {delta && <Text className="mt-1 text-xs">{delta}</Text>}
    </Card>
  )
}

function Empty() {
  return (
    <div className="mt-4 flex h-32 items-center justify-center text-sm text-tremor-content-subtle">
      No data in the selected window yet.
    </div>
  )
}
