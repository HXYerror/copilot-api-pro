import { Button, Card, TextInput } from "@tremor/react"
import { useMutation } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import { api } from "~/api/client"
import type { KeyCreateResponse } from "~/api/types"

interface NewKeyDrawerProps {
  open: boolean
  onClose: () => void
  onCreated: () => void
}

export function NewKeyDrawer({ open, onClose, onCreated }: NewKeyDrawerProps) {
  const [label, setLabel] = useState("")
  const [tier, setTier] = useState<"admin" | "client">("client")
  const [allowedModelsText, setAllowedModelsText] = useState("*")
  const [rateLimit, setRateLimit] = useState("")
  const [debugEnabled, setDebugEnabled] = useState(false)
  const [confirmDebug, setConfirmDebug] = useState(false)
  const [created, setCreated] = useState<KeyCreateResponse | null>(null)
  const [copyOk, setCopyOk] = useState(false)

  useEffect(() => {
    if (!open) {
      setLabel("")
      setTier("client")
      setAllowedModelsText("*")
      setRateLimit("")
      setDebugEnabled(false)
      setConfirmDebug(false)
      setCreated(null)
      setCopyOk(false)
    }
  }, [open])

  const createMutation = useMutation({
    mutationFn: async () => {
      const allowed_models = allowedModelsText
        .split(/[,\s]+/)
        .map((m) => m.trim())
        .filter((m) => m.length > 0)
      const body: Record<string, unknown> = {
        label,
        tier,
        allowed_models,
        rate_limit_override:
          rateLimit.trim() === "" ? null : Number.parseInt(rateLimit, 10),
        debug_enabled: debugEnabled,
        debug_confirm: confirmDebug,
      }
      return api<KeyCreateResponse>("/keys", { method: "POST", body })
    },
    onSuccess: (data) => {
      setCreated(data)
    },
  })

  if (!open) return null

  const error =
    createMutation.error instanceof Error ?
      createMutation.error.message
    : null

  async function copyPlain() {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.plain)
      setCopyOk(true)
      window.setTimeout(() => setCopyOk(false), 1500)
    } catch {
      // clipboard rejected — leave UI as-is, the value is still selectable
    }
  }

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
            {created ? "Key created" : "New key"}
          </h2>
          <button
            onClick={onClose}
            className="text-tremor-content-subtle hover:text-tremor-content-strong"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {created ?
          <div className="mt-4 space-y-4">
            <Card decoration="top" decorationColor="emerald">
              <p className="text-sm text-tremor-content">
                The plaintext below is shown <strong>only this once</strong>.
                Copy it now — we never store nor display it again.
              </p>
              <div className="mt-3 break-all rounded-tremor-small bg-tremor-background-muted p-3 mono text-xs text-tremor-content-strong">
                {created.plain}
              </div>
              <Button
                className="mt-3"
                onClick={() => void copyPlain()}
              >
                {copyOk ? "Copied!" : "Copy to clipboard"}
              </Button>
            </Card>

            <Card>
              <h3 className="text-sm font-medium text-tremor-content-strong">
                Metadata
              </h3>
              <dl className="mt-2 grid grid-cols-2 gap-y-1 text-xs">
                <dt className="text-tremor-content-subtle">ID</dt>
                <dd className="mono text-tremor-content-strong">
                  {created.key.id}
                </dd>
                <dt className="text-tremor-content-subtle">Label</dt>
                <dd className="text-tremor-content-strong">
                  {created.key.label}
                </dd>
                <dt className="text-tremor-content-subtle">Tier</dt>
                <dd className="text-tremor-content-strong">
                  {created.key.tier}
                </dd>
                <dt className="text-tremor-content-subtle">Allowed models</dt>
                <dd className="text-tremor-content-strong mono">
                  {created.key.allowed_models.join(", ")}
                </dd>
              </dl>
            </Card>

            <Button variant="secondary" onClick={onCreated}>
              Done
            </Button>
          </div>
        : <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!label.trim()) return
              if (debugEnabled && !confirmDebug) return
              createMutation.mutate()
            }}
            className="mt-4 space-y-4"
          >
            <div>
              <label className="block text-xs font-medium text-tremor-content-subtle">
                Label *
              </label>
              <TextInput
                placeholder="my-laptop-cli"
                value={label}
                onValueChange={setLabel}
                className="mt-1"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-tremor-content-subtle">
                Tier
              </label>
              <select
                value={tier}
                onChange={(e) =>
                  setTier(e.target.value as "admin" | "client")
                }
                className="mt-1 w-full rounded-tremor-small border border-tremor-border bg-tremor-background px-3 py-2 text-sm"
              >
                <option value="client">Client</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-tremor-content-subtle">
                Allowed models
              </label>
              <TextInput
                placeholder="* or gpt-4o,gpt-4o-mini"
                value={allowedModelsText}
                onValueChange={setAllowedModelsText}
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
                value={rateLimit}
                onValueChange={setRateLimit}
                className="mt-1"
              />
            </div>

            <div className="space-y-2 rounded-tremor-small border border-tremor-border p-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={debugEnabled}
                  onChange={(e) => setDebugEnabled(e.target.checked)}
                />
                <span className="font-medium text-tremor-content-strong">
                  Enable debug mode (24h TTL)
                </span>
              </label>
              {debugEnabled && (
                <>
                  <p className="text-xs text-tremor-content-subtle">
                    Debug mode captures full upstream request/response bodies to
                    disk. Use sparingly — never on production traffic with
                    PII.
                  </p>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={confirmDebug}
                      onChange={(e) => setConfirmDebug(e.target.checked)}
                    />
                    <span>I understand and want to enable it.</span>
                  </label>
                </>
              )}
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
                disabled={
                  !label.trim()
                  || createMutation.isPending
                  || (debugEnabled && !confirmDebug)
                }
                loading={createMutation.isPending}
              >
                Create key
              </Button>
            </div>
          </form>
        }
      </div>
    </div>
  )
}
