import * as React from "react"
import { Link, Outlet } from "@tanstack/react-router"
import { CalendarDays, History, ListTodo } from "lucide-react"

const scheduleTabs = [
  { label: "Schedules", to: "/schedules", icon: ListTodo, exact: true },
  {
    label: "History",
    to: "/schedules/history",
    icon: History,
    exact: false,
  },
  {
    label: "Calendar",
    to: "/schedules/calendar",
    icon: CalendarDays,
    exact: false,
  },
] as const

export const SchedulesShell = React.memo(function SchedulesShell({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-full bg-background">
      <header className="mx-auto w-full max-w-[90rem] px-3 pt-3 sm:px-5">
        <SchedulesNavigation />
      </header>
      <div data-slot="schedules-content" className="[contain:paint]">
        {children}
      </div>
    </div>
  )
})

export function SchedulesRouteOutlet() {
  return <Outlet />
}

const SchedulesNavigation = React.memo(function SchedulesNavigation() {
  return (
    <nav
      aria-label="Schedule sections"
      className="mb-6 no-scrollbar flex gap-1 overflow-x-auto overflow-y-hidden border-b"
    >
      {scheduleTabs.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          activeOptions={{ exact: tab.exact }}
          className="relative flex h-10 shrink-0 items-center gap-2 px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          activeProps={{
            className:
              "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary",
          }}
        >
          <tab.icon className="size-3.5" />
          {tab.label}
        </Link>
      ))}
    </nav>
  )
})
