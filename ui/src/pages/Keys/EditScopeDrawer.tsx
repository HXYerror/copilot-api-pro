import { Button, Card, TextInput } from "@tremor/react"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"

import { api } from "~/api/client"
import type { KeySummary } from "~/api/types"

interface EditScopeDrawerProps {
  open: boolean
  onClose: () => void
  onSaved: (updated: KeySummary) => void
  initial: KeySummary
}

export function EditScopeDrawer({
  open,
  onClose,
  onSaved,
  initial,
}: EditScopeDrawerProps) {
  const [allowed, setAllowed] = useState(initial.allowed_models.join(", "))
  const [rate, setRate] = useState(
    initial.rate_limit_override === null
      ? ""
      : String(initial.rate_limit_override),
  )

  const mutation = useMutation({
    mutationFn: async () => {
      const allowed_models = allowed
        .split(/[,\s]+/)
        .map((m) => m.trim())
        .filter((m) => m.length > 0)
      const body: Record<string, unknown> = {
        allowed_models,
        rate_limit_override:
          rate.trim() === "" ? null : Number.parseInt(rate, 10),
      }
      return api<{ ok: true; changed: boolean; key: KeySummary | null }>(
        `/keys/${initial.id}/scope`,
        { method: "POST", body },
      )
    },
    onSuccess: (data) => {
      if (data.key) onSaved(data.key)
    },
  })

  if (!open) return null

  const error =
    mutation.error instanceof Error ? mutation.error.message : null

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30"
      onClick={onClose}
    >
      <div
        className="h-full w-full max-w-md overflow-y-auto bg-tremor-background p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-tremor-content-strong">
            Edit scope
          </h2>
          <button
            onClick={onClose}
            className="text-tremor-content-subtle hover:text-tremor-content-strong"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
          className="mt-4 space-y-4"
        >
          <Card>
            <p className="text-xs text-tremor-content-subtle">
              Updating scope does not invalidate the key — clients keep working
              with the new permissions on the next request.
            </p>
          </Card>

          <div>
            <label className="block text-xs font-medium text-tremor-content-subtle">
              Allowed models
            </label>
            <TextInput
              placeholder="* or gpt-4o,gpt-4o-mini"
              value={allowed}
              onValueChange={setAllowed}
              className="mt-1"
            />
            <p className="mt-1 text-xs text-tremor-content-subtle">
              Comma- or space-separated. Use <code>*</code> for unrestricted.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-tremor-content-subtle">
              Rate-limit override (req/min)
            </label>
            <TextInput
              placeholder="leave empty to inherit global"
              value={rate}
              onValueChange={setRate}
              className="mt-1"
            />
          </div>

          {error && (
            <div className="rounded-tremor-small border border-rose-300 bg-rose-50 p-3 text-xs text-rose-700">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending}
              loading={mutation.isPending}
            >
              Save
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
