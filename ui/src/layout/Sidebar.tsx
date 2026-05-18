import { NavLink } from "react-router-dom"

interface NavItem {
  to: string
  label: string
  end?: boolean
}

interface NavGroup {
  label: string
  items: Array<NavItem>
}

const NAV: Array<NavGroup> = [
  {
    label: "OBSERVABILITY",
    items: [
      { to: "/", label: "Overview", end: true },
      { to: "/usage", label: "Usage" },
      { to: "/logs", label: "Logs" },
      { to: "/audit", label: "Audit" },
    ],
  },
  {
    label: "ACCESS",
    items: [{ to: "/keys", label: "Keys" }],
  },
  {
    label: "CONFIG",
    items: [
      { to: "/models", label: "Models" },
      { to: "/settings", label: "Settings" },
    ],
  },
]

export function Sidebar() {
  return (
    <aside className="w-60 shrink-0 border-r border-tremor-border bg-white">
      <div className="flex h-14 items-center gap-2 border-b border-tremor-border px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded bg-tremor-brand text-sm font-bold text-white">
          C
        </div>
        <div className="font-semibold text-tremor-content-strong">
          Copilot API
        </div>
      </div>

      <nav className="px-2 py-4">
        {NAV.map((group) => (
          <div key={group.label} className="mb-6">
            <div className="px-3 pb-1 text-[10px] font-semibold tracking-wider text-tremor-content-subtle">
              {group.label}
            </div>
            <ul>
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      [
                        "flex items-center rounded-tremor-small px-3 py-2 text-sm font-medium",
                        isActive
                          ? "bg-tremor-brand-faint text-tremor-brand-emphasis"
                          : "text-tremor-content hover:bg-tremor-background-subtle hover:text-tremor-content-strong",
                      ].join(" ")
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  )
}
