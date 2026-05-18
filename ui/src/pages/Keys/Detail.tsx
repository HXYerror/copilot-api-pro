import { Badge, Button, Card, Grid, Text, Title } from "@tremor/react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { api } from "~/api/client"
import type {
  KeyDetailResponse,
  KeySummary,
  KeyUsageWindow,
} from "~/api/types"

import { EditScopeDrawer } from "./EditScopeDrawer"
import { fmtAbsolute, fmtNum, fmtPct, fmtRelative } from "./format"

const STATUS_BADGE = (status: number) => {
  if (status >= 500) return "rose" as const
  if (status >= 400) return "amber" as const
  if (status >= 200 && status < 300) return "emerald" as const
  return "slate" as const
}

export function KeysDetail() {
  const { id = "" } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [editOpen, setEditOpen] = useState(false)
  const [optimisticKey, setOptimisticKey] = useState<KeySummary | null>(null)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["key", id],
    queryFn: () => api<KeyDetailResponse>(`/keys/${id}`),
    enabled: id.length > 0,
    refetchInterval: 30_000,
  })

  const revokeMutation = useMutation({
    mutationFn: () =>
      api<{ ok: true; revoked: boolean; key: KeySummary | null }>(
        `/keys/${id}/revoke`,
        { method: "POST", body: {} },
      ),
    onSuccess: (resp) => {
      if (resp.key) setOptimisticKey(resp.key)
      void refetch()
    },
  })

  const debugMutation = useMutation({
    mutationFn: (mode: "enable" | "disable" | "renew") => {
      const body =
        mode === "enable" ? { enabled: true, confirm: true }
        : mode === "renew" ? { action: "renew" }
        : { enabled: false }
      return api<{ ok: true; key: KeySummary | null }>(`/keys/${id}/debug`, {
        method: "POST",
        body,
      })
    },
    onSuccess: (resp) => {
      if (resp.key) setOptimisticKey(resp.key)
      void refetch()
    },
  })

  if (isLoading || !data) {
    return <div className="text-tremor-content">Loading key…</div>
  }
  if (error) {
    return (
      <div className="rounded-tremor-small border border-rose-300 bg-rose-50 p-4 text-rose-700">
        Failed to load key: {(error as Error).message}
      </div>
    )
  }

  const key = optimisticKey ?? data.key
  const revoked = key.revoked_at !== null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Link
              to="/keys"
              className="text-xs text-tremor-content hover:text-tremor-content-strong"
            >
              ← All keys
            </Link>
          </div>
          <h1 className="mt-1 text-2xl font-semibold text-tremor-content-strong">
            {key.label || "(unlabeled)"}
          </h1>
          <p className="mt-1 text-xs text-tremor-content mono">{key.id}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge color={key.tier === "admin" ? "violet" : "blue"}>
            {key.tier}
          </Badge>
          {revoked ?
            <Badge color="rose">revoked</Badge>
          : <Badge color="emerald">active</Badge>
          }
          {key.debug_active && <Badge color="amber">debug</Badge>}
        </div>
      </div>

      {/* Usage windows */}
      <Grid numItemsLg={3} className="gap-4">
        <UsageCard title="Last 24h" usage={data.usage["24h"]} />
        <UsageCard title="Last 7 days" usage={data.usage["7d"]} />
        <UsageCard title="Last 30 days" usage={data.usage["30d"]} />
      </Grid>

      {/* Metadata + actions */}
      <Grid numItemsLg={3} className="gap-4">
        <Card className="lg:col-span-2">
          <Title>Metadata</Title>
          <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-tremor-content-subtle">Created</dt>
            <dd className="text-tremor-content-strong">
              {fmtAbsolute(key.created_at)}{" "}
              <span className="text-tremor-content-subtle">
                ({fmtRelative(key.created_at)})
              </span>
            </dd>
            <dt className="text-tremor-content-subtle">Revoked</dt>
            <dd className="text-tremor-content-strong">
              {key.revoked_at ?
                <>
                  {fmtAbsolute(key.revoked_at)}{" "}
                  <span className="text-tremor-content-subtle">
                    ({fmtRelative(key.revoked_at)})
                  </span>
                </>
              : "—"
              }
            </dd>
            <dt className="text-tremor-content-subtle">Allowed models</dt>
            <dd className="text-tremor-content-strong mono">
              {key.allowed_models.join(", ")}
            </dd>
            <dt className="text-tremor-content-subtle">Rate limit</dt>
            <dd className="text-tremor-content-strong">
              {key.rate_limit_override ?? "inherit global"}
            </dd>
            <dt className="text-tremor-content-subtle">Debug expires</dt>
            <dd className="text-tremor-content-strong">
              {key.debug_active && key.debug_expires_at
                ? `${fmtAbsolute(key.debug_expires_at)} (${fmtRelative(key.debug_expires_at)})`
                : "—"}
            </dd>
          </dl>

          {!revoked && (
            <div className="mt-4 flex flex-wrap gap-2 border-t border-tremor-border pt-3">
              <Button variant="secondary" onClick={() => setEditOpen(true)}>
                Edit scope
              </Button>
              {key.debug_active ?
                <>
                  <Button
                    variant="secondary"
                    onClick={() => debugMutation.mutate("renew")}
                    loading={debugMutation.isPending}
                  >
                    Renew debug TTL
                  </Button>
                  <Button
                    variant="secondary"
                    color="rose"
                    onClick={() => debugMutation.mutate("disable")}
                    loading={debugMutation.isPending}
                  >
                    Disable debug
                  </Button>
                </>
              : <Button
                  variant="secondary"
                  color="amber"
                  onClick={() => {
                    const ok = window.confirm(
                      "Debug mode captures full upstream request/response "
                        + "bodies to disk for 24h. Use only for live debugging. "
                        + "Continue?",
                    )
                    if (ok) debugMutation.mutate("enable")
                  }}
                  loading={debugMutation.isPending}
                >
                  Enable debug
                </Button>
              }
            </div>
          )}
        </Card>

        <Card decoration="top" decorationColor="rose">
          <Title>Danger zone</Title>
          <Text className="mt-2">
            Revoking is permanent — the key stops working immediately and
            cannot be re-enabled. Existing audit + telemetry rows are kept.
          </Text>
          {revoked ?
            <Text className="mt-3 text-tremor-content-subtle">
              This key is already revoked.
            </Text>
          : <Button
              className="mt-4"
              color="rose"
              onClick={() => {
                const ok = window.confirm(
                  `Revoke key ${key.label || key.id}? This cannot be undone.`,
                )
                if (ok) revokeMutation.mutate()
              }}
              loading={revokeMutation.isPending}
            >
              Revoke key
            </Button>
          }
        </Card>
      </Grid>

      {/* Recent calls */}
      <Card className="!p-0 overflow-hidden">
        <div className="border-b border-tremor-border p-4">
          <Title>Recent calls</Title>
          <Text>Last 20 events for this key</Text>
        </div>
        {data.recent_calls.length === 0 ?
          <div className="p-6 text-sm text-tremor-content-subtle">
            No calls yet.
          </div>
        : <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-tremor-border bg-tremor-background-muted text-left text-xs uppercase text-tremor-content-subtle">
                  <th className="px-4 py-2">Time</th>
                  <th className="px-4 py-2">Model</th>
                  <th className="px-4 py-2">Upstream</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Latency</th>
                  <th className="px-4 py-2">p/c tokens</th>
                  <th className="px-4 py-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {data.recent_calls.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => navigate(`/logs?event=${c.id}`)}
                    className="cursor-pointer border-b border-tremor-border last:border-b-0 hover:bg-tremor-background-muted/60"
                  >
                    <td className="px-4 py-2 text-xs text-tremor-content">
                      <span title={fmtAbsolute(c.ts)}>{fmtRelative(c.ts)}</span>
                    </td>
                    <td className="px-4 py-2 text-tremor-content-strong">
                      {c.model}
                    </td>
                    <td className="px-4 py-2 text-tremor-content mono text-xs">
                      {c.upstream_model}
                    </td>
                    <td className="px-4 py-2">
                      <Badge color={STATUS_BADGE(c.status)}>{c.status}</Badge>
                    </td>
                    <td className="px-4 py-2 text-xs text-tremor-content">
                      {c.latency_ms} ms
                    </td>
                    <td className="px-4 py-2 text-xs text-tremor-content">
                      {c.prompt_tokens ?? "?"}/{c.completion_tokens ?? "?"}
                    </td>
                    <td className="px-4 py-2 text-xs text-rose-700">
                      {c.error
                        ? c.error.slice(0, 60) + (c.error.length > 60 ? "…" : "")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        }
      </Card>

      <EditScopeDrawer
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSaved={(updated) => {
          setOptimisticKey(updated)
          setEditOpen(false)
          void refetch()
        }}
        initial={key}
      />

      {/* spacer for safety */}
      <div className="h-2" />
      {/* link out to legacy for anyone needing the SSR view */}
      <p className="text-xs text-tremor-content-subtle">
        Need the old view?{" "}
        <a
          href={`/admin/legacy/keys/${key.id}`}
          className="text-tremor-brand-emphasis hover:underline"
        >
          Open legacy page
        </a>
        {" · "}
        <button
          className="text-tremor-brand-emphasis hover:underline"
          onClick={() => navigate("/keys")}
        >
          Back to list
        </button>
      </p>
    </div>
  )
}

interface UsageCardProps {
  title: string
  usage: KeyUsageWindow
}

function UsageCard({ title, usage }: UsageCardProps) {
  return (
    <Card>
      <Text>{title}</Text>
      <p className="mt-1 text-2xl font-semibold text-tremor-content-strong">
        {fmtNum(usage.total_requests)} req
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
        <dt className="text-tremor-content-subtle">Tokens p/c</dt>
        <dd className="text-tremor-content-strong">
          {fmtNum(usage.total_prompt_tokens)} /{" "}
          {fmtNum(usage.total_completion_tokens)}
        </dd>
        <dt className="text-tremor-content-subtle">Errors</dt>
        <dd className="text-tremor-content-strong">
          {usage.errors} ({fmtPct(usage.error_rate)})
        </dd>
        <dt className="text-tremor-content-subtle">p95 latency</dt>
        <dd className="text-tremor-content-strong">
          {usage.p95_latency_ms ? `${usage.p95_latency_ms} ms` : "—"}
        </dd>
        <dt className="text-tremor-content-subtle">Last used</dt>
        <dd className="text-tremor-content-strong">
          {fmtRelative(usage.last_used_ts ?? null)}
        </dd>
      </dl>
    </Card>
  )
}
