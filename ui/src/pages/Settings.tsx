import {
  Badge,
  Button,
  Card,
  Tab,
  TabGroup,
  TabList,
  TabPanel,
  TabPanels,
  Text,
  TextInput,
  Title,
} from "@tremor/react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import { api } from "~/api/client"
import type {
  AppConfig,
  SettingsResponse,
  UpstreamCatalogResponse,
  UpstreamModel,
} from "~/api/types"

interface ModelRow {
  alias: string
  upstream: string
  enabled: boolean
  allowed_keys: Array<string>
}

function configToRows(cfg: AppConfig): Array<ModelRow> {
  return Object.entries(cfg.models).map(([alias, e]) => ({
    alias,
    upstream: e.upstream,
    enabled: e.enabled,
    allowed_keys: e.allowed_keys,
  }))
}

function rowsToConfig(rows: Array<ModelRow>, base: AppConfig): AppConfig {
  const models: AppConfig["models"] = {}
  for (const r of rows) {
    if (!r.alias.trim() || !r.upstream.trim()) continue
    models[r.alias.trim()] = {
      upstream: r.upstream.trim(),
      enabled: r.enabled,
      allowed_keys: r.allowed_keys.length === 0 ? ["*"] : r.allowed_keys,
    }
  }
  return { ...base, models }
}

