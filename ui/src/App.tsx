import { Route, Routes } from "react-router-dom"

import { AppShell } from "./layout/AppShell"
import { Audit } from "./pages/Audit"
import { KeysDetail } from "./pages/Keys/Detail"
import { KeysList } from "./pages/Keys/List"
import { Logs } from "./pages/Logs"
import { Models } from "./pages/Models"
import { Overview } from "./pages/Overview"
import { PlaceholderPage } from "./pages/Placeholder"
import { Settings } from "./pages/Settings"
import { Usage } from "./pages/Usage"

/**
 * Top-level routes. AppShell renders the sidebar + topbar via <Outlet />.
 * All admin pages are now in the SPA — the legacy SSR pages remain reachable
 * under /admin/legacy/* for the moment but aren't linked from the SPA nav.
 */
export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Overview />} />
        <Route path="keys" element={<KeysList />} />
        <Route path="keys/:id" element={<KeysDetail />} />
        <Route path="usage" element={<Usage />} />
        <Route path="logs" element={<Logs />} />
        <Route path="audit" element={<Audit />} />
        <Route path="models" element={<Models />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<PlaceholderPage title="Not found" />} />
      </Route>
    </Routes>
  )
}
