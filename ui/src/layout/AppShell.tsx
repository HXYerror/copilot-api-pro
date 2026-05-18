import { Outlet, useLocation } from "react-router-dom"

import { Sidebar } from "./Sidebar"
import { TopBar } from "./TopBar"

const PAGE_TITLES: Record<string, string> = {
  "/": "Overview",
  "/keys": "Keys",
  "/usage": "Usage",
  "/logs": "Logs",
  "/audit": "Audit",
  "/models": "Models",
  "/settings": "Settings",
}

function titleForPath(pathname: string): string {
  // Strip basename (BrowserRouter already strips /admin) and trailing slashes
  const clean = pathname.replace(/\/+$/, "") || "/"
  if (PAGE_TITLES[clean]) return PAGE_TITLES[clean]
  // Best-effort match for /keys/:id, /logs/:id, etc.
  const top = "/" + clean.split("/")[1]
  return PAGE_TITLES[top] ?? "Admin"
}

export function AppShell() {
  const { pathname } = useLocation()
  const title = titleForPath(pathname)

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <TopBar title={title} />
        <main className="flex-1 overflow-y-auto bg-tremor-background-muted p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