export function Settings() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<SettingsResponse>("/settings"),
  })
  const { data: catalog } = useQuery({
    queryKey: ["models", "upstream"],
    queryFn: () => api<UpstreamCatalogResponse>("/models/upstream"),
    staleTime: 5 * 60_000,
  })

  const [draft, setDraft] = useState<AppConfig | null>(null)
  const [rows, setRows] = useState<Array<ModelRow>>([])
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (data) {
      setDraft(data.config)
      setRows(configToRows(data.config))
    }
  }, [data])

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("Nothing to save")
      const body = rowsToConfig(rows, draft)
      return api<{ ok: true; config: AppConfig }>("/settings", {
        method: "PUT",
        body,
      })
    },
    onSuccess: (resp) => {
      setDraft(resp.config)
      setRows(configToRows(resp.config))
      setToast("Settings saved")
      void qc.invalidateQueries({ queryKey: ["settings"] })
      void qc.invalidateQueries({ queryKey: ["models"] })
      window.setTimeout(() => setToast(null), 2500)
    },
  })

  // Row-level diagnostics. Two kinds:
  //   - "incomplete"  → only alias or only upstream filled. The row will be
  //                     dropped on save; we surface it visually but do NOT
  //                     block the Save button (the user may not have finished
  //                     typing yet).
  //   - "duplicate alias" → real conflict; blocks Save.
  const rowDiagnostics = rows.map((r, i) => {
    const alias = r.alias.trim()
    const upstream = r.upstream.trim()
    const issues: Array<string> = []
    if (alias && !upstream) issues.push("upstream required")
    if (!alias && upstream) issues.push("alias required")
    if (alias && rows.findIndex((o, j) => j !== i && o.alias.trim() === alias) >= 0) {
      issues.push("duplicate alias")
    }
    return { complete: alias.length > 0 && upstream.length > 0, issues }
  })
  // Only duplicate aliases block save — incomplete rows get silently dropped
  // (with a visual warning), so the operator can save partially and finish
  // the half-filled row later if they choose.
  const blockingIssues = rowDiagnostics.some((d) =>
    d.issues.includes("duplicate alias"),
  )
  const droppedRows = rowDiagnostics.filter(
    (d) =>
      d.issues.includes("upstream required")
      || d.issues.includes("alias required"),
  ).length

  if (isLoading || !data || !draft) {
    return <div className="text-tremor-content">Loading settings…</div>
  }
  if (error) {
    return (
      <div className="rounded-tremor-small border border-rose-300 bg-rose-50 p-4 text-rose-700">
        Failed to load settings: {(error as Error).message}
      </div>
    )
  }

  const saveError =
    saveMutation.error instanceof Error ?
      saveMutation.error.message
    : null

  function updateRetention<K extends keyof AppConfig["retention"]>(
    key: K,
    value: number,
  ) {
    if (!draft) return
    setDraft({
      ...draft,
      retention: { ...draft.retention, [key]: value },
    })
  }

  function updateFeature<K extends keyof AppConfig["features"]>(
    key: K,
    value: boolean,
  ) {
    if (!draft) return
    setDraft({
      ...draft,
      features: { ...draft.features, [key]: value },
    })
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      { alias: "", upstream: "", enabled: true, allowed_keys: ["*"] },
    ])
  }

  function deleteRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i))
  }

  function updateRow(i: number, patch: Partial<ModelRow>) {
    setRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    )
  }

  return (
    <div className="space-y-4">
      {toast && (
        <div className="rounded-tremor-small border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-700">
          {toast}
        </div>
      )}
      {saveError && (
        <div className="rounded-tremor-small border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700">
          {saveError}
        </div>
      )}

      <Card className="!p-0">
        <TabGroup>
          <TabList className="border-b border-tremor-border">
            <Tab>General</Tab>
            <Tab>Models</Tab>
            <Tab>Catalog</Tab>
            <Tab>Advanced</Tab>
          </TabList>
          <TabPanels>
            <TabPanel>
              <div className="space-y-6 p-4">
                <section>
                  <Title>Features</Title>
                  <Text>
                    Auth is locked out of the UI to prevent operator lock-out.
                    Edit <span className="mono">config.json</span> directly to
                    toggle it.
                  </Text>
                  <div className="mt-3 space-y-2 text-sm">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={draft.features.auth} disabled />
                      <span className="text-tremor-content-subtle">
                        Auth (locked: edit config.json)
                      </span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={draft.features.telemetry}
                        onChange={(e) =>
                          updateFeature("telemetry", e.target.checked)
                        }
                      />
                      <span>Telemetry (event recording)</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={draft.features.debug}
                        onChange={(e) =>
                          updateFeature("debug", e.target.checked)
                        }
                      />
                      <span>Debug capture (global)</span>
                    </label>
                  </div>
                </section>

                <section>
                  <Title>Retention</Title>
                  <Text>Cleanup horizons for telemetry, traces, and audit.</Text>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                    <RetentionInput
                      label="Events (days)"
                      value={draft.retention.events_days}
                      onChange={(v) => updateRetention("events_days", v)}
                    />
                    <RetentionInput
                      label="Traces (days)"
                      value={draft.retention.traces_days}
                      onChange={(v) => updateRetention("traces_days", v)}
                    />
                    <RetentionInput
                      label="Traces max bytes"
                      value={draft.retention.traces_max_bytes}
                      onChange={(v) =>
                        updateRetention("traces_max_bytes", v)
                      }
                    />
                    <RetentionInput
                      label="Audit (days)"
                      value={draft.retention.audit_days}
                      onChange={(v) => updateRetention("audit_days", v)}
                    />
                  </div>
                </section>
              </div>
            </TabPanel>

            <TabPanel>
              <div className="space-y-4 p-4">
                <div className="flex items-center justify-between">
                  <Title>Model aliases</Title>
                  <Button variant="secondary" onClick={addRow}>
                    + Add alias
                  </Button>
                </div>
                <Text>
                  Each alias maps to an upstream model id used by the proxy
                  routes. Disabled aliases reject requests at the auth layer.
                  Multiple aliases may point to the same upstream model — alias
                  names just have to be unique themselves.
                </Text>
                {rows.length === 0 ?
                  <div className="flex h-24 items-center justify-center text-sm text-tremor-content-subtle">
                    No aliases configured.
                  </div>
                : <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-tremor-border text-left text-xs uppercase text-tremor-content-subtle">
                        <th className="px-2 py-2">Alias</th>
                        <th className="px-2 py-2">Upstream model</th>
                        <th className="px-2 py-2">Capabilities</th>
                        <th className="px-2 py-2">Enabled</th>
                        <th className="px-2 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const upstream = catalog?.items.find(
                          (m) => m.id === r.upstream,
                        )
                        const diag = rowDiagnostics[i]
                        return (
                          <tr
                            key={i}
                            className={
                              "border-b border-tremor-border last:border-b-0 align-top "
                              + (diag.issues.length > 0
                                ? "bg-rose-50/50"
                                : "")
                            }
                          >
                            <td className="px-2 py-2">
                              <TextInput
                                placeholder="gpt-4o"
                                value={r.alias}
                                onValueChange={(v) =>
                                  updateRow(i, { alias: v })
                                }
                                error={diag.issues.includes("alias required")
                                  || diag.issues.includes("duplicate alias")}
                                errorMessage={
                                  diag.issues.includes("duplicate alias") ?
                                    "duplicate alias"
                                  : diag.issues.includes("alias required") ?
                                    "alias required"
                                  : undefined
                                }
                              />
                            </td>
                            <td className="px-2 py-2">
                              <select
                                value={r.upstream}
                                onChange={(e) =>
                                  updateRow(i, { upstream: e.target.value })
                                }
                                className={
                                  "w-full rounded-tremor-small border bg-tremor-background px-3 py-2 text-sm "
                                  + (diag.issues.includes("upstream required")
                                    ? "border-rose-400"
                                    : "border-tremor-border")
                                }
                              >
                                <option value="">— select —</option>
                                {/* If the current upstream is no longer in the
                                    catalog (e.g. retired), surface it anyway
                                    so the operator can see + replace it. */}
                                {r.upstream
                                  && !catalog?.items.some(
                                    (m) => m.id === r.upstream,
                                  ) && (
                                  <option value={r.upstream}>
                                    {r.upstream} (not in catalog)
                                  </option>
                                )}
                                {catalog?.items.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.id}
                                    {m.preview ? " (preview)" : ""}
                                  </option>
                                ))}
                              </select>
                              {diag.issues.includes("upstream required") && (
                                <p className="mt-1 text-xs text-rose-600">
                                  upstream required
                                </p>
                              )}
                            </td>
                            <td className="px-2 py-2 text-xs text-tremor-content">
                              <CapsCell model={upstream} />
                            </td>
                            <td className="px-2 py-2 text-center">
                              <input
                                type="checkbox"
                                checked={r.enabled}
                                onChange={(e) =>
                                  updateRow(i, { enabled: e.target.checked })
                                }
                              />
                            </td>
                            <td className="px-2 py-2 text-right">
                              <button
                                onClick={() => deleteRow(i)}
                                className="text-xs text-rose-600 hover:underline"
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                }
              </div>
            </TabPanel>

            <TabPanel>
              <CatalogPanel
                catalog={catalog}
                draft={draft}
                onUseAlias={(alias, upstream) => {
                  setRows((prev) => {
                    // Reuse a blank trailing row if any, otherwise append.
                    const idx = prev.findIndex(
                      (r) => !r.alias.trim() && !r.upstream.trim(),
                    )
                    const next: ModelRow = {
                      alias,
                      upstream,
                      enabled: true,
                      allowed_keys: ["*"],
                    }
                    if (idx >= 0) {
                      const copy = [...prev]
                      copy[idx] = next
                      return copy
                    }
                    return [...prev, next]
                  })
                }}
              />
            </TabPanel>

            <TabPanel>
              <div className="space-y-4 p-4">
                <Title>Raw config.json</Title>
                <Text>
                  Read-only view of the persisted config (refreshes after save).
                  Use the CLI to edit fields not exposed here.
                </Text>
                <pre className="rounded bg-tremor-background-muted p-3 mono text-xs whitespace-pre-wrap break-words">
                  {JSON.stringify(draft, null, 2)}
                </pre>
              </div>
            </TabPanel>
          </TabPanels>
        </TabGroup>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {blockingIssues && (
          <span className="text-xs text-rose-600">
            Duplicate alias — rename or remove the conflicting row.
          </span>
        )}
        {!blockingIssues && droppedRows > 0 && (
          <span className="text-xs text-amber-600">
            {droppedRows} incomplete row(s) will be dropped on save.
          </span>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            setDraft(data.config)
            setRows(configToRows(data.config))
          }}
        >
          Discard
        </Button>
        <Button
          onClick={() => saveMutation.mutate()}
          loading={saveMutation.isPending}
          disabled={blockingIssues || saveMutation.isPending}
        >
          Save changes
        </Button>
      </div>
    </div>
  )
}

