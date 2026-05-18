import { Card, Text, Title } from "@tremor/react"

interface PlaceholderProps {
  title: string
  message?: string
}

/**
 * Pages we haven't yet migrated. Phase 1 only ships Overview wired to a real
 * JSON endpoint — the rest still link to the legacy SSR pages via this stub
 * (rendered with a hard link so the user can bail out to the working version
 * while we land the React replacements page-by-page).
 */
export function PlaceholderPage({ title, message }: PlaceholderProps) {
  // Map SPA route → legacy SSR route. The legacy pages still exist and are
  // mounted at the original paths (the SSR sub-app catch-all hasn't replaced
  // them yet).
  const legacyHref = `/admin/legacy${window.location.pathname.replace("/admin", "") || ""}`
  return (
    <Card>
      <Title>{title}</Title>
      <Text className="mt-2">
        {message
          ?? "This page hasn't been migrated to the new UI yet. The legacy version is still available below."}
      </Text>
      <div className="mt-4">
        <a
          href={legacyHref}
          className="inline-block rounded-tremor-small bg-tremor-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-tremor-brand-emphasis"
        >
          Open legacy view →
        </a>
      </div>
    </Card>
  )
}
