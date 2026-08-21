import * as React from "react"
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  Check,
  Code2,
  Database,
  HardDriveDownload,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Power,
  Search,
  Server,
  Trash2,
  X,
} from "lucide-react"

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

const relativeFormatter = new Intl.RelativeTimeFormat("en-US", {
  numeric: "auto",
  style: "short",
})

export const SchedulesPage = React.memo(function SchedulesPage() {
  const { data: schedules } = useSuspenseQuery(schedulesQueryOptions())
  const { data: options } = useSuspenseQuery(scheduleOptionsQueryOptions())
  const selectedScope = useScheduleScope()
  const [searchStore] = React.useState(createWorkspaceTableSearchStore)
  const [editor, setEditor] = React.useState<EditorMode | null>(null)
  const [deleting, setDeleting] = React.useState<Schedule | null>(null)
  const canCreate = options.some((option) => option.canCreate)
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

  return (
    <div className="mx-auto w-full max-w-[90rem] px-3 pb-10 sm:px-5">
      <section className="overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
        <ScheduleToolbar
          canCreate={canCreate}
          searchStore={searchStore}
          onCreate={() => setEditor({ kind: "create" })}
        />
        <ScheduleTable
          canCreate={canCreate}
          options={options}
          schedules={scopedSchedules}
          scopeActive={selectedScope !== null}
          searchStore={searchStore}
          onCreate={() => setEditor({ kind: "create" })}
          onDelete={openDelete}
          onEdit={openEdit}
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

const ScheduleTable = React.memo(function ScheduleTable({
  canCreate,
  options,
  schedules,
  scopeActive,
  searchStore,
  onCreate,
  onDelete,
  onEdit,
}: {
  canCreate: boolean
  options: ReadonlyArray<ScheduleOption>
  schedules: Array<Schedule>
  scopeActive: boolean
  searchStore: WorkspaceTableSearchStore
  onCreate: () => void
  onDelete: (schedule: Schedule) => void
  onEdit: (schedule: Schedule) => void
}) {
  const renderRow = React.useCallback(
    (schedule: Schedule) => (
      <ScheduleTableRow
        options={options}
        schedule={schedule}
        onDelete={() => onDelete(schedule)}
        onEdit={() => onEdit(schedule)}
      />
    ),
    [onDelete, onEdit, options]
  )
  const renderEmpty = React.useCallback(
    (searchActive: boolean) => (
      <EmptyScheduleTable
        canCreate={canCreate}
        scopeActive={scopeActive}
        searchActive={searchActive}
        onCreate={onCreate}
      />
    ),
    [canCreate, onCreate, scopeActive]
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
      <WorkspaceTableHeading className="w-auto sm:w-[27%]">
        Schedule
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[24%] md:table-cell">
        Timing
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[22%] lg:table-cell">
        Next run
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[12%] xl:table-cell">
        Targets
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-36 px-1 text-right sm:w-40 sm:px-3">
        Actions
      </WorkspaceTableHeading>
    </WorkspaceTableHead>
  )
})

const ScheduleTableRow = React.memo(function ScheduleTableRow({
  options,
  schedule,
  onDelete,
  onEdit,
}: {
  options: ReadonlyArray<ScheduleOption>
  schedule: Schedule
  onDelete: () => void
  onEdit: () => void
}) {
  const queryClient = useQueryClient()
  const optionMap = new Map(
    options.map((option) => [targetKey(option), option])
  )
  const canEdit = canOperateSchedule(schedule, optionMap, "canUpdate")
  const canDelete = schedule.targets.every(
    (target) => optionMap.get(targetKey(target))?.canDelete
  )
  const canRun = canOperateSchedule(schedule, optionMap, "canExecute")
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
  const nextRun = scheduleNextRun(schedule)

  return (
    <tr className="group transition-colors hover:bg-accent/25">
      <WorkspaceTableCell className="px-2 sm:px-3">
        <ScheduleState state={deploymentState(schedule)} />
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground">
            {schedule.name}
          </p>
          <p className="truncate font-mono text-[0.5rem] text-muted-foreground">
            {schedule.actions.length} action
            {schedule.actions.length === 1 ? "" : "s"}
            {!schedule.enabled ? " · paused" : ""}
          </p>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden md:table-cell">
        <div className="min-w-0">
          <p className="truncate text-[0.625rem] font-medium text-foreground">
            {cronLabel(schedule.cron)}
          </p>
          <p className="truncate font-mono text-[0.5rem] text-muted-foreground">
            {schedule.cron} · {schedule.timezone}
          </p>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden lg:table-cell">
        {nextRun ? (
          <div className="min-w-0">
            <p className="truncate text-[0.625rem] text-foreground">
              {timestampLabel(nextRun, schedule.timezone)}
            </p>
            <p className="truncate text-[0.5rem] text-muted-foreground">
              {relativeTime(nextRun)}
            </p>
          </div>
        ) : (
          <span className="text-[0.625rem] text-muted-foreground">
            Not scheduled
          </span>
        )}
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden xl:table-cell">
        <div className="min-w-0">
          <p className="text-[0.625rem] text-foreground">
            {schedule.targets.length} target
            {schedule.targets.length === 1 ? "" : "s"}
          </p>
          <p className="truncate text-[0.5rem] text-muted-foreground">
            {relayCountLabel(schedule)}
          </p>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="px-1 sm:px-3">
        <div className="flex items-center justify-end gap-1">
          {canRun ? (
            <ScheduleActionButton
              disabled={runMutation.isPending}
              icon={runMutation.isPending ? LoaderCircle : Play}
              label={`Run ${schedule.name} now`}
              spinning={runMutation.isPending}
              tooltip="Run now"
              onClick={() => runMutation.mutate()}
            />
          ) : null}
          {canEdit ? (
            <ScheduleActionButton
              icon={Pencil}
              label={`Edit ${schedule.name}`}
              tooltip="Edit"
              onClick={onEdit}
            />
          ) : null}
          {canDelete ? (
            <ScheduleActionButton
              destructive
              icon={Trash2}
              label={`Delete ${schedule.name}`}
              tooltip="Delete"
              onClick={onDelete}
            />
          ) : null}
        </div>
      </WorkspaceTableCell>
    </tr>
  )
})

function ScheduleActionButton({
  destructive = false,
  disabled = false,
  icon: Icon,
  label,
  spinning = false,
  tooltip,
  onClick,
}: {
  destructive?: boolean
  disabled?: boolean
  icon: typeof Play
  label: string
  spinning?: boolean
  tooltip: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          className={
            destructive
              ? "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              : "text-muted-foreground"
          }
          disabled={disabled}
          onClick={onClick}
        >
          <Icon className={spinning ? "animate-spin" : undefined} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {tooltip}
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
  const { data: schedules } = useSuspenseQuery(schedulesQueryOptions())
  const selectedScope = useScheduleScope()
  const [searchStore] = React.useState(createWorkspaceTableSearchStore)
  const runs = React.useMemo(
    () => scheduleHistoryRuns(schedules, selectedScope),
    [schedules, selectedScope]
  )

  return (
    <div className="mx-auto w-full max-w-[90rem] px-3 pb-10 sm:px-5">
      <section className="overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
        <HistoryToolbar searchStore={searchStore} runCount={runs.length} />
        <ScheduleHistoryTable
          runs={runs}
          scopeActive={selectedScope !== null}
          searchStore={searchStore}
        />
      </section>
    </div>
  )
})

type ScheduleHistoryRun = Schedule["runs"][number] & {
  scheduleName: string
  timezone: string
}

function scheduleHistoryRuns(
  schedules: ReadonlyArray<Schedule>,
  scope: ServerPickerOption | null
): Array<ScheduleHistoryRun> {
  const runs: Array<ScheduleHistoryRun> = []
  for (const schedule of schedules) {
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
        scheduleName: schedule.name,
        timezone: schedule.timezone,
      })
    }
  }
  return runs.sort((left, right) => right.scheduledAt - left.scheduledAt)
}

