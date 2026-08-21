import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  Check,
  CirclePause,
  CirclePlay,
  CircleCheck,
  CircleX,
  ClipboardCopy,
  Code2,
  Copy,
  Database,
  EllipsisVertical,
  HardDriveDownload,
  History,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server,
  Trash2,
  X,
} from "lucide-react"
import { useNavigate, useSearch } from "@tanstack/react-router"

import type { ScheduleAction, ScheduleTarget } from "@workspace/contracts"
import {
  normalizeScheduleCron,
  scheduleActionSupportsTarget,
} from "@workspace/contracts"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  WorkspaceDataTable,
  WorkspaceTableCell,
  WorkspaceTableHead,
  WorkspaceTableHeading,
  createWorkspaceTableSearchStore,
  useWorkspaceTableSearchInput,
} from "@/components/workspace-data-table"
import type { WorkspaceTableSearchStore } from "@/components/workspace-data-table"
import type { ServerPickerOption } from "@/components/server-picker-list"
import { useScheduleScope } from "@/components/schedule-scope"
import { forkPromise } from "@/effect/promise"
import {
  queryKeys,
  scheduleOptionsQueryOptions,
  schedulesQueryOptions,
} from "@/lib/query-options"
import {
  createSchedule,
  deleteSchedule,
  getScheduleOptions,
  getSchedules,
  runScheduleNow,
  updateSchedule,
} from "@/server/schedules"

type Schedule = Awaited<ReturnType<typeof getSchedules>>[number]
type ScheduleOption = Awaited<ReturnType<typeof getScheduleOptions>>[number]
type EditorMode = { kind: "create" } | { kind: "edit"; schedule: Schedule }
type ScheduleRun = Schedule["runs"][number]
type ScheduleRunWithRelay = ScheduleRun & { relayId: string }

const relativeFormatter = new Intl.RelativeTimeFormat("en-US", {
  numeric: "auto",
  style: "short",
})

