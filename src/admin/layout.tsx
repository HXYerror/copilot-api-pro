/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx"

// ---------------------------------------------------------------------------
// Security headers applied to every /admin response
// ---------------------------------------------------------------------------

export const ADMIN_SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const

// ---------------------------------------------------------------------------
// Layout component
// ---------------------------------------------------------------------------

interface LayoutProps {
  title?: string
  active?: "index" | "keys" | "usage" | "audit" | "settings"
  /** CSRF token for the logout form (required for session-protected pages). */
  csrfToken?: string
  children?: unknown
}

export const Layout: FC<LayoutProps> = ({
  title = "Admin",
  active,
  csrfToken,
  children,
}) => {
  const navItems: Array<{
    href: string
    label: string
    key: LayoutProps["active"]
  }> = [
    { href: "/admin", label: "Overview", key: "index" },
    { href: "/admin/keys", label: "Keys", key: "keys" },
    { href: "/admin/usage", label: "Usage", key: "usage" },
    { href: "/admin/audit", label: "Audit", key: "audit" },
    { href: "/admin/settings", label: "Settings", key: "settings" },
  ]

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title} — Copilot API Admin</title>
        <link rel="stylesheet" href="/admin/assets/style.css" />
      </head>
      <body>
        <header class="admin-header">
          <div class="admin-header__brand">
            <a href="/admin">Copilot API</a>
          </div>
          <nav class="admin-nav">
            {navItems.map((item) => (
              <a
                key={item.key}
                href={item.href}
                class={`admin-nav__link${active === item.key ? " admin-nav__link--active" : ""}`}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <form
            method="post"
            action="/admin/session/logout"
            class="admin-header__logout"
          >
            {/* CSRF hidden field: required because HTML forms cannot send custom headers.
                The session middleware also accepts the token from the form body. */}
            {csrfToken && (
              <input type="hidden" name="csrf_token" value={csrfToken} />
            )}
            <button type="submit">Logout</button>
          </form>
        </header>
        <main class="admin-main">{children}</main>
        <footer class="admin-footer">
          <span>Copilot API Admin</span>
        </footer>
      </body>
    </html>
  )
}

// ---------------------------------------------------------------------------
// Login layout (no nav)
// ---------------------------------------------------------------------------

interface LoginLayoutProps {
  children?: unknown
}

export const LoginLayout: FC<LoginLayoutProps> = ({ children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Login — Copilot API Admin</title>
      <link rel="stylesheet" href="/admin/assets/style.css" />
    </head>
    <body class="login-page">
      <main class="login-main">{children}</main>
    </body>
  </html>
)