function HistoryToolbar({
  runCount,
  searchStore,
}: {
  runCount: number
  searchStore: WorkspaceTableSearchStore
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  useWorkspaceTableSearchInput(inputRef, searchStore)
  return (
    <div className="flex min-w-0 items-center gap-3 border-b bg-background/25 p-3">
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
      <Badge variant="outline" className="font-mono text-[0.625rem]">
        {runCount} run{runCount === 1 ? "" : "s"}
      </Badge>
    </div>
  )
}

const ScheduleHistoryTable = React.memo(function ScheduleHistoryTable({
  runs,
  scopeActive,
  searchStore,
}: {
  runs: Array<ScheduleHistoryRun>
  scopeActive: boolean
  searchStore: WorkspaceTableSearchStore
}) {
  const renderRow = React.useCallback(
    (run: ScheduleHistoryRun) => <ScheduleHistoryRow run={run} />,
    []
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
}: {
  run: ScheduleHistoryRun
}) {
  return (
    <tr className="transition-colors hover:bg-accent/25">
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
  const selectedOptions = options.filter((option) =>
    selectedTargets.has(targetKey(option))
  )
  const permissionKey = mode.kind === "create" ? "canCreate" : "canUpdate"
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

  const actionAllowed = (type: ScheduleAction["type"]) => {
    const compatible = selectedOptions.filter((target) =>
      scheduleActionSupportsTarget({ type }, target)
    )
    return (
      compatible.length > 0 &&
      compatible.every(
        (target) =>
          target[permissionKey] && target.permittedActions.includes(type)
      )
    )
  }

  const addAction = (type: ScheduleAction["type"]) => {
    if (!actionAllowed(type)) return
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
  }

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

          <div>
            <div className="flex items-end justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold">Targets</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Select every server, database, or Relay this schedule applies
                  to.
                </p>
              </div>
              <span className="font-mono text-[0.625rem] text-muted-foreground">
                {selectedOptions.length} selected
              </span>
            </div>
            <div className="mt-3 grid max-h-52 gap-2 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2">
              {options.map((option) => {
                const key = targetKey(option)
                const checked = selectedTargets.has(key)
                const disabled = !option[permissionKey]
                return (
                  <label
                    key={key}
                    className={`flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-xs ${disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:bg-accent/40"}`}
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 accent-primary"
                      checked={checked}
                      disabled={disabled}
                      onChange={(event) => {
                        setSelectedTargets((current) => {
                          const next = new Set(current)
                          if (event.target.checked) next.add(key)
                          else next.delete(key)
                          return next
                        })
                      }}
                    />
                    <TargetIcon
                      kind={option.kind}
                      className="size-3.5 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {option.name}
                    </span>
                    <span className="font-mono text-[0.5625rem] text-muted-foreground">
                      {option.kind}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>

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
                  disabled={!actionAllowed("console_command")}
                  onClick={() => addAction("console_command")}
                />
                <AddActionButton
                  icon={HardDriveDownload}
                  label="Backup"
                  disabled={!actionAllowed("backup")}
                  onClick={() => addAction("backup")}
                />
                <AddActionButton
                  icon={Power}
                  label="Power"
                  disabled={!actionAllowed("power")}
                  onClick={() => addAction("power")}
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
                    onChange={(next) =>
                      setActions((current) =>
                        current.map((item) =>
                          item.id === next.id ? next : item
                        )
                      )
                    }
                    onMove={(direction) =>
                      setActions((current) =>
                        moveAction(current, index, direction)
                      )
                    }
                    onRemove={() =>
                      setActions((current) =>
                        current.filter((item) => item.id !== action.id)
                      )
                    }
                  />
                ))}
              </div>
            )}
          </div>

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

function AddActionButton({
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
}

function ActionEditor({
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
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
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
            onClick={() => onMove(-1)}
            aria-label="Move action up"
          >
            <ArrowUp className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            aria-label="Move action down"
          >
            <ArrowDown className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onRemove}
            aria-label="Remove action"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

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

function ScheduleState({ state }: { state: "applied" | "error" | "pending" }) {
  const label =
    state === "applied" ? "Deployed" : state === "error" ? "Error" : "Pending"
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[0.625rem] font-medium ${state === "applied" ? "text-emerald-400" : state === "error" ? "text-destructive" : "text-amber-300"}`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${state === "applied" ? "bg-emerald-400" : state === "error" ? "bg-destructive" : "bg-amber-400"}`}
      />
      <span className="hidden sm:inline">{label}</span>
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
      className={`inline-flex items-center gap-1.5 text-[0.625rem] font-medium capitalize ${status === "succeeded" ? "text-emerald-400" : status === "failed" || status === "interrupted" ? "text-destructive" : status === "partial" ? "text-amber-300" : "text-muted-foreground"}`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${status === "succeeded" ? "bg-emerald-400" : status === "failed" || status === "interrupted" ? "bg-destructive" : status === "partial" ? "bg-amber-400" : "bg-muted-foreground"}`}
      />
      <span className="hidden sm:inline">{label}</span>
    </span>
  )
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

function targetKey(target: Pick<ScheduleTarget, "id" | "kind" | "relayId">) {
  return `${target.relayId}:${target.kind}:${target.id}`
}

function canOperateSchedule(
  schedule: Pick<Schedule, "actions" | "targets">,
  options: ReadonlyMap<string, ScheduleOption>,
  permission: "canExecute" | "canUpdate"
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

function cronLabel(cron: string) {
  const preset = cronPreset(cron)
  return preset === "custom"
    ? "Custom schedule"
    : `${preset[0]?.toUpperCase()}${preset.slice(1)}`
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

function relayCountLabel(schedule: Schedule) {
  const count = new Set(schedule.targets.map((target) => target.relayId)).size
  return `${count} Relay${count === 1 ? "" : "s"}`
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

function deploymentState(schedule: Schedule): "applied" | "error" | "pending" {
  if (schedule.deployments.some((deployment) => deployment.status === "error"))
    return "error"
  if (
    schedule.deployments.length === 0 ||
    schedule.deployments.some(
      (deployment) =>
        deployment.status !== "applied" ||
        deployment.acknowledgedRevision !== schedule.revision
    )
  ) {
    return "pending"
  }
  return "applied"
}

function relativeTime(date: Date) {
  const difference = date.getTime() - Date.now()
  const minutes = Math.round(difference / 60_000)
  if (Math.abs(minutes) < 60) return relativeFormatter.format(minutes, "minute")
  const hours = Math.round(difference / 3_600_000)
  if (Math.abs(hours) < 48) return relativeFormatter.format(hours, "hour")
  return relativeFormatter.format(Math.round(difference / 86_400_000), "day")
}

function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "The schedule could not be saved"
}
