import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"

import { api } from "~/api/client"
import type { MeResponse } from "~/api/types"

interface TopBarProps {
  title: string
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
      window.location.href = "/admin/login"
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
