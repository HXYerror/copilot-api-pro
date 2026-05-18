import { Badge, Button, Card, Text, TextInput } from "@tremor/react"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"

import { api } from "~/api/client"
import type { KeysListResponse, KeySummary } from "~/api/types"

import { fmtAbsolute, fmtRelative } from "./format"
import { NewKeyDrawer } from "./NewDrawer"

type TierFilter = "all" | "admin" | "client"
type StatusFilter = "all" | "active" | "revoked" | "debug"

function shortId(id: string): string {
  return id.slice(-8)
}

function matches(
  k: KeySummary,
  q: string,
  tier: TierFilter,
  status: StatusFilter,
): boolean {
  if (tier !== "all" && k.tier !== tier) return false
  if (status === "active" && k.revoked_at !== null) return false
  if (status === "revoked" && k.revoked_at === null) return false
  if (status === "debug" && !k.debug_active) return false
  if (!q) return true
  const needle = q.toLowerCase()
  return (
    (k.label?.toLowerCase().includes(needle) ?? false)
    || k.id.toLowerCase().includes(needle)
  )
}

export function KeysList() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [tier, setTier] = useState<TierFilter>("all")
  const [status, setStatus] = useState<StatusFilter>("all")
  const [drawerOpen, setDrawerOpen] = useState(false)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["keys", page],
    queryFn: () =>
      api<KeysListResponse>(`/keys?page=${page}&page_size=50`),
    refetchInterval: 30_000,
  })

  const filtered = useMemo(() => {
    if (!data) return [] as Array<KeySummary>
    return data.items.filter((k) => matches(k, search, tier, status))
  }, [data, search, tier, status])

  if (isLoading || !data) {
    return <div className="text-tremor-content">Loading keys…</div>
  }
  if (error) {
    return (
      <div className="rounded-tremor-small border border-rose-300 bg-rose-50 p-4 text-rose-700">
        Failed to load keys: {(error as Error).message}
      </div>
    )
  }

  const summary = data.summary
  const pagination = data.pagination

  return (
    <div className="space-y-4">
      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiBox label="Total keys" value={summary.total_keys.toString()} />
        <KpiBox
          label="Active on page"
          value={summary.active_on_page.toString()}
        />
        <KpiBox
          label="Debug mode"
          value={summary.debug_active.toString()}
          tone={summary.debug_active > 0 ? "amber" : "slate"}
        />
      </div>

      {/* Toolbar */}
      <Card className="!p-3">
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            placeholder="Search by label or id…"
            value={search}
            onValueChange={setSearch}
            className="max-w-xs"
          />
          <SegmentedSelect
            value={tier}
            onChange={setTier}
            options={[
              { label: "All tiers", value: "all" },
              { label: "Admin", value: "admin" },
              { label: "Client", value: "client" },
            ]}
          />
          <SegmentedSelect
            value={status}
            onChange={setStatus}
            options={[
              { label: "Any status", value: "all" },
              { label: "Active", value: "active" },
              { label: "Revoked", value: "revoked" },
              { label: "Debug", value: "debug" },
            ]}
          />
          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" onClick={() => refetch()}>
              Refresh
            </Button>
            <Button onClick={() => setDrawerOpen(true)}>+ New key</Button>
          </div>
        </div>
      </Card>

      {/* Table */}
      <Card className="!p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-tremor-border bg-tremor-background-muted text-left text-xs uppercase text-tremor-content-subtle">
                <th className="px-4 py-2">Label</th>
                <th className="px-4 py-2">ID</th>
                <th className="px-4 py-2">Tier</th>
                <th className="px-4 py-2">Models</th>
                <th className="px-4 py-2">Rate</th>
                <th className="px-4 py-2">Debug</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ?
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-8 text-center text-tremor-content-subtle"
                  >
                    No keys match the current filters.
                  </td>
                </tr>
              : filtered.map((k) => (
                  <tr
                    key={k.id}
                    className="border-b border-tremor-border last:border-b-0 hover:bg-tremor-background-muted/60"
                  >
                    <td className="px-4 py-2 font-medium text-tremor-content-strong">
                      <Link
                        to={`/keys/${k.id}`}
                        className="text-tremor-brand-emphasis hover:underline"
                      >
                        {k.label || "(unlabeled)"}
                      </Link>
                    </td>
                    <td className="px-4 py-2 mono text-xs text-tremor-content">
                      {shortId(k.id)}
                    </td>
                    <td className="px-4 py-2">
                      <Badge color={k.tier === "admin" ? "violet" : "blue"}>
                        {k.tier}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-xs text-tremor-content">
                      {k.allowed_models.includes("*")
                        ? "all"
                        : k.allowed_models.slice(0, 3).join(", ")
                          + (k.allowed_models.length > 3
                            ? ` +${k.allowed_models.length - 3}`
                            : "")}
                    </td>
                    <td className="px-4 py-2 text-xs text-tremor-content">
                      {k.rate_limit_override ?? "inherit"}
                    </td>
                    <td className="px-4 py-2">
                      {k.debug_active ?
                        <Badge color="amber">on</Badge>
                      : <span className="text-tremor-content-subtle text-xs">
                          off
                        </span>
                      }
                    </td>
                    <td className="px-4 py-2 text-xs text-tremor-content">
                      <span title={fmtAbsolute(k.created_at)}>
                        {fmtRelative(k.created_at)}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      {k.revoked_at ?
                        <Badge color="rose">revoked</Badge>
                      : <Badge color="emerald">active</Badge>
                      }
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        to={`/keys/${k.id}`}
                        className="text-xs font-medium text-tremor-brand-emphasis hover:underline"
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      </Card>

      {/* Pagination */}
      {pagination.total_pages > 1 && (
        <div className="flex items-center justify-between text-sm text-tremor-content">
          <Text>
            Page {pagination.page} of {pagination.total_pages} ·{" "}
            {pagination.total} total
          </Text>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <Button
              variant="secondary"
              disabled={page >= pagination.total_pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <NewKeyDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onCreated={() => {
          setDrawerOpen(false)
          void refetch()
        }}
      />
    </div>
  )
}

interface KpiBoxProps {
  label: string
  value: string
  tone?: "slate" | "amber" | "rose" | "emerald"
}

function KpiBox({ label, value, tone = "slate" }: KpiBoxProps) {
  return (
    <Card decoration="top" decorationColor={tone}>
      <Text>{label}</Text>
      <p className="mt-1 text-2xl font-semibold text-tremor-content-strong">
        {value}
      </p>
    </Card>
  )
}

interface SegmentedOption<T extends string> {
  label: string
  value: T
}

interface SegmentedSelectProps<T extends string> {
  value: T
  onChange: (v: T) => void
  options: Array<SegmentedOption<T>>
}

function SegmentedSelect<T extends string>({
  value,
  onChange,
  options,
}: SegmentedSelectProps<T>) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="rounded-tremor-small border border-tremor-border bg-tremor-background px-3 py-2 text-sm text-tremor-content-strong"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