interface RetentionInputProps {
  label: string
  value: number
  onChange: (v: number) => void
}

function RetentionInput({ label, value, onChange }: RetentionInputProps) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-tremor-content-subtle">
        {label}
      </span>
      <TextInput
        value={String(value)}
        onValueChange={(v) => {
          const n = Number.parseInt(v, 10)
          if (Number.isFinite(n) && n >= 0) onChange(n)
        }}
        className="mt-1"
      />
    </label>
  )
}

function CapsCell({ model }: { model: UpstreamModel | undefined }) {
  if (!model) {
    return <span className="text-tremor-content-subtle">—</span>
  }
  const caps = model.capabilities ?? {
    family: "",
    type: "",
    tokenizer: "",
    limits: {},
    supports: {},
  }
  const limits = caps.limits ?? {}
  const supports = (caps.supports ?? {}) as { tool_calls?: boolean }
  const ctx = limits.max_context_window_tokens
  const out = limits.max_output_tokens
  const fmt = (n: number | undefined) =>
    n === undefined || n === null
      ? "—"
      : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
      : String(n)
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        <Badge color="blue">{model.vendor}</Badge>
        {caps.family && <Badge color="slate">{caps.family}</Badge>}
        {caps.type && <Badge color="violet">{caps.type}</Badge>}
        {model.preview && <Badge color="amber">preview</Badge>}
      </div>
      <div className="text-tremor-content">
        ctx {fmt(ctx)} · out {fmt(out)}
        {supports.tool_calls && " · tools"}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Catalog tab — read-only view of the live Copilot model catalog (state.models)
// with quick "Use as alias" actions that drop a row into the Models tab.
// ---------------------------------------------------------------------------

interface CatalogPanelProps {
  catalog: UpstreamCatalogResponse | undefined
  draft: AppConfig
  onUseAlias: (alias: string, upstream: string) => void
}

function CatalogPanel({ catalog, draft, onUseAlias }: CatalogPanelProps) {
  const [query, setQuery] = useState("")
  const [vendor, setVendor] = useState("")
  const [showOnlyEnabled, setShowOnlyEnabled] = useState(false)
  const [expandedCatalog, setExpandedCatalog] = useState<
    Record<string, boolean>
  >({})

  // For each upstream id, list the aliases that point to it.
  const aliasesByUpstream = new Map<string, Array<string>>()
  for (const [alias, entry] of Object.entries(draft?.models ?? {})) {
    const list = aliasesByUpstream.get(entry.upstream) ?? []
    list.push(alias)
    aliasesByUpstream.set(entry.upstream, list)
  }

  const items = catalog?.items ?? []
  const vendors = [...new Set(items.map((m) => m.vendor))].sort()

  const filtered = items.filter((m) => {
    if (showOnlyEnabled && !m.model_picker_enabled) return false
    if (vendor && m.vendor !== vendor) return false
    if (query) {
      const q = query.toLowerCase()
      const hit =
        m.id.toLowerCase().includes(q)
        || m.name.toLowerCase().includes(q)
        || m.vendor.toLowerCase().includes(q)
        || m.capabilities.family.toLowerCase().includes(q)
      if (!hit) return false
    }
    return true
  })

  if (!catalog) {
    return (
      <div className="flex h-32 items-center justify-center p-4 text-sm text-tremor-content-subtle">
        Loading Copilot catalog…
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      <div>
        <Title>Copilot upstream catalog</Title>
        <Text>
          Live model list reported by GitHub Copilot at startup. Read-only.
          Use the "Use as alias" button to start a new alias row in the
          Models tab; the alias defaults to the upstream id but is editable.
        </Text>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          placeholder="Search id / name / family…"
          value={query}
          onValueChange={setQuery}
          className="max-w-xs"
        />
        <select
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          className="rounded-tremor-small border border-tremor-border bg-tremor-background px-3 py-2 text-sm"
        >
          <option value="">All vendors</option>
          {vendors.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showOnlyEnabled}
            onChange={(e) => setShowOnlyEnabled(e.target.checked)}
          />
          <span>Model picker enabled only</span>
        </label>
        <div className="ml-auto text-xs text-tremor-content-subtle">
          {filtered.length} / {items.length}
        </div>
      </div>

      <div className="overflow-x-auto rounded-tremor-small border border-tremor-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-tremor-border bg-tremor-background-muted text-left text-xs uppercase text-tremor-content-subtle">
              <th className="px-3 py-2 w-8"></th>
              <th className="px-3 py-2">Upstream id</th>
              <th className="px-3 py-2">Display name</th>
              <th className="px-3 py-2">Vendor / family</th>
              <th className="px-3 py-2">Type / endpoints</th>
              <th className="px-3 py-2">Ctx / out</th>
              <th className="px-3 py-2">Thinking</th>
              <th className="px-3 py-2">Reasoning</th>
              <th className="px-3 py-2">Supports</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Aliases</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ?
              <tr>
                <td
                  colSpan={12}
                  className="px-3 py-8 text-center text-tremor-content-subtle"
                >
                  No models match the current filter.
                </td>
              </tr>
            : filtered.map((m) => (
                <CatalogRow
                  key={m.id}
                  model={m}
                  aliases={aliasesByUpstream.get(m.id) ?? []}
                  isOpen={!!expandedCatalog[m.id]}
                  onToggle={() =>
                    setExpandedCatalog((p) => ({ ...p, [m.id]: !p[m.id] }))
                  }
                  onUseAlias={onUseAlias}
                />
              ))
            }
          </tbody>
        </table>
      </div>
    </div>
  )
}

interface CatalogRowProps {
  model: UpstreamModel
  aliases: Array<string>
  isOpen: boolean
  onToggle: () => void
  onUseAlias: (alias: string, upstream: string) => void
}

function CatalogRow({
  model: m,
  aliases,
  isOpen,
  onToggle,
  onUseAlias,
}: CatalogRowProps) {
  const caps = m.capabilities ?? {
    family: "",
    type: "",
    tokenizer: "",
    limits: {},
    supports: {},
  }
  const limits = (caps.limits ?? {}) as Record<string, unknown>
  const supports = (caps.supports ?? {}) as Record<string, unknown>
  const ctx = limits.max_context_window_tokens as number | undefined
  const out = limits.max_output_tokens as number | undefined
  const minThink = supports.min_thinking_budget as number | undefined
  const maxThink = supports.max_thinking_budget as number | undefined
  const adaptiveThink = supports.adaptive_thinking === true
  const reasoning = Array.isArray(supports.reasoning_effort)
    ? (supports.reasoning_effort as Array<string>)
    : null
  return (
    <>
      <tr
        className="border-b border-tremor-border last:border-b-0 align-top hover:bg-tremor-background-muted/60"
      >
        <td
          className="px-3 py-2 cursor-pointer text-tremor-content-subtle"
          onClick={onToggle}
        >
          {isOpen ? "▾" : "▸"}
        </td>
        <td className="px-3 py-2 mono text-xs text-tremor-content-strong">
          {m.id}
        </td>
        <td className="px-3 py-2 text-xs text-tremor-content">
          {m.name}
          {m.version && m.version !== m.id && (
            <div className="text-tremor-content-subtle">v{m.version}</div>
          )}
        </td>
        <td className="px-3 py-2 text-xs">
          <div>
            <Badge color="blue">{m.vendor}</Badge>
          </div>
          <div className="mt-1 text-tremor-content">
            {caps.family as string}
          </div>
        </td>
        <td className="px-3 py-2 text-xs">
          <Badge color="violet">{(caps.type as string) || "—"}</Badge>
          {Array.isArray(m.supported_endpoints)
            && m.supported_endpoints.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {m.supported_endpoints
                .filter((p) => !p.startsWith("ws:"))
                .map((p) => (
                  <Badge
                    key={p}
                    color={p === "/responses" ? "violet" : "blue"}
                  >
                    {p}
                  </Badge>
                ))}
            </div>
          )}
        </td>
        <td className="px-3 py-2 text-xs text-tremor-content">
          <div>
            <span className="text-tremor-content-subtle">ctx</span>{" "}
            {fmtTokens(ctx)}
          </div>
          <div>
            <span className="text-tremor-content-subtle">out</span>{" "}
            {fmtTokens(out)}
          </div>
        </td>
        <td className="px-3 py-2 text-xs">
          {maxThink !== undefined ?
            <>
              <Badge color="cyan">
                {minThink ?? "?"}–{fmtTokens(maxThink)}
              </Badge>
              {adaptiveThink && (
                <div className="mt-1 text-tremor-content-subtle">adaptive</div>
              )}
            </>
          : <span className="text-tremor-content-subtle">—</span>
          }
        </td>
        <td className="px-3 py-2 text-xs">
          {reasoning ?
            <div className="flex flex-wrap gap-1">
              {reasoning.map((eff) => (
                <Badge key={eff} color="indigo">
                  {eff}
                </Badge>
              ))}
            </div>
          : <span className="text-tremor-content-subtle">—</span>
          }
        </td>
        <td className="px-3 py-2 text-xs">
          <div className="flex flex-wrap gap-1">
            {supports.tool_calls === true && (
              <Badge color="emerald">tools</Badge>
            )}
            {supports.parallel_tool_calls === true && (
              <Badge color="emerald">parallel</Badge>
            )}
            {supports.streaming === true && (
              <Badge color="cyan">stream</Badge>
            )}
            {supports.vision === true && (
              <Badge color="indigo">vision</Badge>
            )}
            {supports.structured_outputs === true && (
              <Badge color="violet">structured</Badge>
            )}
            {supports.dimensions === true && (
              <Badge color="slate">embed</Badge>
            )}
          </div>
        </td>
        <td className="px-3 py-2 text-xs">
          <div className="flex flex-wrap gap-1">
            {m.preview ?
              <Badge color="amber">preview</Badge>
            : <Badge color="slate">ga</Badge>
            }
            {m.model_picker_enabled ?
              <Badge color="emerald">picker on</Badge>
            : null}
            {m.policy?.state && m.policy.state !== "enabled" && (
              <Badge color="rose">policy: {m.policy.state}</Badge>
            )}
            {m.model_picker_category && (
              <Badge color="slate">{m.model_picker_category}</Badge>
            )}
          </div>
        </td>
        <td className="px-3 py-2 text-xs">
          {aliases.length === 0 ?
            <span className="text-tremor-content-subtle">—</span>
          : <div className="flex flex-wrap gap-1">
              {aliases.map((a) => (
                <Badge key={a} color="violet">
                  {a}
                </Badge>
              ))}
            </div>
          }
        </td>
        <td className="px-3 py-2 text-right">
          <button
            onClick={() => onUseAlias(m.id, m.id)}
            className="text-xs font-medium text-tremor-brand-emphasis hover:underline"
          >
            Use as alias →
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-tremor-border">
          <td></td>
          <td
            colSpan={11}
            className="px-3 py-3 bg-tremor-background-muted/40 text-xs"
          >
            <details open>
              <summary className="cursor-pointer mb-2 font-semibold text-tremor-content-strong">
                Full record from Copilot
              </summary>
              <pre className="mono text-xs whitespace-pre-wrap break-words rounded bg-tremor-background p-3">
                {JSON.stringify(m, null, 2)}
              </pre>
            </details>
          </td>
        </tr>
      )}
    </>
  )
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined || n === null) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}
