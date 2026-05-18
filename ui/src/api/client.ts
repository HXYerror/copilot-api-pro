/**
 * Tiny fetch wrapper for the admin JSON API.
 *
 * Responsibilities:
 *   1. Prepend the `/admin/api` prefix (callers pass `/keys`, not `/admin/api/keys`).
 *   2. Attach CSRF header on mutating requests, sourced from the `csrf` cookie
 *      that login set. The server's csrf middleware verifies HMAC, not equality,
 *      so we just need to echo the cookie back in `X-CSRF-Token`.
 *   3. Tag the request with `Sec-Fetch-Site: same-origin` (the browser usually
 *      sets this, but our anti-CSRF middleware requires it — being explicit is
 *      cheap and helps when developing through tools like curl proxies).
 *   4. On 401, redirect to /admin/login so the user lands in a useful place
 *      instead of staring at a stuck page.
 *   5. Throw a structured error on non-2xx so TanStack Query treats it as a
 *      query/mutation failure.
 */

const BASE = "/admin/api"

function readCookie(name: string): string | null {
  const cookies = document.cookie.split(/;\s*/)
  for (const part of cookies) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq) === name) {
      return decodeURIComponent(part.slice(eq + 1))
    }
  }
  return null
}

export interface ApiError extends Error {
  status: number
  body: unknown
}

function makeApiError(status: number, body: unknown, fallback: string): ApiError {
  const msg =
    typeof body === "object" && body !== null && "error" in body
    && typeof (body as { error: unknown }).error === "string"
      ? (body as { error: string }).error
      : fallback
  const err = new Error(`${msg} (HTTP ${status})`) as ApiError
  err.status = status
  err.body = body
  return err
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE"
  body?: unknown
  /** When set, send a `Cache-Control: no-store` header (useful for live data). */
  noCache?: boolean
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? "GET"
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Sec-Fetch-Site": "same-origin",
  }

  let body: BodyInit | undefined
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json"
    body = JSON.stringify(opts.body)
  }

  if (method !== "GET") {
    const csrf = readCookie("csrf")
    if (csrf) headers["X-CSRF-Token"] = csrf
  }

  if (opts.noCache) headers["Cache-Control"] = "no-store"

  const url = path.startsWith("/admin/") ? path : BASE + path
  const res = await fetch(url, {
    method,
    headers,
    body,
    credentials: "same-origin",
  })

  if (res.status === 401 && !path.endsWith("/login")) {
    // Bounce to login. Avoid infinite redirect if the login itself 401s.
    if (window.location.pathname !== "/admin/login") {
      window.location.href = "/admin/login"
    }
    throw makeApiError(401, null, "Not authenticated")
  }

  const text = await res.text()
  let parsed: unknown = null
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  if (!res.ok) {
    throw makeApiError(res.status, parsed, res.statusText || "Request failed")
  }

  return parsed as T
}
