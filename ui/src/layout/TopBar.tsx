import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"

import type { MeResponse } from "~/api/types"

import { api } from "~/api/client"

interface TopBarProps {
  title: string
}

interface BuildInfo {
  version: string
  branch?: string
  commit?: string
  commit_time?: string
  started_at: number
}

function shortRel(ts: number): string {
  const age = Date.now() - ts
  if (age < 60_000) return `${Math.floor(age / 1000)}s`
  if (age < 3600_000) return `${Math.floor(age / 60_000)}m`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`
  return `${Math.floor(age / 86_400_000)}d`
}

function BuildBadge({ build }: { build: BuildInfo }) {
  const commitTs =
    build.commit_time ? new Date(build.commit_time).getTime() : null
  const tooltip = [
    `version ${build.version}`,
    build.branch && `branch ${build.branch}`,
    build.commit && `commit ${build.commit}`,
    build.commit_time
      && `committed ${new Date(build.commit_time).toLocaleString()}`,
    `started ${new Date(build.started_at).toLocaleString()}`,
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <span className="mono text-xs text-tremor-content-subtle" title={tooltip}>
      v{build.version}
      {build.branch && (
        <span className="ml-1 rounded bg-tremor-background-subtle px-1.5 py-0.5">
          {build.branch}
          {build.commit && (
            <span className="ml-1 text-tremor-content-subtle">
              @{build.commit}
            </span>
          )}
        </span>
      )}
      {commitTs !== null && (
        <span className="ml-1 text-tremor-content-subtle">
          ·commit {shortRel(commitTs)} ago
        </span>
      )}
      <span className="ml-1 text-tremor-content-subtle">
        ·up {shortRel(build.started_at)}
      </span>
    </span>
  )
}

export function TopBar({ title }: TopBarProps) {
  const qc = useQueryClient()

  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => api<MeResponse>("/me"),
    staleTime: 60_000,
  })

  const logout = useMutation({
    mutationFn: () => api<{ ok: true }>("/logout", { method: "POST" }),
    onSuccess: () => {
      qc.clear()
      globalThis.location.href = "/admin/login"
    },
  })

  return (
    <header className="flex h-14 items-center justify-between border-b border-tremor-border bg-white px-6">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-tremor-content-strong">
          {title}
        </h1>
      </div>
      <div className="flex items-center gap-3 text-sm text-tremor-content">
        {me?.build && <BuildBadge build={me.build} />}
        {me && (
          <>
            <span className="inline-flex items-center rounded-full bg-tremor-background-subtle px-2.5 py-0.5 text-xs font-medium text-tremor-content-emphasis">
              {me.auth_mode_label}
            </span>
            <span className="mono text-xs">{me.bind_address}</span>
            <span className="hidden text-tremor-content-subtle sm:inline">
              {me.label ?? me.key_id.slice(-8)}
            </span>
          </>
        )}
        <button
          type="button"
          onClick={() => logout.mutate()}
          className="rounded-tremor-small border border-tremor-border bg-white px-3 py-1.5 text-xs font-medium text-tremor-content-emphasis hover:bg-tremor-background-subtle"
        >
          Logout
        </button>
      </div>
    </header>
  )
}
