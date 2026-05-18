/**
 * Small format helpers shared between Keys pages.
 */

const NUM_FMT = new Intl.NumberFormat("en", { notation: "compact" })

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—"
  return NUM_FMT.format(n)
}

export function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`
}

export function fmtRelative(ts: number | null | undefined): string {
  if (!ts) return "never"
  const age = Date.now() - ts
  if (age < 60_000) return `${Math.floor(age / 1000)}s ago`
  if (age < 3600_000) return `${Math.floor(age / 60_000)}m ago`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`
  return `${Math.floor(age / 86_400_000)}d ago`
}

export function fmtAbsolute(ts: number | null | undefined): string {
  if (!ts) return "—"
  return new Date(ts).toLocaleString()
}
