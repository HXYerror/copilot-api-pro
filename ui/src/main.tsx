import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter } from "react-router-dom"

import App from "./App"
import "./index.css"

// Fail loudly if the SPA is being served from somewhere unexpected — the
// router and API client both assume we live at /admin.
if (
  typeof window !== "undefined"
  && !window.location.pathname.startsWith("/admin")
) {
  console.warn(
    "Copilot API admin SPA loaded from",
    window.location.pathname,
    "— expected /admin/*. Routing may misbehave.",
  )
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Admin pages are operator-facing; we'd rather refetch on focus than
      // show stale numbers. Networks here are localhost so cost is trivial.
      refetchOnWindowFocus: true,
      retry: 1,
      staleTime: 10_000,
    },
  },
})

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/admin">
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
