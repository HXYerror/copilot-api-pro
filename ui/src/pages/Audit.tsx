import { Badge, BarChart, Card, Text, Title } from "@tremor/react"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"

import { api } from "~/api/client"
import type { AuditEvent, AuditResponse } from "~/api/types"

const NUM_FMT = new Intl.NumberFormat("en", { notation: "compact" })

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

function actionColor(action: string) {
  if (action.startsWith("key.revoke")) return "rose" as const
  if (action.startsWith("key.debug")) return "amber" as const
  if (action.startsWith("key.")) return "violet" as const
  if (action.startsWith("config.")) return "slate" as const
  if (action.startsWith("login")) return "emerald" as const
  return "blue" as const
}

const BULLET_HEX: Record<string, string> = {
  rose: "#f43f5e",
  amber: "#f59e0b",
  violet: "#8b5cf6",
  slate: "#64748b",
  emerald: "#10b981",
  blue: "#3b82f6",
}

function todayIso(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = (d.getMonth() + 1).toString().padStart(2, "0")
  const day = d.getDate().toString().padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function Audit() {
  const [date, setDate] = useState(todayIso())
  const [actionFilter, setActionFilter] = useState("")

  const params = useMemo(() => {
    const sp = new URLSearchParams()
    sp.set("date", date)
    if (actionFilter) sp.set("action", actionFilter)
    sp.set("limit", "200")
    return sp.toString()
  }, [date, actionFilter])

  const { data, isLoading, error } = useQuery({
    queryKey: ["audit", params],
    queryFn: () => api<AuditResponse>(`/audit?${params}`),
  })

  if (isLoading || !data) {
    return <div className="text-tremor-content">Loading audit…</div>
  }
  if (error) {
    return (
      <div className="rounded-tremor-small border border-rose-300 bg-rose-50 p-4 text-rose-700">
        Failed to load audit: {(error as Error).message}
      </div>
    )
  }

  const chartCategories = data.available_actions

  return (
    <div className="space-y-4">
      <Card className="!p-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-tremor-content-subtle">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-tremor-small border border-tremor-border bg-tremor-background px-3 py-2 text-sm"
          />
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="rounded-tremor-small border border-tremor-border bg-tremor-background px-3 py-2 text-sm"
          >
            <option value="">All actions</option>
            {data.available_actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <div className="ml-auto text-xs text-tremor-content-subtle">
            {data.total} events
          </div>
        </div>
      </Card>

      <Card>
        <Title>Events by hour</Title>
        <Text>Grouped by action type</Text>
        {chartCategories.length === 0 ?
          <div className="mt-4 flex h-32 items-center justify-center text-sm text-tremor-content-subtle">
            No events on the selected day.
          </div>
        : <BarChart
            className="mt-4 h-64"
            data={data.hourly}
            index="hour"
            categories={chartCategories}
            colors={["violet", "indigo", "rose", "amber", "blue", "emerald", "cyan"]}
            stack
            showAnimation={false}
            valueFormatter={(v: number) => NUM_FMT.format(v)}
          />
        }
      </Card>

      <Card>
        <Title>Timeline</Title>
        <Text>Newest first</Text>
        {data.events.length === 0 ?
          <div className="mt-4 flex h-32 items-center justify-center text-sm text-tremor-content-subtle">
            No events on the selected day.
          </div>
        : <ol className="relative mt-4 space-y-3 border-l border-tremor-border pl-6">
            {data.events.map((ev, i) => (
              <li key={i}>
                <span
                  className="absolute -left-[7px] mt-1.5 inline-block h-3 w-3 rounded-full border-2 border-white"
                  style={{
                    backgroundColor:
                      BULLET_HEX[actionColor(ev.action)] ?? BULLET_HEX.blue,
                  }}
                />
                <EventEntry ev={ev} />
              </li>
            ))}
          </ol>
        }
      </Card>
    </div>
  )
}

function EventEntry({ ev }: { ev: AuditEvent }) {
  const [expanded, setExpanded] = useState(false)
  const hasDiff =
    ev.before !== undefined && ev.after !== undefined && ev.before !== null

  return (
    <div className="rounded-tremor-small border border-tremor-border bg-tremor-background p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge color={actionColor(ev.action)}>{ev.action}</Badge>
        <span className="text-tremor-content-subtle" title={fmtAbsolute(ev.ts)}>
          {fmtRelative(ev.ts)}
        </span>
        <span className="text-tremor-content">
          by{" "}
          <span className="mono">
            {ev.actor_key_id ? ev.actor_key_id.slice(-8) : "system"}
          </span>
        </span>
        {ev.target && (
          <span className="text-tremor-content">
            → <span className="mono">{ev.target.slice(-8)}</span>
          </span>
        )}
        {(ev.before || ev.after) && (
          <button
            className="ml-auto text-xs text-tremor-brand-emphasis hover:underline"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide details" : "Show details"}
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-3 space-y-3 text-xs">
          {hasDiff && (
            <KeyDiff before={ev.before} after={ev.after} />
          )}
          {hasDiff && (
            <details>
              <summary className="cursor-pointer text-tremor-content-subtle hover:text-tremor-content-strong">
                Raw before / after
              </summary>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div className="rounded bg-rose-50 p-2">
                  <div className="mb-1 text-tremor-content-subtle">Before</div>
                  <pre className="mono whitespace-pre-wrap break-words">
                    {JSON.stringify(ev.before, null, 2)}
                  </pre>
                </div>
                <div className="rounded bg-emerald-50 p-2">
                  <div className="mb-1 text-tremor-content-subtle">After</div>
                  <pre className="mono whitespace-pre-wrap break-words">
                    {JSON.stringify(ev.after, null, 2)}
                  </pre>
                </div>
              </div>
            </details>
          )}
          {!hasDiff && ev.after !== undefined && (
            <div className="rounded bg-emerald-50 p-2">
              <div className="mb-1 text-tremor-content-subtle">Payload</div>
              <pre className="mono whitespace-pre-wrap break-words">
                {JSON.stringify(ev.after, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// KeyDiff — renders a per-field added/removed/changed view of two objects.
// Falls back to "no diff" when both sides are equal, "added" when before is
// missing, "removed" when after is missing.
// ---------------------------------------------------------------------------

function KeyDiff({ before, after }: { before: unknown; after: unknown }) {
  if (
    before === null
    || before === undefined
    || typeof before !== "object"
    || after === null
    || after === undefined
    || typeof after !== "object"
  ) {
    // One side is a scalar — render as plain row.
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <DiffSide label="Before" value={before} tone="rose" />
        <DiffSide label="After" value={after} tone="emerald" />
      </div>
    )
  }

  const beforeObj = before as Record<string, unknown>
  const afterObj = after as Record<string, unknown>
  const allKeys = [
    ...new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]),
  ].sort()
  const rows: Array<{
    key: string
    before: unknown
    after: unknown
    state: "added" | "removed" | "changed" | "same"
  }> = []
  for (const k of allKeys) {
    const b = beforeObj[k]
    const a = afterObj[k]
    const inBefore = k in beforeObj
    const inAfter = k in afterObj
    let state: "added" | "removed" | "changed" | "same"
    if (!inBefore) state = "added"
    else if (!inAfter) state = "removed"
    else if (JSON.stringify(b) === JSON.stringify(a)) state = "same"
    else state = "changed"
    rows.push({ key: k, before: b, after: a, state })
  }
  const changed = rows.filter((r) => r.state !== "same")

  return (
    <div className="rounded-tremor-small border border-tremor-border bg-tremor-background p-2">
      <div className="mb-2 text-tremor-content-subtle">
        Field-by-field diff{" "}
        {changed.length === 0 && (
          <span className="text-tremor-content-subtle">(no changes)</span>
        )}
      </div>
      <table className="w-full">
        <thead>
          <tr className="text-left text-[10px] uppercase text-tremor-content-subtle">
            <th className="pb-1 pr-2">Field</th>
            <th className="pb-1 pr-2">Before</th>
            <th className="pb-1">After</th>
          </tr>
        </thead>
        <tbody>
          {changed.length === 0 ?
            <tr>
              <td colSpan={3} className="py-1 text-tremor-content-subtle">
                Both objects identical.
              </td>
            </tr>
          : changed.map((r) => (
              <tr key={r.key} className="border-t border-tremor-border align-top">
                <td className="py-1 pr-2 mono text-tremor-content-strong">
                  {r.key}
                  <span className="ml-1 text-[10px] text-tremor-content-subtle">
                    {r.state}
                  </span>
                </td>
                <td className="py-1 pr-2">
                  {r.state === "added" ?
                    <span className="text-tremor-content-subtle">—</span>
                  : <pre className="rounded bg-rose-50 p-1 mono whitespace-pre-wrap break-words">
                      {fmtVal(r.before)}
                    </pre>
                  }
                </td>
                <td className="py-1">
                  {r.state === "removed" ?
                    <span className="text-tremor-content-subtle">—</span>
                  : <pre className="rounded bg-emerald-50 p-1 mono whitespace-pre-wrap break-words">
                      {fmtVal(r.after)}
                    </pre>
                  }
                </td>
              </tr>
            ))
          }
        </tbody>
      </table>
    </div>
  )
}

function DiffSide({
  label,
  value,
  tone,
}: {
  label: string
  value: unknown
  tone: "rose" | "emerald"
}) {
  const bg = tone === "rose" ? "bg-rose-50" : "bg-emerald-50"
  return (
    <div className={`rounded p-2 ${bg}`}>
      <div className="mb-1 text-tremor-content-subtle">{label}</div>
      <pre className="mono whitespace-pre-wrap break-words">{fmtVal(value)}</pre>
    </div>
  )
}

function fmtVal(v: unknown): string {
  if (v === null) return "null"
  if (v === undefined) return "undefined"
  if (typeof v === "string") return JSON.stringify(v)
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return JSON.stringify(v, null, 2)
}