export const SchedulesPage = React.memo(function SchedulesPage() {
  const { data: schedules } = useSuspenseQuery({
    ...schedulesQueryOptions(),
    notifyOnChangeProps: ["data"],
  })
  const { data: options } = useSuspenseQuery({
    ...scheduleOptionsQueryOptions(),
    notifyOnChangeProps: ["data"],
  })
  const navigate = useNavigate({ from: "/schedules" })
  const selectedScope = useScheduleScope()
  const [searchStore] = React.useState(createWorkspaceTableSearchStore)
  const [editor, setEditor] = React.useState<EditorMode | null>(null)
  const [deleting, setDeleting] = React.useState<Schedule | null>(null)
  const canCreate = options.some((option) => option.canCreate)
  const optionMap = React.useMemo(
    () => new Map(options.map((option) => [targetKey(option), option])),
    [options]
  )
  const scopedSchedules = React.useMemo(
    () =>
      selectedScope
        ? schedules.filter((schedule) =>
            scheduleMatchesScope(schedule, selectedScope)
          )
        : schedules,
    [schedules, selectedScope]
  )
  const openEdit = React.useCallback(
    (schedule: Schedule) => setEditor({ kind: "edit", schedule }),
    []
  )
  const openDelete = React.useCallback(
    (schedule: Schedule) => setDeleting(schedule),
    []
  )
  const openCreate = React.useCallback(() => setEditor({ kind: "create" }), [])
  const viewHistory = React.useCallback(
    (schedule: Schedule) => {
      void navigate({
        to: "/schedules/history",
        search: (previous) => ({
          ...previous,
          run: undefined,
          runRelay: undefined,
          schedule: schedule.id,
        }),
      })
    },
    [navigate]
  )
  const viewRun = React.useCallback(
    (schedule: Schedule, run: ScheduleRunWithRelay) => {
      void navigate({
        to: "/schedules/history",
        search: (previous) => ({
          ...previous,
          run: run.id,
          runRelay: run.relayId,
          schedule: schedule.id,
        }),
      })
    },
    [navigate]
  )

  return (
    <div className="mx-auto w-full max-w-[90rem] px-3 pb-10 sm:px-5">
      <section className="overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
        <ScheduleToolbar
          canCreate={canCreate}
          searchStore={searchStore}
          onCreate={openCreate}
        />
        <ScheduleTable
          canCreate={canCreate}
          optionMap={optionMap}
          schedules={scopedSchedules}
          scope={selectedScope}
          searchStore={searchStore}
          onCreate={openCreate}
          onDelete={openDelete}
          onEdit={openEdit}
          onViewHistory={viewHistory}
          onViewRun={viewRun}
        />
      </section>

      {editor ? (
        <ScheduleEditorDialog
          mode={editor}
          options={options}
          onClose={() => setEditor(null)}
          onSaved={() => setEditor(null)}
        />
      ) : null}
      <DeleteScheduleDialog
        schedule={deleting}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
})

const ScheduleToolbar = React.memo(function ScheduleToolbar({
  canCreate,
  searchStore,
  onCreate,
}: {
  canCreate: boolean
  searchStore: WorkspaceTableSearchStore
  onCreate: () => void
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  useWorkspaceTableSearchInput(inputRef, searchStore)

  return (
    <div className="flex min-w-0 items-center gap-2 border-b bg-background/25 p-3">
      <ScheduleSyncButton />
      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          id="schedule-search"
          type="search"
          className="pl-9"
          defaultValue={searchStore.getServerSnapshot()}
          placeholder="Search schedules"
          onChange={(event) => searchStore.set(event.currentTarget.value)}
        />
      </div>
      {canCreate ? (
        <Button className="ml-auto shrink-0" size="sm" onClick={onCreate}>
          <Plus />
          Create schedule
        </Button>
      ) : null}
    </div>
  )
})

const ScheduleSyncButton = React.memo(function ScheduleSyncButton() {
  const { fetchStatus, refetch } = useQuery({
    ...schedulesQueryOptions(),
    notifyOnChangeProps: ["fetchStatus"],
  })
  const syncing = fetchStatus === "fetching"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Sync schedules"
          aria-busy={syncing}
          disabled={syncing}
          onClick={() => void refetch()}
        >
          <RefreshCw className={syncing ? "animate-spin" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Sync schedules
      </TooltipContent>
    </Tooltip>
  )
})

const ScheduleTable = React.memo(function ScheduleTable({
  canCreate,
  optionMap,
  schedules,
  scope,
  searchStore,
  onCreate,
  onDelete,
  onEdit,
  onViewHistory,
  onViewRun,
}: {
  canCreate: boolean
  optionMap: ReadonlyMap<string, ScheduleOption>
  schedules: Array<Schedule>
  scope: ServerPickerOption | null
  searchStore: WorkspaceTableSearchStore
  onCreate: () => void
  onDelete: (schedule: Schedule) => void
  onEdit: (schedule: Schedule) => void
  onViewHistory: (schedule: Schedule) => void
  onViewRun: (schedule: Schedule, run: ScheduleRunWithRelay) => void
}) {
  const renderRow = React.useCallback(
    (schedule: Schedule) => (
      <ScheduleTableRow
        optionMap={optionMap}
        schedule={schedule}
        scope={scope}
        onDelete={onDelete}
        onEdit={onEdit}
        onViewHistory={onViewHistory}
        onViewRun={onViewRun}
      />
    ),
    [onDelete, onEdit, onViewHistory, onViewRun, optionMap, scope]
  )
  const renderEmpty = React.useCallback(
    (searchActive: boolean) => (
      <EmptyScheduleTable
        canCreate={canCreate}
        scopeActive={scope !== null}
        searchActive={searchActive}
        onCreate={onCreate}
      />
    ),
    [canCreate, onCreate, scope]
  )

  return (
    <WorkspaceDataTable
      getRowKey={scheduleRowKey}
      getSearchText={scheduleSearchText}
      head={<ScheduleTableHead />}
      items={schedules}
      renderEmpty={renderEmpty}
      renderRow={renderRow}
      searchStore={searchStore}
    />
  )
})

const ScheduleTableHead = React.memo(function ScheduleTableHead() {
  return (
    <WorkspaceTableHead>
      <WorkspaceTableHeading className="w-20 px-2 sm:w-28 sm:px-3">
        Status
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-auto sm:w-[34%]">
        Schedule
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[20%] md:table-cell">
        Timing
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[16%] lg:table-cell">
        Last run
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[16%] xl:table-cell">
        Next run
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-48 px-1 text-right sm:w-64 sm:px-3">
        Actions
      </WorkspaceTableHeading>
    </WorkspaceTableHead>
  )
})

const ScheduleTableRow = React.memo(function ScheduleTableRow({
  optionMap,
  schedule,
  scope,
  onDelete,
  onEdit,
  onViewHistory,
  onViewRun,
}: {
  optionMap: ReadonlyMap<string, ScheduleOption>
  schedule: Schedule
  scope: ServerPickerOption | null
  onDelete: (schedule: Schedule) => void
  onEdit: (schedule: Schedule) => void
  onViewHistory: (schedule: Schedule) => void
  onViewRun: (schedule: Schedule, run: ScheduleRunWithRelay) => void
}) {
  const queryClient = useQueryClient()
  const canEdit = canOperateSchedule(schedule, optionMap, "canUpdate")
  const canDelete = schedule.targets.every(
    (target) => optionMap.get(targetKey(target))?.canDelete
  )
  const canRun = canOperateSchedule(schedule, optionMap, "canExecute")
  const canDuplicate = canOperateSchedule(schedule, optionMap, "canCreate")
  const runMutation = useMutation({
    mutationFn: () => runScheduleNow({ data: { id: schedule.id } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all })
      showToast({
        message:
          result.started === result.total
            ? "Schedule started"
            : `Schedule started on ${result.started} of ${result.total} Relays`,
        type: result.started === result.total ? "success" : "warning",
      })
    },
    onError: (cause) =>
      showToast({ message: errorMessage(cause), type: "error" }),
  })
  const enabledMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      updateSchedule({
        data: { ...scheduleInput(schedule), enabled, id: schedule.id },
      }),
    onSuccess: async (_updated, enabled) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all })
      showToast({
        message: enabled ? "Schedule enabled" : "Schedule disabled",
        type: "success",
      })
    },
    onError: (cause) =>
      showToast({ message: errorMessage(cause), type: "error" }),
  })
  const duplicateMutation = useMutation({
    mutationFn: () =>
      createSchedule({
        data: {
          ...scheduleInput(schedule),
          actions: schedule.actions.map((action) => ({
            ...action,
            id: crypto.randomUUID(),
          })),
          enabled: false,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all })
      showToast({ message: "Schedule duplicated", type: "success" })
    },
    onError: (cause) =>
      showToast({ message: errorMessage(cause), type: "error" }),
  })
  const nextRun = scheduleNextRun(schedule)
  const lastRun = scheduleLastRun(schedule, scope)
  const status = scheduleStatus(schedule)
  const copyScheduleId = React.useCallback(() => {
    forkPromise(
      async () => {
        await navigator.clipboard.writeText(schedule.id)
        showToast({ message: "Schedule ID copied", type: "success" })
      },
      (cause) => showToast({ message: errorMessage(cause), type: "error" })
    )
  }, [schedule.id])

  return (
    <tr className="group transition-colors hover:bg-accent/25">
      <WorkspaceTableCell className="px-2 sm:px-3">
        <ScheduleState state={status} />
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <p className="truncate text-xs font-semibold text-foreground">
          {schedule.name}
        </p>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden md:table-cell">
        <ScheduleTiming cron={schedule.cron} />
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden lg:table-cell">
        <ScheduleLastRun
          run={lastRun}
          timezone={schedule.timezone}
          onView={() => lastRun && onViewRun(schedule, lastRun)}
        />
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden xl:table-cell">
        <ScheduleNextRun nextRun={nextRun} timezone={schedule.timezone} />
      </WorkspaceTableCell>
      <WorkspaceTableCell className="px-1 sm:px-3">
        <div className="flex items-center justify-end gap-1">
          {canRun ? (
            <Button
              type="button"
              size="sm"
              className="bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-500 focus-visible:ring-emerald-500/40 dark:bg-emerald-600 dark:hover:bg-emerald-500"
              disabled={runMutation.isPending}
              onClick={() => runMutation.mutate()}
            >
              {runMutation.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Play />
              )}
              Run now
            </Button>
          ) : null}
          {canEdit ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Edit ${schedule.name}`}
                  onClick={() => onEdit(schedule)}
                >
                  <Pencil />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Edit schedule</TooltipContent>
            </Tooltip>
          ) : null}
          {canDelete ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Delete ${schedule.name}`}
                  onClick={() => onDelete(schedule)}
                >
                  <Trash2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Delete schedule</TooltipContent>
            </Tooltip>
          ) : null}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`More actions for ${schedule.name}`}
                  >
                    <EllipsisVertical />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">More actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onSelect={copyScheduleId}>
                <ClipboardCopy /> Copy schedule ID
              </DropdownMenuItem>
              {canDuplicate ? (
                <DropdownMenuItem
                  disabled={duplicateMutation.isPending}
                  onSelect={() => duplicateMutation.mutate()}
                >
                  {duplicateMutation.isPending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Copy />
                  )}
                  Duplicate schedule
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => onViewHistory(schedule)}>
                <History /> View history
              </DropdownMenuItem>
              {canEdit ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={enabledMutation.isPending}
                    onSelect={() => enabledMutation.mutate(!schedule.enabled)}
                  >
                    {enabledMutation.isPending ? (
                      <LoaderCircle className="animate-spin" />
                    ) : schedule.enabled ? (
                      <CirclePause />
                    ) : (
                      <CirclePlay />
                    )}
                    {schedule.enabled ? "Disable schedule" : "Enable schedule"}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </WorkspaceTableCell>
    </tr>
  )
})

