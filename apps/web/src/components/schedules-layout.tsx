import * as React from "react"
import { useSuspenseQuery } from "@tanstack/react-query"
import { Link, Outlet, useNavigate, useSearch } from "@tanstack/react-router"
import { CalendarDays, History, ListTodo } from "lucide-react"

import type { ServerPickerOption } from "@/components/server-picker-list"
import { ServerScopePicker } from "@/components/server-scope-picker"
import { ScheduleScopeContext } from "@/components/schedule-scope"
import {
  relaySnapshotQueryOptions,
  scheduleOptionsQueryOptions,
} from "@/lib/query-options"
import { getRelaySnapshot } from "@/server/relay"
import { getScheduleOptions } from "@/server/schedules"

type ScheduleOption = Awaited<ReturnType<typeof getScheduleOptions>>[number]
type RelaySnapshot = Awaited<ReturnType<typeof getRelaySnapshot>>

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
  const { data: targets } = useSuspenseQuery({
    ...scheduleOptionsQueryOptions(),
    notifyOnChangeProps: ["data"],
  })
  const { data: instances } = useSuspenseQuery({
    ...relaySnapshotQueryOptions(),
    notifyOnChangeProps: ["data"],
    select: selectScheduleScopeInstances,
  })
  const kind = useSearch({
    from: "/_app/schedules",
    select: (search) => search.kind,
  })
  const relay = useSearch({
    from: "/_app/schedules",
    select: (search) => search.relay,
  })
  const target = useSearch({
    from: "/_app/schedules",
    select: (search) => search.target,
  })
  const navigate = useNavigate({ from: "/schedules" })
  const options = React.useMemo(
    () => scheduleScopeOptions(targets, instances),
    [instances, targets]
  )
  const selected = React.useMemo(
    () =>
      options.find(
        (option) =>
          option.id === target &&
          option.kind === kind &&
          option.relayId === relay
      ) ?? null,
    [kind, options, relay, target]
  )
  const selectScope = React.useCallback(
    (option: ServerPickerOption | null) => {
      void navigate({
        replace: true,
        search: (previous) => ({
          ...previous,
          kind: option?.kind,
          relay: option?.relayId,
          target: option?.id,
        }),
      })
    },
    [navigate]
  )

  return (
    <ScheduleScopeContext.Provider value={selected}>
      <div className="min-h-full bg-background">
        <header className="mx-auto w-full max-w-[90rem] px-3 pt-3 sm:px-5">
          <ServerScopePicker
            allDescription="Every accessible server, database, and Relay"
            allLabel="All instances"
            ariaLabel="Accessible schedule targets"
            changeLabel="Change instance"
            chooseLabel="Choose instance"
            emptyMessage="No accessible schedule targets found."
            selectedServer={selected}
            servers={options}
            onSelect={selectScope}
          />
          <SchedulesNavigation />
        </header>
        <div data-slot="schedules-content" className="[contain:paint]">
          {children}
        </div>
      </div>
    </ScheduleScopeContext.Provider>
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
          search={(previous) => previous}
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

function scheduleScopeOptions(
  targets: ReadonlyArray<ScheduleOption>,
  instances: ReadonlyArray<{
    id: string
    name: string
    relayId: string
    relayName: string
  }>
): Array<ServerPickerOption> {
  const instancesById = new Map(
    instances.map((instance) => [
      `${instance.relayId}:${instance.id}`,
      instance,
    ])
  )
  return targets.map((target) => ({
    description: `${target.kind === "instance" ? "Server" : target.kind === "database" ? "Database" : "Relay"} · ${target.relayName} · ${target.id}`,
    id: target.id,
    kind: target.kind === "instance" ? "server" : target.kind,
    name:
      target.kind === "instance"
        ? (instancesById.get(`${target.relayId}:${target.id}`)?.name ??
          target.name)
        : target.name,
    relayId: target.relayId,
    relayName:
      target.kind === "instance"
        ? (instancesById.get(`${target.relayId}:${target.id}`)?.relayName ??
          target.relayName)
        : target.relayName,
  }))
}

function selectScheduleScopeInstances(snapshot: RelaySnapshot) {
  return snapshot.instances.map(({ id, name, relayId, relayName }) => ({
    id,
    name,
    relayId,
    relayName,
  }))
}
