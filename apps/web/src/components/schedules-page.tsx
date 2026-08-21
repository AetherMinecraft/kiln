import * as React from "react"
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  Check,
  ChevronRight,
  Clock3,
  Code2,
  Database,
  HardDriveDownload,
  History,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Power,
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

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
  style: "short",
})

export const SchedulesPage = React.memo(function SchedulesPage() {
  const { data: schedules } = useSuspenseQuery(schedulesQueryOptions())
  const { data: options } = useSuspenseQuery(scheduleOptionsQueryOptions())
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [editor, setEditor] = React.useState<EditorMode | null>(null)
  const [deleting, setDeleting] = React.useState<Schedule | null>(null)
  const selected =
    schedules.find((schedule) => schedule.id === selectedId) ??
    schedules[0] ??
    null
  const canCreate = options.some((option) => option.canCreate)

  React.useEffect(() => {
    if (
      selectedId &&
      !schedules.some((schedule) => schedule.id === selectedId)
    ) {
      setSelectedId(null)
    }
  }, [schedules, selectedId])

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[96rem] flex-col px-3 pb-8 sm:px-5">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card/45">
        <ScheduleToolbar
          canCreate={canCreate}
          scheduleCount={schedules.length}
          onCreate={() => setEditor({ kind: "create" })}
        />

        {schedules.length === 0 ? (
          <ScheduleEmptyState
            canCreate={canCreate}
            onCreate={() => setEditor({ kind: "create" })}
          />
        ) : (
          <div className="grid min-h-0 flex-1 lg:grid-cols-[20rem_minmax(0,1fr)]">
            <ScheduleList
              schedules={schedules}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
            />
            {selected ? (
              <ScheduleDetail
                key={selected.id}
                options={options}
                schedule={selected}
                onDelete={() => setDeleting(selected)}
                onEdit={() => setEditor({ kind: "edit", schedule: selected })}
              />
            ) : null}
          </div>
        )}
      </section>

      {editor ? (
        <ScheduleEditorDialog
          mode={editor}
          options={options}
          onClose={() => setEditor(null)}
          onSaved={(scheduleId) => {
            setSelectedId(scheduleId)
            setEditor(null)
          }}
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
  scheduleCount,
  onCreate,
}: {
  canCreate: boolean
  scheduleCount: number
  onCreate: () => void
}) {
  return (
    <div className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <CalendarClock className="size-4 text-primary" aria-hidden="true" />
          <h2 className="font-heading text-base font-semibold tracking-[-0.025em]">
            Schedules
          </h2>
          <Badge variant="outline" className="font-mono text-[0.625rem]">
            {scheduleCount}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Relay-owned automation that keeps running without Hearth.
        </p>
      </div>
      {canCreate ? (
        <Button size="sm" onClick={onCreate}>
          <Plus className="size-3.5" />
          Create schedule
        </Button>
      ) : null}
    </div>
  )
})

function ScheduleEmptyState({
  canCreate,
  onCreate,
}: {
  canCreate: boolean
  onCreate: () => void
}) {
  return (
    <div className="grid min-h-[24rem] flex-1 place-items-center p-8 text-center">
      <div className="max-w-sm">
        <div className="mx-auto grid size-11 place-items-center rounded-lg border bg-background/70">
          <Clock3 className="size-5 text-primary" />
        </div>
        <h3 className="mt-4 font-heading text-lg font-semibold">
          No schedules yet
        </h3>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          Chain commands, backups, and power actions across one or many targets.
          The Relay owns the clock and execution.
        </p>
        {canCreate ? (
          <Button className="mt-5" onClick={onCreate}>
            <Plus className="size-4" />
            Create your first schedule
          </Button>
        ) : (
          <p className="mt-4 text-xs text-muted-foreground">
            You have read access, but not permission to create schedules.
          </p>
        )}
      </div>
    </div>
  )
}

const ScheduleList = React.memo(function ScheduleList({
  schedules,
  selectedId,
  onSelect,
}: {
  schedules: ReadonlyArray<Schedule>
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div className="min-h-0 overflow-y-auto border-b bg-background/25 p-2 lg:border-r lg:border-b-0">
      {schedules.map((schedule) => {
        const nextRun = scheduleNextRun(schedule)
        const state = deploymentState(schedule)
        return (
          <button
            key={schedule.id}
            type="button"
            aria-pressed={schedule.id === selectedId}
            className="group mb-1 flex w-full items-start gap-3 rounded-lg border border-transparent px-3 py-3 text-left transition-colors outline-none hover:bg-accent/50 focus-visible:border-ring data-[active=true]:border-border data-[active=true]:bg-background/80"
            data-active={schedule.id === selectedId}
            onClick={() => onSelect(schedule.id)}
          >
            <span
              className={`mt-1 size-2 shrink-0 rounded-full ${state === "error" ? "bg-destructive" : state === "pending" ? "bg-amber-400" : "bg-emerald-400"}`}
              aria-label={`Deployment ${state}`}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                {schedule.name}
              </span>
              <span className="mt-1 block truncate font-mono text-[0.625rem] text-muted-foreground">
                {schedule.cron} · {schedule.timezone}
              </span>
              <span className="mt-1.5 block text-[0.6875rem] text-muted-foreground">
                {nextRun ? `Next ${relativeTime(nextRun)}` : "No next run"}
              </span>
            </span>
            <ChevronRight className="mt-1 size-3.5 shrink-0 text-muted-foreground/50 group-data-[active=true]:text-primary" />
          </button>
        )
      })}
    </div>
  )
})

const ScheduleDetail = React.memo(function ScheduleDetail({
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
  const state = deploymentState(schedule)

  return (
    <div className="min-h-0 overflow-y-auto">
      <div className="border-b px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-heading text-xl font-semibold tracking-[-0.035em]">
                {schedule.name}
              </h2>
              <ScheduleStateBadge state={state} />
              {!schedule.enabled ? (
                <Badge variant="outline">Paused</Badge>
              ) : null}
            </div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {schedule.cron} · {schedule.timezone}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canRun ? (
              <Button
                variant="outline"
                size="sm"
                disabled={runMutation.isPending}
                onClick={() => runMutation.mutate()}
              >
                {runMutation.isPending ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
                Run now
              </Button>
            ) : null}
            {canEdit ? (
              <Button variant="outline" size="sm" onClick={onEdit}>
                <Pencil className="size-3.5" />
                Edit
              </Button>
            ) : null}
            {canDelete ? (
              <Button
                variant="outline"
                size="icon-sm"
                onClick={onDelete}
                aria-label="Delete schedule"
              >
                <Trash2 className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <SummaryMetric
            label="Next run"
            value={
              nextRun ? timestampFormatter.format(nextRun) : "Not scheduled"
            }
            detail={nextRun ? relativeTime(nextRun) : "Waiting for a Relay"}
          />
          <SummaryMetric
            label="Targets"
            value={String(schedule.targets.length)}
            detail={`${new Set(schedule.targets.map((target) => target.relayId)).size} Relay${new Set(schedule.targets.map((target) => target.relayId)).size === 1 ? "" : "s"}`}
          />
          <SummaryMetric
            label="Revision"
            value={`r${schedule.revision}`}
            detail={`${schedule.deployments.filter((item) => item.status === "applied").length}/${schedule.deployments.length} acknowledged`}
          />
        </div>
      </div>

      <div className="space-y-7 px-4 py-6 sm:px-6">
        <section>
          <SectionHeading icon={Play} title="Ordered actions" />
          <div className="relative mt-3 space-y-2 before:absolute before:top-5 before:bottom-5 before:left-[1.15rem] before:w-px before:bg-border">
            {schedule.actions.map((action, index) => (
              <ActionSummary key={action.id} action={action} index={index} />
            ))}
          </div>
        </section>

        <section>
          <SectionHeading icon={Server} title="Targets" />
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {schedule.targets.map((target) => (
              <div
                key={targetKey(target)}
                className="flex items-center gap-2.5 rounded-lg border bg-background/40 px-3 py-2.5"
              >
                <TargetIcon
                  kind={target.kind}
                  className="size-4 text-muted-foreground"
                />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">
                    {target.name}
                  </span>
                  <span className="block truncate font-mono text-[0.5625rem] text-muted-foreground">
                    {target.kind}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionHeading icon={History} title="Run history" />
          {schedule.runs.length === 0 ? (
            <div className="mt-3 rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">
              No runs have been reported yet.
            </div>
          ) : (
            <div className="mt-3 divide-y rounded-lg border bg-background/30">
              {schedule.runs.slice(0, 50).map((run) => (
                <details
                  key={`${run.relayId}:${run.id}`}
                  className="group px-3 py-3"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-3 outline-none">
                    <RunStatusDot status={run.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium capitalize">
                        {run.status.replaceAll("_", " ")}
                      </span>
                      <span className="block text-[0.625rem] text-muted-foreground">
                        {timestampFormatter.format(new Date(run.scheduledAt))}
                      </span>
                    </span>
                    <span className="font-mono text-[0.5625rem] text-muted-foreground">
                      {run.targetRuns.length} targets
                    </span>
                    <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
                  </summary>
                  <div className="mt-3 space-y-2 border-t pt-3">
                    {run.targetRuns.map((targetRun) => (
                      <div
                        key={targetRun.id}
                        className="rounded-md bg-muted/30 px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-3 text-xs">
                          <span className="font-medium">
                            {targetRun.target.name}
                          </span>
                          <span className="text-muted-foreground capitalize">
                            {targetRun.status.replaceAll("_", " ")}
                          </span>
                        </div>
                        {targetRun.attempts.length > 0 ? (
                          <div className="mt-2 space-y-1">
                            {targetRun.attempts.map((attempt) => (
                              <div
                                key={attempt.id}
                                className="flex items-center justify-between gap-3 font-mono text-[0.5625rem] text-muted-foreground"
                              >
                                <span>{actionLabel(attempt.actionType)}</span>
                                <span>
                                  {attempt.status.replaceAll("_", " ")}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
})

function SummaryMetric({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="rounded-lg border bg-background/35 px-3 py-3">
      <p className="font-mono text-[0.5625rem] tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </p>
      <p className="mt-1 truncate text-sm font-semibold">{value}</p>
      <p className="mt-0.5 truncate text-[0.625rem] text-muted-foreground">
        {detail}
      </p>
    </div>
  )
}

function SectionHeading({
  icon: Icon,
  title,
}: {
  icon: typeof Play
  title: string
}) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold">
      <Icon className="size-3.5 text-primary" />
      {title}
    </h3>
  )
}

function ActionSummary({
  action,
  index,
}: {
  action: ScheduleAction
  index: number
}) {
  return (
    <div className="relative flex items-center gap-3 rounded-lg border bg-background/45 px-3 py-3 pl-11">
      <span className="absolute left-2.5 z-10 grid size-5 place-items-center rounded-full border bg-background font-mono text-[0.5625rem] text-muted-foreground">
        {index + 1}
      </span>
      <ActionIcon type={action.type} className="size-4 shrink-0 text-primary" />
      <span className="min-w-0">
        <span className="block text-xs font-semibold">
          {actionLabel(action.type)}
        </span>
        <span className="block truncate font-mono text-[0.625rem] text-muted-foreground">
          {actionDescription(action)}
        </span>
      </span>
    </div>
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

function ScheduleStateBadge({
  state,
}: {
  state: "applied" | "error" | "pending"
}) {
  return state === "applied" ? (
    <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-400">
      Deployed
    </Badge>
  ) : state === "error" ? (
    <Badge className="border-destructive/25 bg-destructive/10 text-destructive">
      Deployment error
    </Badge>
  ) : (
    <Badge className="border-amber-400/25 bg-amber-400/10 text-amber-300">
      Pending
    </Badge>
  )
}

function RunStatusDot({
  status,
}: {
  status: Schedule["runs"][number]["status"]
}) {
  return (
    <span
      className={`size-2 shrink-0 rounded-full ${status === "succeeded" ? "bg-emerald-400" : status === "failed" || status === "interrupted" ? "bg-destructive" : status === "partial" ? "bg-amber-400" : "bg-muted-foreground"}`}
      aria-hidden="true"
    />
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

function actionDescription(action: ScheduleAction) {
  if (action.type === "console_command") return action.command
  if (action.type === "backup") return `${action.name} · Local Relay storage`
  return action.action
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