function ScheduleTiming({ cron }: { cron: string }) {
  const alias = cronAliasLabel(cron)
  if (!alias) {
    return (
      <span className="font-mono text-[0.625rem] text-foreground">{cron}</span>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex cursor-default text-[0.625rem] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {alias}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono">
        {cron}
      </TooltipContent>
    </Tooltip>
  )
}

function ScheduleNextRun({
  nextRun,
  timezone,
}: {
  nextRun: Date | null
  timezone: string
}) {
  if (!nextRun) {
    return (
      <span className="text-[0.625rem] text-muted-foreground">
        Not scheduled
      </span>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={nextRun.toISOString()}
          tabIndex={0}
          className="inline-flex cursor-default text-[0.625rem] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          suppressHydrationWarning
        >
          {relativeTime(nextRun)}
        </time>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {fullTimestampLabel(nextRun, timezone)}
      </TooltipContent>
    </Tooltip>
  )
}

function ScheduleLastRun({
  run,
  timezone,
  onView,
}: {
  run: ScheduleRunWithRelay | null
  timezone: string
  onView: () => void
}) {
  if (!run) {
    return <span className="text-[0.625rem] text-muted-foreground">Never</span>
  }
  const succeeded = run.status === "succeeded"
  const Icon = succeeded ? CircleCheck : CircleX
  const finishedAt = new Date(run.finishedAt)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-sm text-[0.625rem] text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={onView}
        >
          <Icon
            className={`size-3.5 shrink-0 ${succeeded ? "text-emerald-400" : "text-destructive"}`}
          />
          <time dateTime={finishedAt.toISOString()} suppressHydrationWarning>
            {relativeTime(finishedAt)}
          </time>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {fullTimestampLabel(finishedAt, timezone)}
      </TooltipContent>
    </Tooltip>
  )
}

function EmptyScheduleTable({
  canCreate,
  scopeActive,
  searchActive,
  onCreate,
}: {
  canCreate: boolean
  scopeActive: boolean
  searchActive: boolean
  onCreate: () => void
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      <Play className="size-6 text-muted-foreground/45" />
      <p className="mt-3 text-sm font-semibold">
        {searchActive
          ? "No schedules match your search"
          : scopeActive
            ? "No schedules for this instance"
            : "No schedules yet"}
      </p>
      <p className="mt-1 max-w-sm text-[0.625rem] leading-4 text-muted-foreground">
        {searchActive
          ? "Try a schedule name, cron expression, timezone, action, or target."
          : scopeActive
            ? "Choose another instance or create a schedule for this target."
            : "Create Relay-owned automation that keeps running when Hearth is offline."}
      </p>
      {!searchActive && canCreate ? (
        <Button type="button" size="sm" className="mt-4" onClick={onCreate}>
          <Plus /> Create schedule
        </Button>
      ) : null}
    </div>
  )
}

export const ScheduleHistoryPage = React.memo(function ScheduleHistoryPage() {
  const { data: schedules } = useSuspenseQuery({
    ...schedulesQueryOptions(),
    notifyOnChangeProps: ["data"],
  })
  const search = useSearch({ from: "/_app/schedules" })
  const navigate = useNavigate({ from: "/schedules/history" })
  const selectedScope = useScheduleScope()
  const [searchStore] = React.useState(createWorkspaceTableSearchStore)
  const filteredSchedule = React.useMemo(
    () =>
      search.schedule
        ? (schedules.find((schedule) => schedule.id === search.schedule) ??
          null)
        : null,
    [schedules, search.schedule]
  )
  const runs = React.useMemo(
    () => scheduleHistoryRuns(schedules, selectedScope, search.schedule),
    [schedules, search.schedule, selectedScope]
  )
  const selectedRun = React.useMemo(
    () =>
      search.run
        ? (runs.find(
            (run) =>
              run.id === search.run &&
              (!search.runRelay || run.relayId === search.runRelay)
          ) ?? null)
        : null,
    [runs, search.run, search.runRelay]
  )
  const clearScheduleFilter = React.useCallback(
    () =>
      void navigate({
        replace: true,
        search: (previous) => ({
          ...previous,
          run: undefined,
          runRelay: undefined,
          schedule: undefined,
        }),
      }),
    [navigate]
  )
  const openRun = React.useCallback(
    (run: ScheduleHistoryRun) => {
      void navigate({
        replace: true,
        search: (previous) => ({
          ...previous,
          run: run.id,
          runRelay: run.relayId,
        }),
      })
    },
    [navigate]
  )
  const closeRun = React.useCallback(() => {
    void navigate({
      replace: true,
      search: (previous) => ({
        ...previous,
        run: undefined,
        runRelay: undefined,
      }),
    })
  }, [navigate])

  return (
    <div className="mx-auto w-full max-w-[90rem] px-3 pb-10 sm:px-5">
      <section className="overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
        <HistoryToolbar
          filteredScheduleName={
            search.schedule
              ? (filteredSchedule?.name ?? "Unknown schedule")
              : null
          }
          searchStore={searchStore}
          runCount={runs.length}
          onClearScheduleFilter={clearScheduleFilter}
        />
        <ScheduleHistoryTable
          runs={runs}
          scopeActive={selectedScope !== null}
          searchStore={searchStore}
          onOpenRun={openRun}
        />
      </section>
      <ScheduleRunDialog run={selectedRun} onClose={closeRun} />
    </div>
  )
})

type ScheduleHistoryRun = Schedule["runs"][number] & {
  definitionActions: Schedule["actions"]
  scheduleName: string
  timezone: string
}

function scheduleHistoryRuns(
  schedules: ReadonlyArray<Schedule>,
  scope: ServerPickerOption | null,
  scheduleId: string | undefined
): Array<ScheduleHistoryRun> {
  const runs: Array<ScheduleHistoryRun> = []
  for (const schedule of schedules) {
    if (scheduleId && schedule.id !== scheduleId) continue
    for (const run of schedule.runs) {
      if (
        scope &&
        !run.targetRuns.some((targetRun) =>
          scheduleTargetMatchesScope(targetRun.target, scope)
        )
      ) {
        continue
      }
      runs.push({
        ...run,
        definitionActions: schedule.actions,
        scheduleName: schedule.name,
        timezone: schedule.timezone,
      })
    }
  }
  return runs.sort((left, right) => right.scheduledAt - left.scheduledAt)
}

const HistoryToolbar = React.memo(function HistoryToolbar({
  filteredScheduleName,
  runCount,
  searchStore,
  onClearScheduleFilter,
}: {
  filteredScheduleName: string | null
  runCount: number
  searchStore: WorkspaceTableSearchStore
  onClearScheduleFilter: () => void
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  useWorkspaceTableSearchInput(inputRef, searchStore)
  return (
    <div className="flex min-w-0 items-center gap-2 border-b bg-background/25 p-3">
      <ScheduleSyncButton />
      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          id="schedule-history-search"
          type="search"
          className="pl-9"
          defaultValue={searchStore.getServerSnapshot()}
          placeholder="Search run history"
          onChange={(event) => searchStore.set(event.currentTarget.value)}
        />
      </div>
      {filteredScheduleName ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="flex max-w-32 min-w-0 gap-1.5 px-2 text-[0.625rem] sm:max-w-52"
          aria-label={`Clear history filter for ${filteredScheduleName}`}
          onClick={onClearScheduleFilter}
        >
          <span className="truncate">{filteredScheduleName}</span>
          <X className="shrink-0" />
        </Button>
      ) : null}
      <Badge variant="outline" className="font-mono text-[0.625rem]">
        {runCount} run{runCount === 1 ? "" : "s"}
      </Badge>
    </div>
  )
})

const ScheduleHistoryTable = React.memo(function ScheduleHistoryTable({
  runs,
  scopeActive,
  searchStore,
  onOpenRun,
}: {
  runs: Array<ScheduleHistoryRun>
  scopeActive: boolean
  searchStore: WorkspaceTableSearchStore
  onOpenRun: (run: ScheduleHistoryRun) => void
}) {
  const renderRow = React.useCallback(
    (run: ScheduleHistoryRun) => (
      <ScheduleHistoryRow run={run} onOpen={onOpenRun} />
    ),
    [onOpenRun]
  )
  const renderEmpty = React.useCallback(
    (searchActive: boolean) => (
      <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
        <Play className="size-6 text-muted-foreground/45" />
        <p className="mt-3 text-sm font-semibold">
          {searchActive
            ? "No runs match your search"
            : scopeActive
              ? "No runs for this instance"
              : "No schedule runs yet"}
        </p>
        <p className="mt-1 max-w-sm text-[0.625rem] leading-4 text-muted-foreground">
          {scopeActive && !searchActive
            ? "Completed and attempted runs for this instance will appear here."
            : "Completed and attempted schedule runs will appear here."}
        </p>
      </div>
    ),
    [scopeActive]
  )
  return (
    <WorkspaceDataTable
      getRowKey={historyRowKey}
      getSearchText={historySearchText}
      head={<ScheduleHistoryHead />}
      items={runs}
      renderEmpty={renderEmpty}
      renderRow={renderRow}
      searchStore={searchStore}
    />
  )
})

const ScheduleHistoryHead = React.memo(function ScheduleHistoryHead() {
  return (
    <WorkspaceTableHead>
      <WorkspaceTableHeading className="w-24 px-2 sm:w-32 sm:px-3">
        Status
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-auto sm:w-[30%]">
        Schedule
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[24%] md:table-cell">
        Started
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[16%] lg:table-cell">
        Duration
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[14%] xl:table-cell">
        Targets
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[18%] sm:table-cell">
        Relay
      </WorkspaceTableHeading>
    </WorkspaceTableHead>
  )
})

const ScheduleHistoryRow = React.memo(function ScheduleHistoryRow({
  run,
  onOpen,
}: {
  run: ScheduleHistoryRun
  onOpen: (run: ScheduleHistoryRun) => void
}) {
  const open = React.useCallback(() => onOpen(run), [onOpen, run])
  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={`View ${run.scheduleName} run from ${timestampLabel(new Date(run.startedAt), run.timezone)} details`}
      className="cursor-pointer transition-colors hover:bg-accent/25 focus-visible:bg-accent/30 focus-visible:outline-none"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          open()
        }
      }}
    >
      <WorkspaceTableCell className="px-2 sm:px-3">
        <RunStatusDot status={run.status} />
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground">
            {run.scheduleName}
          </p>
          <p className="truncate font-mono text-[0.5rem] text-muted-foreground">
            r{run.revision} · {run.status.replaceAll("_", " ")}
          </p>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden md:table-cell">
        <div className="min-w-0">
          <p className="truncate text-[0.625rem] text-foreground">
            {timestampLabel(new Date(run.startedAt), run.timezone)}
          </p>
          <p className="truncate text-[0.5rem] text-muted-foreground">
            {relativeTime(new Date(run.startedAt))}
          </p>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden lg:table-cell">
        <span className="font-mono text-[0.5625rem] text-foreground">
          {durationLabel(run.finishedAt - run.startedAt)}
        </span>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden xl:table-cell">
        <span className="text-[0.625rem] text-foreground">
          {run.targetRuns.length}
        </span>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden sm:table-cell">
        <span className="block truncate font-mono text-[0.5625rem] text-muted-foreground">
          {run.relayId}
        </span>
      </WorkspaceTableCell>
    </tr>
  )
})

