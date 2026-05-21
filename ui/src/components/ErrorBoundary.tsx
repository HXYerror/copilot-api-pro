import React from "react"

interface State {
  error: Error | null
}

/**
 * Catches render-phase exceptions so a single broken page doesn't blank
 * the entire SPA. Without this, throws inside any page component (e.g.
 * a backend response shape change that the UI didn't anticipate) leave
 * the user staring at an empty white screen with the error only visible
 * in the browser console.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[admin-ui] render crashed:", error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="m-6 max-w-3xl rounded-tremor-small border border-rose-300 bg-rose-50 p-4 text-rose-700">
          <div className="font-semibold">Admin UI crashed</div>
          <div className="mt-1 text-sm">{this.state.error.message}</div>
          <div className="mt-2 text-xs text-rose-600">
            Try reloading. If this keeps happening, the server may be running an
            older build than the UI expects — restart the server so the JSON
            shapes match.
          </div>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-3 rounded border border-rose-400 px-3 py-1 text-sm hover:bg-rose-100"
          >
            Dismiss
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