const ScheduleRunDialog = React.memo(function ScheduleRunDialog({
  run,
  onClose,
}: {
  run: ScheduleHistoryRun | null
  onClose: () => void
}) {
  const actionsById = React.useMemo(
    () => new Map(run?.definitionActions.map((action) => [action.id, action])),
    [run]
  )

  return (
    <Dialog open={run !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid max-h-[min(90dvh,52rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {run ? (
          <>
            <DialogHeader className="border-b px-5 py-4 pr-12">
              <div className="flex items-start gap-3">
                <RunResultIcon
                  status={run.status}
                  className="mt-0.5 size-5 shrink-0"
                />
                <div className="min-w-0">
                  <DialogTitle className="truncate text-base">
                    {run.scheduleName}
                  </DialogTitle>
                  <DialogDescription className="mt-1">
                    Run details and ordered action audit history
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="min-h-0 overflow-y-auto">
              <section className="grid gap-px border-b bg-border sm:grid-cols-2 lg:grid-cols-4">
                <RunMetadataItem
                  label="Status"
                  value={runStatusLabel(run.status)}
                />
                <RunMetadataItem
                  label="Started"
                  value={timestampLabel(new Date(run.startedAt), run.timezone)}
                  detail={relativeTime(new Date(run.startedAt))}
                />
                <RunMetadataItem
                  label="Duration"
                  value={
                    run.status === "running"
                      ? "In progress"
                      : durationLabel(run.finishedAt - run.startedAt)
                  }
                />
                <RunMetadataItem label="Relay" value={run.relayId} mono />
              </section>

              <section className="border-b px-5 py-4">
                <h3 className="text-xs font-semibold">Run metadata</h3>
                <dl className="mt-3 grid gap-x-6 gap-y-3 text-[0.625rem] sm:grid-cols-2">
                  <RunMetadataRow label="Run ID" value={run.id} mono />
                  <RunMetadataRow
                    label="Schedule ID"
                    value={run.scheduleId}
                    mono
                  />
                  <RunMetadataRow
                    label="Revision"
                    value={`r${run.revision}`}
                    mono
                  />
                  <RunMetadataRow
                    label="Scheduled for"
                    value={fullTimestampLabel(
                      new Date(run.scheduledAt),
                      run.timezone
                    )}
                  />
                  <RunMetadataRow
                    label="Completed"
                    value={
                      run.status === "running"
                        ? "Not completed"
                        : fullTimestampLabel(
                            new Date(run.finishedAt),
                            run.timezone
                          )
                    }
                  />
                  <RunMetadataRow
                    label="Targets"
                    value={`${run.targetRuns.length}`}
                    mono
                  />
                </dl>
              </section>

              <section className="px-5 py-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-xs font-semibold">Target activity</h3>
                    <p className="mt-0.5 text-[0.625rem] text-muted-foreground">
                      Actions are shown in the order the Relay attempted them.
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className="font-mono text-[0.5625rem]"
                  >
                    {run.targetRuns.reduce(
                      (count, targetRun) => count + targetRun.attempts.length,
                      0
                    )}{" "}
                    attempts
                  </Badge>
                </div>

                {run.targetRuns.length === 0 ? (
                  <div className="mt-4 rounded-lg border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
                    No targets were attempted for this run.
                  </div>
                ) : (
                  <div className="mt-4 space-y-3">
                    {run.targetRuns.map((targetRun) => (
                      <TargetRunAudit
                        key={targetRun.id}
                        actionsById={actionsById}
                        run={targetRun}
                        timezone={run.timezone}
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
})

function RunMetadataItem({
  label,
  value,
  detail,
  mono = false,
}: {
  label: string
  value: string
  detail?: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0 bg-background px-5 py-3.5">
      <p className="font-mono text-[0.5rem] tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={`mt-1 truncate text-xs font-medium text-foreground ${mono ? "font-mono" : ""}`}
        title={value}
      >
        {value}
      </p>
      {detail ? (
        <p className="mt-0.5 text-[0.5625rem] text-muted-foreground">
          {detail}
        </p>
      ) : null}
    </div>
  )
}

function RunMetadataRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`mt-0.5 truncate text-foreground ${mono ? "font-mono text-[0.5625rem]" : ""}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}

function TargetRunAudit({
  actionsById,
  run,
  timezone,
}: {
  actionsById: ReadonlyMap<string, ScheduleAction>
  run: ScheduleHistoryRun["targetRuns"][number]
  timezone: string
}) {
  return (
    <article className="overflow-hidden rounded-lg border bg-background/35">
      <header className="flex items-center gap-3 border-b bg-muted/15 px-3 py-2.5">
        <TargetIcon
          kind={run.target.kind}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold">{run.target.name}</p>
          <p className="truncate font-mono text-[0.5rem] text-muted-foreground">
            {run.target.kind} · {run.target.id}
          </p>
        </div>
        <span className="text-[0.5625rem] text-muted-foreground">
          {durationLabel(run.finishedAt - run.startedAt)}
        </span>
        <RunResultIcon status={run.status} className="size-4 shrink-0" />
      </header>
      {run.error ? (
        <p className="border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-[0.625rem] text-destructive">
          {run.error}
        </p>
      ) : null}
      {run.attempts.length === 0 ? (
        <p className="px-3 py-4 text-[0.625rem] text-muted-foreground">
          No actions were attempted.
        </p>
      ) : (
        <ol className="divide-y divide-border/70">
          {run.attempts.map((attempt, index) => {
            const action = actionsById.get(attempt.actionId)
            return (
              <li key={attempt.id} className="flex gap-3 px-3 py-3">
                <span className="relative mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border bg-background font-mono text-[0.5rem] text-muted-foreground">
                  {index + 1}
                </span>
                <ActionIcon
                  type={attempt.actionType}
                  className="mt-1 size-3.5 shrink-0 text-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-[0.6875rem] font-semibold">
                      {actionLabel(attempt.actionType)}
                    </p>
                    <AttemptStatus status={attempt.status} />
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[0.5625rem] text-muted-foreground">
                    {actionAuditSummary(action, attempt.actionId)}
                  </p>
                  <p className="mt-1 text-[0.5625rem] text-muted-foreground">
                    {timestampLabel(new Date(attempt.startedAt), timezone)} ·{" "}
                    {durationLabel(attempt.finishedAt - attempt.startedAt)}
                  </p>
                  {attempt.error ? (
                    <p className="mt-2 rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-[0.625rem] leading-4 text-destructive">
                      {attempt.error}
                    </p>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </article>
  )
}

function AttemptStatus({
  status,
}: {
  status: ScheduleHistoryRun["targetRuns"][number]["attempts"][number]["status"]
}) {
  const succeeded = status === "succeeded"
  const failed = status === "failed" || status === "interrupted"
  return (
    <span
      className={`inline-flex items-center gap-1 text-[0.5625rem] font-medium capitalize ${succeeded ? "text-emerald-400" : failed ? "text-destructive" : "text-muted-foreground"}`}
    >
      {succeeded ? (
        <Check className="size-3" />
      ) : failed ? (
        <X className="size-3" />
      ) : (
        <CirclePause className="size-3" />
      )}
      {status.replaceAll("_", " ")}
    </span>
  )
}

function ScheduleEditorDialog({
  mode,
  options,
  onClose,
  onSaved,
}: {
  mode: EditorMode
  options: ReadonlyArray<ScheduleOption>
  onClose: () => void
  onSaved: (scheduleId: string) => void
}) {
  const queryClient = useQueryClient()
  const existing = mode.kind === "edit" ? mode.schedule : null
  const [name, setName] = React.useState(existing?.name ?? "")
  const [cron, setCron] = React.useState(existing?.cron ?? "daily")
  const [timezone, setTimezone] = React.useState(
    existing?.timezone ?? localTimezone()
  )
  const [enabled, setEnabled] = React.useState(existing?.enabled ?? true)
  const [selectedTargets, setSelectedTargets] = React.useState(
    () => new Set(existing?.targets.map(targetKey) ?? [])
  )
  const [actions, setActions] = React.useState<Array<ScheduleAction>>(
    existing?.actions ?? []
  )
  const permissionKey = mode.kind === "create" ? "canCreate" : "canUpdate"
  const selectedOptions = React.useMemo(
    () => options.filter((option) => selectedTargets.has(targetKey(option))),
    [options, selectedTargets]
  )
  const actionPermissions = React.useMemo(
    () => ({
      backup: scheduleActionAllowed("backup", selectedOptions, permissionKey),
      console_command: scheduleActionAllowed(
        "console_command",
        selectedOptions,
        permissionKey
      ),
      power: scheduleActionAllowed("power", selectedOptions, permissionKey),
    }),
    [permissionKey, selectedOptions]
  )
  const canSave =
    name.trim().length > 0 &&
    cron.trim().length > 0 &&
    timezone.trim().length > 0 &&
    selectedOptions.length > 0 &&
    selectedOptions.every((option) => option[permissionKey]) &&
    actions.length > 0

  const mutation = useMutation({
    mutationFn: async () => {
      const data = {
        actions,
        cron,
        enabled,
        name,
        targets: selectedOptions.map(
          ({
            canCreate: _,
            canDelete: __,
            canExecute: ___,
            canUpdate: ____,
            permittedActions: _____,
            relayName: ______,
            ...target
          }) => target
        ),
        timezone,
      }
      return existing
        ? updateSchedule({ data: { ...data, id: existing.id } })
        : createSchedule({ data })
    },
    onSuccess: async (schedule) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all })
      showToast({
        message: existing ? "Schedule updated" : "Schedule created",
        type: "success",
      })
      if (schedule) onSaved(schedule.id)
    },
    onError: (cause) =>
      showToast({ message: errorMessage(cause), type: "error" }),
  })

  const addAction = React.useCallback(
    (type: ScheduleAction["type"]) => {
      if (!actionPermissions[type]) return
      const id = crypto.randomUUID()
      setActions((current) => [
        ...current,
        type === "console_command"
          ? { command: "", id, type }
          : type === "backup"
            ? {
                destination: { kind: "local" },
                id,
                name: "Scheduled backup",
                type,
              }
            : { action: "restart", id, type },
      ])
    },
    [actionPermissions]
  )
  const updateAction = React.useCallback((next: ScheduleAction) => {
    setActions((current) =>
      current.map((item) => (item.id === next.id ? next : item))
    )
  }, [])
  const moveEditorAction = React.useCallback(
    (actionId: string, direction: -1 | 1) => {
      setActions((current) => {
        const index = current.findIndex((action) => action.id === actionId)
        return index < 0 ? current : moveAction(current, index, direction)
      })
    },
    []
  )
  const removeAction = React.useCallback((actionId: string) => {
    setActions((current) => current.filter((action) => action.id !== actionId))
  }, [])
  const toggleTarget = React.useCallback((key: string, checked: boolean) => {
    setSelectedTargets((current) => {
      const next = new Set(current)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[min(90dvh,56rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {existing ? "Edit schedule" : "Create schedule"}
          </DialogTitle>
          <DialogDescription>
            Actions run in order on every compatible target. Unsupported actions
            are skipped without failing the run.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSave && !mutation.isPending) mutation.mutate()
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2">
              <Input
                value={name}
                maxLength={120}
                placeholder="Backup My Server Daily"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Timing">
              <Select
                value={cronPreset(cron)}
                onValueChange={(value) => value !== "custom" && setCron(value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="custom">Custom cron</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1.5 font-mono text-[0.625rem] text-muted-foreground">
                Cron · {normalizeScheduleCron(cron)}
              </p>
            </Field>
            <Field label="Timezone">
              <Input
                value={timezone}
                maxLength={120}
                placeholder="America/New_York"
                onChange={(event) => setTimezone(event.target.value)}
              />
            </Field>
            {cronPreset(cron) === "custom" ? (
              <Field
                label="Cron expression"
                hint="Five fields: minute hour day month weekday"
                className="sm:col-span-2"
              >
                <Input
                  className="font-mono"
                  value={cron}
                  maxLength={120}
                  placeholder="0 0 * * *"
                  onChange={(event) => setCron(event.target.value)}
                />
              </Field>
            ) : null}
          </div>

          <ScheduleTargetSelector
            options={options}
            permissionKey={permissionKey}
            selectedOptionsCount={selectedOptions.length}
            selectedTargets={selectedTargets}
            onToggle={toggleTarget}
          />

          <ScheduleActionsEditor
            actions={actions}
            allowed={actionPermissions}
            onAdd={addAction}
            onChange={updateAction}
            onMove={moveEditorAction}
            onRemove={removeAction}
          />

          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border bg-background/30 px-3 py-3">
            <span>
              <span className="block text-xs font-semibold">
                Schedule enabled
              </span>
              <span className="block text-[0.625rem] text-muted-foreground">
                Disabled schedules remain deployed but do not run.
              </span>
            </span>
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave || mutation.isPending}>
              {mutation.isPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              {existing ? "Save changes" : "Create schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const ScheduleTargetSelector = React.memo(function ScheduleTargetSelector({
  options,
  permissionKey,
  selectedOptionsCount,
  selectedTargets,
  onToggle,
}: {
  options: ReadonlyArray<ScheduleOption>
  permissionKey: "canCreate" | "canUpdate"
  selectedOptionsCount: number
  selectedTargets: ReadonlySet<string>
  onToggle: (key: string, checked: boolean) => void
}) {
  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">Targets</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Select every server, database, or Relay this schedule applies to.
          </p>
        </div>
        <span className="font-mono text-[0.625rem] text-muted-foreground">
          {selectedOptionsCount} selected
        </span>
      </div>
      <div className="mt-3 grid max-h-52 gap-2 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2">
        {options.map((option) => {
          const key = targetKey(option)
          return (
            <ScheduleTargetOption
              key={key}
              option={option}
              optionKey={key}
              checked={selectedTargets.has(key)}
              disabled={!option[permissionKey]}
              onToggle={onToggle}
            />
          )
        })}
      </div>
    </div>
  )
})

const ScheduleTargetOption = React.memo(function ScheduleTargetOption({
  option,
  optionKey,
  checked,
  disabled,
  onToggle,
}: {
  option: ScheduleOption
  optionKey: string
  checked: boolean
  disabled: boolean
  onToggle: (key: string, checked: boolean) => void
}) {
  return (
    <label
      className={`flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-xs ${disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:bg-accent/40"}`}
    >
      <input
        type="checkbox"
        className="size-3.5 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onToggle(optionKey, event.target.checked)}
      />
      <TargetIcon
        kind={option.kind}
        className="size-3.5 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate font-medium">{option.name}</span>
      <span className="font-mono text-[0.5625rem] text-muted-foreground">
        {option.kind}
      </span>
    </label>
  )
})

const ScheduleActionsEditor = React.memo(function ScheduleActionsEditor({
  actions,
  allowed,
  onAdd,
  onChange,
  onMove,
  onRemove,
}: {
  actions: ReadonlyArray<ScheduleAction>
  allowed: Readonly<Record<ScheduleAction["type"], boolean>>
  onAdd: (type: ScheduleAction["type"]) => void
  onChange: (action: ScheduleAction) => void
  onMove: (actionId: string, direction: -1 | 1) => void
  onRemove: (actionId: string) => void
}) {
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Ordered actions</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Only actions you are permitted to schedule are available.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <AddActionButton
            icon={Code2}
            label="Command"
            disabled={!allowed.console_command}
            onClick={() => onAdd("console_command")}
          />
          <AddActionButton
            icon={HardDriveDownload}
            label="Backup"
            disabled={!allowed.backup}
            onClick={() => onAdd("backup")}
          />
          <AddActionButton
            icon={Power}
            label="Power"
            disabled={!allowed.power}
            onClick={() => onAdd("power")}
          />
        </div>
      </div>
      {actions.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
          Select a target, then add the first action.
        </div>
      ) : (
        <div className="relative mt-3 space-y-2 before:absolute before:top-6 before:bottom-6 before:left-[1.3rem] before:w-px before:bg-border">
          {actions.map((action, index) => (
            <ActionEditor
              key={action.id}
              action={action}
              index={index}
              total={actions.length}
              onChange={onChange}
              onMove={onMove}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </div>
  )
})

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string
  hint?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <label className={className}>
      <span className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium">
        {label}
        {hint ? (
          <span className="font-normal text-muted-foreground">{hint}</span>
        ) : null}
      </span>
      {children}
    </label>
  )
}

const AddActionButton = React.memo(function AddActionButton({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: typeof Code2
  label: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className="size-3.5" />
      {label}
    </Button>
  )
})

const ActionEditor = React.memo(function ActionEditor({
  action,
  index,
  total,
  onChange,
  onMove,
  onRemove,
}: {
  action: ScheduleAction
  index: number
  total: number
  onChange: (action: ScheduleAction) => void
  onMove: (actionId: string, direction: -1 | 1) => void
  onRemove: (actionId: string) => void
}) {
  return (
    <div className="relative rounded-lg border bg-background/45 py-3 pr-3 pl-11">
      <span className="absolute top-3.5 left-3 z-10 grid size-5 place-items-center rounded-full border bg-background font-mono text-[0.5625rem] text-muted-foreground">
        {index + 1}
      </span>
      <div className="flex items-start gap-3">
        <ActionIcon
          type={action.type}
          className="mt-2 size-4 shrink-0 text-primary"
        />
        <div className="min-w-0 flex-1">
          <p className="mb-2 text-xs font-semibold">
            {actionLabel(action.type)}
          </p>
          {action.type === "console_command" ? (
            <Input
              className="font-mono text-xs"
              value={action.command}
              placeholder="say Server backing up..."
              maxLength={4096}
              onChange={(event) =>
                onChange({ ...action, command: event.target.value })
              }
            />
          ) : action.type === "backup" ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={action.name}
                maxLength={120}
                placeholder="Scheduled backup"
                onChange={(event) =>
                  onChange({ ...action, name: event.target.value })
                }
              />
              <Input value="Local Relay storage" disabled />
            </div>
          ) : (
            <Select
              value={action.action}
              onValueChange={(value) =>
                onChange({ ...action, action: value as typeof action.action })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="start">Start</SelectItem>
                <SelectItem value="stop">Stop</SelectItem>
                <SelectItem value="restart">Restart</SelectItem>
                <SelectItem value="kill">Kill</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={index === 0}
            onClick={() => onMove(action.id, -1)}
            aria-label="Move action up"
          >
            <ArrowUp className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={index === total - 1}
            onClick={() => onMove(action.id, 1)}
            aria-label="Move action down"
          >
            <ArrowDown className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onRemove(action.id)}
            aria-label="Remove action"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
})

function DeleteScheduleDialog({
  schedule,
  onClose,
}: {
  schedule: Schedule | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () =>
      schedule
        ? deleteSchedule({ data: { id: schedule.id } })
        : Promise.resolve(null),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all })
      showToast({ message: "Schedule deleted", type: "success" })
      onClose()
    },
    onError: (cause) =>
      showToast({ message: errorMessage(cause), type: "error" }),
  })
  return (
    <Dialog
      open={schedule !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete schedule?</DialogTitle>
          <DialogDescription>
            {schedule?.name} will stop running on every Relay. Existing run
            history is retained.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            Delete schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ScheduleState({
  state,
}: {
  state: "enabled" | "disabled" | "running"
}) {
  const label =
    state === "enabled"
      ? "Enabled"
      : state === "running"
        ? "Running"
        : "Disabled"
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[0.625rem] font-medium ${state === "enabled" ? "text-emerald-400" : state === "running" ? "text-amber-300" : "text-muted-foreground"}`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${state === "enabled" ? "bg-emerald-400" : state === "running" ? "animate-pulse bg-amber-400" : "bg-muted-foreground"}`}
      />
      <span>{label}</span>
    </span>
  )
}

function RunStatusDot({
  status,
}: {
  status: Schedule["runs"][number]["status"]
}) {
  const label = status.replaceAll("_", " ")
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[0.625rem] font-medium capitalize ${status === "succeeded" ? "text-emerald-400" : status === "failed" || status === "interrupted" ? "text-destructive" : status === "partial" || status === "running" ? "text-amber-300" : "text-muted-foreground"}`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${status === "succeeded" ? "bg-emerald-400" : status === "failed" || status === "interrupted" ? "bg-destructive" : status === "partial" || status === "running" ? `${status === "running" ? "animate-pulse " : ""}bg-amber-400` : "bg-muted-foreground"}`}
      />
      <span className="hidden sm:inline">{label}</span>
    </span>
  )
}

function RunResultIcon({
  status,
  className,
}: {
  status: string
  className?: string
}) {
  if (status === "succeeded") {
    return <CircleCheck className={`${className ?? ""} text-emerald-400`} />
  }
  if (status === "running") {
    return (
      <LoaderCircle
        className={`${className ?? ""} animate-spin text-amber-300`}
      />
    )
  }
  if (status === "partial") {
    return <CircleX className={`${className ?? ""} text-amber-300`} />
  }
  if (status === "noop" || status.startsWith("skipped")) {
    return (
      <CirclePause className={`${className ?? ""} text-muted-foreground`} />
    )
  }
  return <CircleX className={`${className ?? ""} text-destructive`} />
}

function TargetIcon({
  kind,
  className,
}: {
  kind: ScheduleTarget["kind"]
  className?: string
}) {
  const Icon =
    kind === "instance"
      ? Server
      : kind === "database"
        ? Database
        : HardDriveDownload
  return <Icon className={className} aria-hidden="true" />
}

function ActionIcon({
  type,
  className,
}: {
  type: ScheduleAction["type"]
  className?: string
}) {
  const Icon =
    type === "console_command"
      ? Code2
      : type === "backup"
        ? HardDriveDownload
        : Power
  return <Icon className={className} aria-hidden="true" />
}

function actionLabel(type: ScheduleAction["type"]) {
  if (type === "console_command") return "Console command"
  if (type === "backup") return "Trigger backup"
  return "Power action"
}

function actionAuditSummary(
  action: ScheduleAction | undefined,
  actionId: string
) {
  if (!action) return `Action ${actionId}`
  if (action.type === "console_command") return action.command
  if (action.type === "backup") return action.name
  return action.action
}

function runStatusLabel(status: string) {
  return status
    .replaceAll("_", " ")
    .replace(/^./u, (value) => value.toUpperCase())
}

function targetKey(target: Pick<ScheduleTarget, "id" | "kind" | "relayId">) {
  return `${target.relayId}:${target.kind}:${target.id}`
}

function canOperateSchedule(
  schedule: Pick<Schedule, "actions" | "targets">,
  options: ReadonlyMap<string, ScheduleOption>,
  permission: "canCreate" | "canExecute" | "canUpdate"
) {
  return schedule.targets.every((target) => {
    const option = options.get(targetKey(target))
    if (!option?.[permission]) return false
    const permittedActions = new Set(option.permittedActions)
    return schedule.actions.every(
      (action) =>
        !scheduleActionSupportsTarget(action, target) ||
        permittedActions.has(action.type)
    )
  })
}

function scheduleActionAllowed(
  type: ScheduleAction["type"],
  targets: ReadonlyArray<ScheduleOption>,
  permission: "canCreate" | "canUpdate"
) {
  const compatible = targets.filter((target) =>
    scheduleActionSupportsTarget({ type }, target)
  )
  return (
    compatible.length > 0 &&
    compatible.every(
      (target) => target[permission] && target.permittedActions.includes(type)
    )
  )
}

function moveAction(
  actions: Array<ScheduleAction>,
  index: number,
  direction: -1 | 1
) {
  const nextIndex = index + direction
  if (nextIndex < 0 || nextIndex >= actions.length) return actions
  const next = [...actions]
  const current = next[index]
  const other = next[nextIndex]
  if (!current || !other) return actions
  next[index] = other
  next[nextIndex] = current
  return next
}

function cronPreset(cron: string) {
  const presets: Partial<
    Record<string, "daily" | "hourly" | "monthly" | "weekly">
  > = {
    daily: "daily",
    hourly: "hourly",
    monthly: "monthly",
    weekly: "weekly",
    "0 * * * *": "hourly",
    "0 0 * * *": "daily",
    "0 0 * * 0": "weekly",
    "0 0 1 * *": "monthly",
  }
  return presets[cron] ?? "custom"
}

function cronAliasLabel(cron: string) {
  const preset = cronPreset(cron)
  return preset === "custom"
    ? null
    : `${preset[0]?.toUpperCase()}${preset.slice(1)}`
}

function scheduleInput(schedule: Schedule) {
  return {
    actions: schedule.actions,
    cron: schedule.cron,
    enabled: schedule.enabled,
    name: schedule.name,
    targets: schedule.targets,
    timezone: schedule.timezone,
  }
}

function scheduleRowKey(schedule: Schedule) {
  return schedule.id
}

function scheduleMatchesScope(
  schedule: Pick<Schedule, "targets">,
  scope: ServerPickerOption
) {
  return schedule.targets.some((target) =>
    scheduleTargetMatchesScope(target, scope)
  )
}

function scheduleTargetMatchesScope(
  target: ScheduleTarget,
  scope: ServerPickerOption
) {
  const scopeKind = scope.kind ?? "server"
  const kind = scopeKind === "server" ? "instance" : scopeKind
  return (
    target.kind === kind &&
    target.id === scope.id &&
    target.relayId === scope.relayId
  )
}

function scheduleSearchText(schedule: Schedule) {
  return [
    schedule.name,
    schedule.cron,
    schedule.timezone,
    ...schedule.actions.flatMap((action) => [
      actionLabel(action.type),
      action.type === "console_command"
        ? action.command
        : action.type === "backup"
          ? action.name
          : action.action,
    ]),
    ...schedule.targets.flatMap((target) => [
      target.name,
      target.kind,
      target.id,
    ]),
  ].join(" ")
}

function historyRowKey(run: ScheduleHistoryRun) {
  return `${run.relayId}:${run.id}`
}

function historySearchText(run: ScheduleHistoryRun) {
  return [
    run.scheduleName,
    run.status,
    run.relayId,
    ...run.targetRuns.flatMap((targetRun) => [
      targetRun.target.name,
      targetRun.target.kind,
      targetRun.status,
    ]),
  ].join(" ")
}

function durationLabel(durationMs: number) {
  const safeDuration = Math.max(0, durationMs)
  if (safeDuration < 1_000) return `${safeDuration} ms`
  if (safeDuration < 60_000) return `${(safeDuration / 1_000).toFixed(1)} s`
  const minutes = Math.floor(safeDuration / 60_000)
  const seconds = Math.round((safeDuration % 60_000) / 1_000)
  return `${minutes}m ${seconds}s`
}

function timestampLabel(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date)
}

function fullTimestampLabel(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone,
  }).format(date)
}

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

function scheduleNextRun(schedule: Schedule) {
  const times = schedule.deployments.flatMap((deployment) =>
    deployment.nextRunAt ? [new Date(deployment.nextRunAt)] : []
  )
  return (
    times.sort((left, right) => left.getTime() - right.getTime())[0] ?? null
  )
}

function scheduleLastRun(
  schedule: Schedule,
  scope: ServerPickerOption | null
): ScheduleRunWithRelay | null {
  let latest: ScheduleRunWithRelay | null = null
  for (const run of schedule.runs) {
    if (run.status === "running") continue
    if (
      scope &&
      !run.targetRuns.some((targetRun) =>
        scheduleTargetMatchesScope(targetRun.target, scope)
      )
    ) {
      continue
    }
    if (!latest || run.finishedAt > latest.finishedAt) latest = run
  }
  return latest
}

function scheduleStatus(
  schedule: Schedule
): "enabled" | "disabled" | "running" {
  if (schedule.runs.some((run) => run.status === "running")) return "running"
  return schedule.enabled ? "enabled" : "disabled"
}

function relativeTime(date: Date) {
  const difference = date.getTime() - Date.now()
  const minutes = Math.round(difference / 60_000)
  if (Math.abs(minutes) < 60) {
    return stripTrailingPeriod(relativeFormatter.format(minutes, "minute"))
  }
  const hours = Math.round(difference / 3_600_000)
  if (Math.abs(hours) < 48) {
    return stripTrailingPeriod(relativeFormatter.format(hours, "hour"))
  }
  return stripTrailingPeriod(
    relativeFormatter.format(Math.round(difference / 86_400_000), "day")
  )
}

function stripTrailingPeriod(value: string) {
  return value.endsWith(".") ? value.slice(0, -1) : value
}

function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "The schedule could not be saved"
}
